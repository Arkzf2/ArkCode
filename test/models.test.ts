import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { parseCli } from "../src/app/args.js";
import { configuredModelIds, configureConnection, createModelRuntime, loadConfig, removeConfiguredModel, saveConfig } from "../src/config/settings.js";

test("xhigh and max are accepted by CLI and saved settings", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-thinking-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const thinking of ["xhigh", "max"] as const) {
    assert.equal(parseCli(["--thinking", thinking]).thinking, thinking);
    saveConfig(home, { ...loadConfig(home), thinking });
    assert.equal(loadConfig(home).thinking, thinking);
  }
  assert.throws(() => parseCli(["--thinking", "ultra"]));
});

test("existing custom reasoning models expose all levels while preserving explicit mappings and JSONC", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-thinking-existing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "models.json");
  await writeFile(path, `{
    // Keep this comment.
    "providers": { "custom": { "baseUrl": "http://localhost:1234/v1", "api": "openai-completions", "apiKey": "dummy",
      "models": [
        { "id": "deepseek-flash", "reasoning": true },
        { "id": "other", "reasoning": true, "thinkingLevelMap": { "xhigh": null, "max": "custom-max" } },
        { "id": "plain", "reasoning": false }
      ]
    } }
  }`);
  const runtime = await createModelRuntime(home);
  const flash = runtime.getModel("custom", "deepseek-flash");
  assert.ok(flash);
  assert.deepEqual(getSupportedThinkingLevels(flash), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(runtime.getModel("custom", "other")?.thinkingLevelMap?.xhigh, null);
  assert.equal(runtime.getModel("custom", "other")?.thinkingLevelMap?.max, "custom-max");
  const plain = runtime.getModel("custom", "plain");
  assert.ok(plain);
  assert.deepEqual(getSupportedThinkingLevels(plain), ["off"]);
  assert.match(await readFile(path, "utf8"), /Keep this comment/);
  const upgraded = await readFile(path, "utf8");
  await createModelRuntime(home);
  assert.equal(await readFile(path, "utf8"), upgraded);
});

test("custom DeepSeek transports send the documented thinking mappings and sampling overrides", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-thinking-wire-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":{"message":"fixture rejection","type":"authentication_error"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtime = await createModelRuntime(home);
  const apis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
  for (const api of apis) {
    const model = await configureConnection(home, runtime, { kind: "custom", provider: `custom-${api}`, model: "deepseek-flash", name: "Flash",
      baseUrl: `http://127.0.0.1:${address.port}${api === "anthropic-messages" ? "" : "/v1"}`, api,
      input: "text", reasoning: true, contextWindow: 128000, maxTokens: 4096 }, "fixture-key");
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const efforts = ["low", "low", "high", "high", "high", "max"];
    for (const [index, reasoning] of levels.entries()) {
      await runtime.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { reasoning, maxRetries: 0 });
      const body = requests.at(-1);
      assert.ok(body);
      if (api === "openai-completions") {
        assert.deepEqual(body.thinking, { type: "enabled" });
        assert.equal(body.reasoning_effort, efforts[index]);
      } else if (api === "openai-responses") assert.equal(z.object({ effort: z.string() }).parse(body.reasoning).effort, efforts[index]);
      else {
        assert.equal(z.object({ effort: z.string() }).parse(body.output_config).effort, efforts[index]);
        assert.deepEqual(body.thinking, { type: "enabled" });
      }
      assert.equal(body.temperature, undefined);
      assert.equal(body.top_p, undefined);
    }
  }
  assert.equal(requests.length, 18);
  const path = join(home, "models.json");
  const document = JSON.parse(await readFile(path, "utf8"));
  document.providers["custom-openai-completions"].models[0].samplingParams = { temperature: 0.3, top_p: 0.96, presence_penalty: 0.1 };
  document.providers["custom-openai-completions"].models[0].samplingParamsByThinkingLevel = { max: { temperature: 0.2, top_p: 0.99 } };
  await writeFile(path, JSON.stringify(document));
  await runtime.refresh({ allowNetwork: false });
  const configured = runtime.getModel("custom-openai-completions", "deepseek-flash");
  assert.ok(configured);
  for (const reasoning of [undefined, "high", "max"] as const) {
    await runtime.completeSimple(configured, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { reasoning, maxRetries: 0 });
    const body = requests.at(-1);
    assert.ok(body);
    assert.deepEqual(body.thinking, { type: reasoning ? "enabled" : "disabled" });
    assert.equal(body.temperature, reasoning === "max" ? 0.2 : 0.3);
    assert.equal(body.top_p, reasoning === "max" ? 0.99 : 0.96);
    assert.equal(body.presence_penalty, 0.1);
  }
});

test("deleting configured models preserves siblings, JSONC and credentials and clears only their saved default", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-model-delete-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "models.json");
  await writeFile(path, `{
    // Keep provider settings and comments.
    "providers": {
      "custom": { "baseUrl": "http://localhost:1234/v1", "api": "openai-completions", "apiKey": "fixture-key",
        "models": [{ "id": "first" }, { "id": "second", "samplingParams": { "top_p": 0.99 } }]
      },
      "other": { "baseUrl": "http://localhost:5678/v1", "api": "openai-responses", "apiKey": "another-key", "models": [{ "id": "other" }] }
    }
  }`);
  const runtime = await createModelRuntime(home);
  saveConfig(home, { ...loadConfig(home), provider: "custom", model: "second" });
  const authPath = join(home, "auth.json");
  const credentials = await readFile(authPath, "utf8");
  assert.ok(configuredModelIds(home).has("custom/first"));
  await removeConfiguredModel(home, runtime, "custom/first");
  assert.equal(runtime.getModel("custom", "first"), undefined);
  assert.ok(runtime.getModel("custom", "second"));
  assert.equal(loadConfig(home).model, "second");
  const source = await readFile(path, "utf8");
  assert.match(source, /Keep provider settings and comments/);
  assert.match(source, /"top_p": 0.99/);
  assert.match(source, /another-key/);
  await assert.rejects(removeConfiguredModel(home, runtime, "openai/gpt-4.1"), /catalog models cannot be deleted/);
  await assert.rejects(removeConfiguredModel(home, runtime, "custom/first"), /cannot be deleted/);
  assert.equal(await readFile(path, "utf8"), source);
  await removeConfiguredModel(home, runtime, "custom/second");
  assert.equal(runtime.getModel("custom", "second"), undefined);
  assert.equal(loadConfig(home).provider, undefined);
  assert.equal(loadConfig(home).model, undefined);
  assert.equal(loadConfig(home).thinking, "medium");
  assert.ok(runtime.getModel("other", "other"));
  assert.match(await readFile(path, "utf8"), /fixture-key/);
  assert.equal(await readFile(authPath, "utf8"), credentials);
});

test("failed model reload rolls deletion back and keeps the saved default", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-model-delete-rollback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "models.json");
  const document = { providers: { custom: { baseUrl: "http://localhost:1234/v1", api: "openai-completions", apiKey: "fixture-key",
    models: [{ id: "first", input: ["text"] }, { id: "second", input: ["text"] }] } } };
  await writeFile(path, JSON.stringify(document));
  const runtime = await createModelRuntime(home);
  saveConfig(home, { ...loadConfig(home), provider: "custom", model: "first" });
  const second = document.providers.custom.models[1];
  assert.ok(second);
  second.input = ["invalid-input"];
  const source = JSON.stringify(document);
  await writeFile(path, source);
  await assert.rejects(removeConfiguredModel(home, runtime, "custom/first"));
  assert.equal(await readFile(path, "utf8"), source);
  assert.equal(loadConfig(home).model, "first");
});
