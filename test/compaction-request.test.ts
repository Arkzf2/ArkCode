import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { convertToLlm, createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CompactionController } from "../src/compaction/controller.js";
import { createModelRuntime, createResources } from "../src/config/settings.js";
import { installDynamicContext } from "../src/context/dynamic.js";
import { SessionToolSettings } from "../src/session/tool-settings.js";

test("compact preserves the conversation prefix and Responses output budget from historical usage", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-compact-request-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key",
    models: [{ id: "test", input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  const runtime = await createModelRuntime(cwd);
  const model = runtime.getModel("fixture", "test"); assert.ok(model);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime,
    sessionManager: manager, tools: [], resourceLoader: createResources(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  t.after(() => session.dispose());
  const settings = new SessionToolSettings(manager, { home: cwd, cwd, trusted: true });
  settings.installApply(async (next) => { settings.current = next; });
  const dynamic = installDynamicContext(session, { cwd, home: cwd, trusted: true, projectDocMaxBytes: 32768,
    shell: () => "bash", executionBlocked: () => false,
  });
  new CompactionController(session, { settings, captureContext: dynamic.capture, warning: () => {} });
  manager.appendMessage({ role: "system", content: "Original system", sections: { rules: "Original rules" }, toolsAdded: [], timestamp: 1 });
  manager.appendMessage({ role: "user", content: "Original task", timestamp: 2 });
  manager.appendMessage({ role: "system", content: "Updated tools and rules", toolsAdded: [], timestamp: 3 });
  manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "e".repeat(220000) }], stopReason: "stop", timestamp: 4,
    usage: { input: 13000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 14000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const before = structuredClone(convertToLlm(manager.buildSessionProjection().messages));
  const complete = runtime.completeSimple.bind(runtime);
  let sent: typeof before = [];
  let outputTokens = 0;
  const capture: typeof runtime.completeSimple = async (selected, context, options) => {
    sent = structuredClone(context.messages);
    return complete(selected, context, { ...options, onPayload: (payload) => {
      outputTokens = z.object({ max_output_tokens: z.number() }).parse(payload).max_output_tokens;
      throw new Error("Captured summary request before network");
    } });
  };
  t.mock.method(runtime, "completeSimple", capture);
  await assert.rejects(session.runHostCompaction("manual"), /Captured summary request before network/);
  assert.equal(outputTokens, 4096, "historical usage should leave the full summary output budget available");
  assert.deepEqual(sent.slice(0, -1), before);
  assert.equal(sent.at(-1)?.role, "user");
  assert.ok((sent.at(-1)?.timestamp ?? 0) > 4);
  assert.deepEqual(convertToLlm(manager.buildSessionProjection().messages), before);
});
