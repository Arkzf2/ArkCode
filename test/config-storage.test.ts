import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, appendFile, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { configureConnection, createModelRuntime, createResources, loadConfig, saveConfig, selectModel } from "../src/config/settings.js";
import { inspectSession, listArkSessions, readRunMarker, recoverRunMarker, WorkspaceLease, writeRunMarker } from "../src/session/storage.js";
import { parseCli } from "../src/app/args.js";

test("settings persist defaults and reject unknown permission values", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-config-"));
  try {
    const defaults = loadConfig(home);
    assert.equal(defaults.permission, "always-ask");
    assert.deepEqual(defaults.trustedWorkspaces, []);
    saveConfig(home, { ...defaults, permission: "ask-when-needed" });
    assert.equal(loadConfig(home).permission, "ask-when-needed");
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "ask", theme: "light", statusline: "expanded" }));
    const migrated = loadConfig(home);
    assert.deepEqual(migrated, { permission: "always-ask", thinking: "medium", toolMode: "codemode", trustedWorkspaces: [], projectDocMaxBytes: 32 * 1024 });
    saveConfig(home, migrated);
    assert.deepEqual(JSON.parse(await readFile(join(home, "settings.json"), "utf8")), migrated);
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "ask", unexpected: true }));
    assert.throws(() => loadConfig(home), /Cannot load ArkCode settings/);
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "unsafe" }));
    assert.throws(() => loadConfig(home), /Cannot load ArkCode settings/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("permission migration maps legacy approval aliases but never silently upgrades Read Only", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-permissions-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [legacy, current] of [["ask", "always-ask"], ["full-access", "never-ask"]]) {
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: legacy }));
    assert.equal(loadConfig(home).permission, current);
    assert.equal(parseCli(["--permissions", legacy ?? ""]).permission, current);
  }
  for (const permission of ["always-ask", "ask-when-needed", "never-ask"]) assert.equal(parseCli(["--permissions", permission]).permission, permission);
  assert.equal(parseCli(["--full-access"]).permission, "never-ask");
  await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "read-only" }));
  assert.throws(() => loadConfig(home), /Read Only has been removed/);
  assert.throws(() => parseCli(["--read-only"]), /Read Only has been removed/);
  assert.throws(() => parseCli(["--permissions", "read-only"]), /Read Only has been removed/);
  assert.throws(() => parseCli(["--sandbox", "none"]), /Unknown option/);
});

test("resources leave instructions out of the system prompt and never discover extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-resources-"));
  const cwd = join(root, "nested");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  try {
    await writeFile(join(root, "AGENTS.md"), "Use focused edits.");
    await writeFile(join(cwd, "AGENTS.md"), "x".repeat(70 * 1024));
    await writeFile(join(cwd, ".pi", "extensions", "bad.ts"), "throw new Error('must not execute');");
    const resources = createResources();
    assert.deepEqual(resources.getAgentsFiles().agentsFiles, []);
    await resources.reload();
    assert.deepEqual(resources.getAgentsFiles().agentsFiles, []);
    assert.ok(!resources.getSystemPrompt()?.includes("Use focused edits."));
    assert.deepEqual(resources.getExtensions().extensions, []);
    assert.deepEqual(resources.getSkills().skills, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("different config homes and path aliases share the same workspace writer lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-lock-"));
  const cwd = join(root, "workspace");
  const alias = join(root, "alias");
  await mkdir(cwd);
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const writer = await WorkspaceLease.acquire(cwd, join(root, "home-a"));
  try {
    assert.equal(writer.viewer, false);
    const viewer = await WorkspaceLease.acquire(alias, join(root, "home-b"));
    assert.equal(viewer.viewer, true);
    await viewer.release();
    const stillViewer = await WorkspaceLease.acquire(cwd, join(root, "home-c"));
    assert.equal(stillViewer.viewer, true);
    await writer.release();
    const successor = await WorkspaceLease.acquire(alias, root);
    assert.equal(successor.viewer, false);
    await successor.release();
  } finally {
    await writer.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed real process releases ownership by stale lease recovery and does not replay runs", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-crash-"));
  const moduleUrl = new URL("../src/session/storage.ts", import.meta.url).href;
  const script = `const { WorkspaceLease } = await import(${JSON.stringify(moduleUrl)}); await WorkspaceLease.acquire(${JSON.stringify(root)}, ${JSON.stringify(root)}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const output = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(([code]) => {
      throw new Error(`Lease fixture exited before becoming ready: ${String(code)}`);
    })]);
    assert.match(String(output[0]), /ready/);
    const viewer = await WorkspaceLease.acquire(root, root);
    assert.equal(viewer.viewer, true);
    assert.ok(child.pid);
    const pid = child.pid;
    await writeRunMarker(root, "session-one", { status: "active", runId: "run-one", startedAt: 123, pid });
    assert.equal((await recoverRunMarker(root, "session-one"))?.status, "active");
    const exited = once(child, "exit");
    child.kill();
    await exited;
    const canonical = await realpath(root);
    const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const recoveryPath = join(tmpdir(), "arkcode-workspace-locks", `${createHash("sha256").update(identity).digest("hex")}.json.recovery`);
    await writeFile(recoveryPath, "", { flag: "wx" });
    try {
      const blocked = await WorkspaceLease.acquire(root, root);
      assert.equal(blocked.viewer, true);
      assert.ok(blocked.viewerReason?.includes(recoveryPath));
      assert.match(blocked.viewerReason ?? "", /manual removal/);
      await blocked.release();
    } finally { await unlink(recoveryPath); }
    const recovered = await WorkspaceLease.acquire(root, root);
    assert.equal(recovered.viewer, false);
    await recovered.release();
    const marker = await recoverRunMarker(root, "session-one");
    assert.equal(marker?.status, "interrupted");
    assert.equal(marker?.runId, "run-one");
    assert.equal(marker?.startedAt, 123);
    assert.deepEqual(await readRunMarker(root, "session-one"), marker);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi session JSONL is inspected before open and malformed tails are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-session-"));
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Review the project.", timestamp: Date.now() });
    manager.appendSessionInfo("Inspection test");
    const file = manager.getSessionFile();
    assert.ok(file);
    const inspection = await inspectSession(file, root);
    assert.equal(inspection.id, manager.getSessionId());
    assert.equal(inspection.messages, 1);
    assert.equal(inspection.name, "Inspection test");
    assert.equal(inspection.lastMessage, "Review the project.");
    assert.equal(inspection.prompt, "Review the project.");
    const before = await readFile(file, "utf8");
    await appendFile(file, '{"type":"message"');
    await assert.rejects(inspectSession(file, root), /Invalid session line/);
    assert.equal(await readFile(file, "utf8"), `${before}{"type":"message"`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ArkCode discovers saved sessions across one-level project directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-browser-"));
  try {
    for (const name of ["one", "two"]) {
      const cwd = join(home, name);
      await mkdir(cwd);
      const encoded = Buffer.from(process.platform === "win32" ? cwd.toLowerCase() : cwd).toString("base64url");
      const manager = SessionManager.create(cwd, join(home, "sessions", encoded));
      manager.appendMessage({ role: "user", content: `Prompt from ${name}`, timestamp: Date.now() });
    }
    const sessions = await listArkSessions(home);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((session) => session.firstMessage).sort(), ["Prompt from one", "Prompt from two"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("startup does not create or prefer a DeepSeek endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-model-"));
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "arkcode-test-key-not-secret";
  try {
    const runtime = await createModelRuntime(home);
    await assert.rejects(readFile(join(home, "models.json"), "utf8"), /ENOENT/);
    assert.equal(runtime.getModel("deepseek", "deepseek-flash")?.input.includes("image"), true);
    await assert.rejects(selectModel(runtime, "does-not-exist"), /Unknown model/);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});

test("existing ArkCode DeepSeek configuration keeps Pi's image-capable model metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-deepseek-legacy-"));
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "arkcode-test-key-not-secret";
  try {
    await writeFile(join(home, "models.json"), JSON.stringify({ providers: { deepseek: {
      baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "${DEEPSEEK_API_KEY}",
      models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
    } } }));
    const runtime = await createModelRuntime(home);
    const selected = await selectModel(runtime, "deepseek/deepseek-flash");
    assert.deepEqual(selected?.input, ["text", "image"]);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});

test("selecting a built-in model keeps Pi metadata and leaves models.json untouched", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-builtin-"));
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "arkcode-test-key-not-secret";
  try {
    const runtime = await createModelRuntime(home);
    const builtin = runtime.getModel("deepseek", "deepseek-flash");
    const selected = await configureConnection(home, runtime, { kind: "builtin", provider: "deepseek", model: "deepseek-flash" });
    assert.deepEqual(selected, builtin);
    await assert.rejects(readFile(join(home, "models.json"), "utf8"), /ENOENT/);
    assert.deepEqual([loadConfig(home).provider, loadConfig(home).model], ["deepseek", "deepseek-flash"]);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit custom model input is not changed by DeepSeek legacy migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-deepseek-custom-"));
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "arkcode-test-key-not-secret";
  try {
    const path = join(home, "models.json");
    const source = JSON.stringify({ providers: { deepseek: {
      baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "${DEEPSEEK_API_KEY}",
      models: [{ id: "deepseek-flash", input: ["text"] }],
    } } });
    await writeFile(path, source);
    const runtime = await createModelRuntime(home);
    assert.deepEqual((await selectModel(runtime, "deepseek/deepseek-flash"))?.input, ["text"]);
    assert.equal(await readFile(path, "utf8"), source);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});

test("custom endpoints preserve JSONC comments and describe all model capabilities", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-custom-endpoint-"));
  const original = process.env.ARKCODE_TEST_KEY;
  process.env.ARKCODE_TEST_KEY = "arkcode-test-key-not-secret";
  try {
    const path = join(home, "models.json");
    await writeFile(path, '{\n  // retained comment\n  "providers": { "another": { "baseUrl": "http://localhost:9999/v1", "api": "openai-completions", "apiKey": "dummy", "models": [{"id":"other"}] },\n    "my-endpoint": { "baseUrl": "https://example.com/v1", "api": "openai-responses", "apiKey": "${ARKCODE_TEST_KEY}", "models": [\n      // existing model comment\n      {"id":"vision", // model field comment\n       "samplingParams": {"temperature": 0.2}}\n    ] }\n  }\n}\n');
    const runtime = await createModelRuntime(home);
    const model = await configureConnection(home, runtime, { kind: "custom", provider: "my-endpoint", model: "vision", name: "Vision",
      baseUrl: "https://example.com/v1", api: "openai-responses", input: "image", reasoning: true,
      contextWindow: 65536, maxTokens: 4096, apiKeyEnv: "ARKCODE_TEST_KEY" });
    assert.equal(model.api, "openai-responses");
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.contextWindow, 65536);
    assert.equal(model.maxTokens, 4096);
    assert.equal(model.reasoning, true);
    const source = await readFile(path, "utf8");
    assert.match(source, /retained comment/);
    assert.match(source, /existing model comment/);
    assert.match(source, /model field comment/);
    assert.match(source, /"another"/);
    assert.match(source, /"temperature": 0.2/);
    assert.equal(source.includes("arkcode-test-key-not-secret"), false);
    assert.deepEqual([loadConfig(home).provider, loadConfig(home).model], ["my-endpoint", "vision"]);
  } finally {
    if (original === undefined) delete process.env.ARKCODE_TEST_KEY;
    else process.env.ARKCODE_TEST_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid custom endpoint leaves configuration unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-invalid-endpoint-"));
  try {
    const path = join(home, "models.json");
    const source = '{ // keep me\n "providers": {} }\n';
    await writeFile(path, source);
    const runtime = await createModelRuntime(home);
    await assert.rejects(configureConnection(home, runtime, { kind: "custom", provider: "local", model: "bad", name: "Bad",
      baseUrl: "https://example.com", api: "anthropic-messages", input: "text", reasoning: false,
      contextWindow: 4096, maxTokens: 8192 }), /Max tokens cannot exceed/);
    assert.equal(await readFile(path, "utf8"), source);
    await assert.rejects(readFile(join(home, "settings.json"), "utf8"), /ENOENT/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("custom provider ID cannot reroute previously configured models", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-endpoint-conflict-"));
  try {
    const path = join(home, "models.json");
    const source = '{ "providers": { "custom": { "baseUrl": "https://first.example/v1", "api": "openai-completions", "apiKey": "dummy", "models": [{ "id": "first" }] } } }';
    await writeFile(path, source);
    const runtime = await createModelRuntime(home);
    await assert.rejects(configureConnection(home, runtime, { kind: "custom", provider: "custom", model: "second", name: "Second",
      baseUrl: "https://second.example/v1", api: "openai-responses", input: "text", reasoning: false,
      contextWindow: 32768, maxTokens: 2048 }), /different endpoint or API/);
    assert.equal(await readFile(path, "utf8"), source);
    await assert.rejects(readFile(join(home, "settings.json"), "utf8"), /ENOENT/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("custom provider API key is stored through Pi and enables the model", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-custom-auth-"));
  try {
    const runtime = await createModelRuntime(home);
    const selected = await configureConnection(home, runtime, { kind: "custom", provider: "custom-auth", model: "vision", name: "Vision",
      baseUrl: "https://example.com", api: "anthropic-messages", input: "image", reasoning: false,
      contextWindow: 32768, maxTokens: 2048 }, "private-test-key");
    assert.equal(selected.api, "anthropic-messages");
    assert.equal((await selectModel(runtime, "custom-auth/vision"))?.id, "vision");
    assert.equal((await readFile(join(home, "auth.json"), "utf8")).includes("private-test-key"), true);
    assert.equal((await readFile(join(home, "models.json"), "utf8")).includes("private-test-key"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("custom API choices use Pi's three distinct HTTP transports", { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-api-transports-"));
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"fixture rejection"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const runtime = await createModelRuntime(home);
    const protocols = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
    for (const api of protocols) {
      const model = await configureConnection(home, runtime, { kind: "custom", provider: `fixture-${api}`, model: "sample", name: "Sample",
        baseUrl: `http://127.0.0.1:${address.port}${api === "anthropic-messages" ? "" : "/v1"}`, api, input: "text", reasoning: false,
        contextWindow: 8192, maxTokens: 512 }, "fixture-key");
      try {
        await runtime.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { signal: AbortSignal.timeout(3000) });
      } catch {}
    }
    assert.deepEqual(paths, ["/v1/chat/completions", "/v1/responses", "/v1/messages?beta=true"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
