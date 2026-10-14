import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, createResources } from "../src/config.js";
import { CONTEXT_MESSAGE, installDynamicContext, withoutProjectSystem } from "../src/context.js";

test("request preparation appends hidden deltas, refreshes across midnight and restores a full anchor after compact", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(cwd);
  const runtime = await createModelRuntime(cwd);
  const model = runtime.getModel("openai", "gpt-4.1");
  assert.ok(model);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime,
    sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [], resourceLoader: withoutProjectSystem(createResources(cwd, true)),
  });
  t.after(() => session.dispose());
  let now = new Date("2026-10-13T15:59:00Z");
  installDynamicContext(session, { cwd, shell: "powershell.exe", trusted: true, executionBlocked: () => false,
    now: () => now, timezone: () => "Asia/Shanghai",
  });
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  const prepare = async (signal?: AbortSignal) => {
    const prepareRequest = session.agent.prepareRequest;
    assert.ok(prepareRequest);
    const update = await prepareRequest({ context: { messages: session.messages, tools: session.agent.state.tools }, model, thinkingLevel: "off" }, signal);
    assert.ok(update?.context);
    return update.context.messages;
  };
  const lastText = (messages: typeof session.messages): string => {
    const message = messages.findLast((entry) => entry.role === "custom" && entry.customType === CONTEXT_MESSAGE);
    assert.ok(message?.role === "custom");
    return String(message.content);
  };
  manager.appendMessage({ role: "user", content: "Initial task", timestamp: Date.now() });
  await writeFile(join(cwd, "AGENTS.md"), "Use project convention A.");
  const first = await prepare();
  const full = first.find((message) => message.role === "custom" && message.customType === CONTEXT_MESSAGE);
  assert.ok(full?.role === "custom");
  assert.equal(full.display, false);
  assert.match(String(full.content), /2026-10-13/);
  assert.doesNotMatch(String(full.content), /sandbox/i);
  assert.match(String(full.content), /Use project convention A/);
  assert.ok(!session.systemPrompt.includes("Use project convention A"));
  assert.deepEqual(await prepare(), first);
  assert.deepEqual(events, []);

  now = new Date("2026-10-13T16:01:00Z");
  const midnight = await prepare();
  assert.deepEqual(midnight.slice(0, first.length), first);
  assert.match(lastText(midnight), /<current_date>2026-10-14<\/current_date>/);
  assert.doesNotMatch(lastText(midnight), /<cwd>|project_instructions/);
  await writeFile(join(cwd, "AGENTS.md"), "Use project convention B.");
  const changed = await prepare();
  assert.match(lastText(changed), /replace all previously supplied project instructions/);
  assert.match(lastText(changed), /Use project convention B/);

  manager.appendCompaction("Earlier task summary with stale project instructions", null, 100);
  const compacted = await prepare();
  assert.match(lastText(compacted), /<cwd>/);
  assert.match(lastText(compacted), /2026-10-14/);
  assert.match(lastText(compacted), /Use project convention B/);
  assert.deepEqual(await prepare(), compacted);
  const entriesBeforeAbort = manager.getEntries().length;
  await assert.rejects(prepare(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(manager.getEntries().length, entriesBeforeAbort);
});
