import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, createResources } from "../src/config/settings.js";
import { CONTEXT_MESSAGE, contextUpdate, installDynamicContext, type ContextSnapshot } from "../src/context/dynamic.js";

test("legacy context snapshots cannot suppress the new full instruction disclosure", () => {
  const snapshot = { environment: { cwd: "/workspace", platform: "linux", os: "Linux", shell: "bash", current_date: "2026-10-14",
    timezone: "UTC", git_branch: "main", execution: "available" }, agents: [] } satisfies ContextSnapshot;
  const update = contextUpdate([{ role: "custom", customType: CONTEXT_MESSAGE, content: "Old unscoped instructions.", display: false,
    timestamp: 1, details: { version: 1, kind: "full", snapshot },
  }], snapshot);
  assert.ok(update);
  assert.match(String(update.content), /<environment_context>/);
  assert.match(String(update.content), /global and project instructions no longer apply/);
  assert.equal(update.display, false);
  assert.deepEqual(update.details, { version: 2, kind: "full", snapshot });
});

test("empty initial instructions are omitted, global rules load, and removal clears earlier rules once", () => {
  const snapshot = { environment: { cwd: "/workspace", platform: "linux", os: "Linux", shell: "bash", current_date: "2026-11-02",
    timezone: "UTC", git_branch: "main", execution: "available" }, agents: [] } satisfies ContextSnapshot;
  const first = contextUpdate([], snapshot);
  assert.ok(first);
  assert.doesNotMatch(String(first.content), /project_instructions|No trusted project/);
  assert.equal(contextUpdate([first], snapshot), undefined);
  const global = { ...snapshot, agents: [{ kind: "global", path: "/home/AGENTS.md", content: "Global convention." }] } satisfies ContextSnapshot;
  const loaded = contextUpdate([first], global);
  assert.ok(loaded);
  assert.match(String(loaded.content), /kind="global".*scope="all workspaces"/);
  assert.match(String(loaded.content), /Global convention/);
  const removed = contextUpdate([first, loaded], snapshot);
  assert.ok(removed);
  assert.match(String(removed.content), /global and project instructions no longer apply/);
  assert.doesNotMatch(String(removed.content), /More specific|sibling|<environment_context>/);
  assert.equal(contextUpdate([first, loaded, removed], snapshot), undefined);
});

test("request preparation appends hidden deltas, refreshes across midnight and restores a full anchor after compact", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(cwd);
  const runtime = await createModelRuntime(cwd);
  const model = runtime.getModel("openai", "gpt-4.1");
  assert.ok(model);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime,
    sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [], resourceLoader: createResources(),
  });
  t.after(() => session.dispose());
  let now = new Date("2026-10-13T15:59:00Z");
  let shell = "powershell.exe";
  const dynamic = installDynamicContext(session, { cwd, home: join(cwd, "home"), projectDocMaxBytes: 32 * 1024, shell: () => shell, trusted: true, executionBlocked: () => false,
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
  assert.doesNotMatch(String((await dynamic.capture()).content), /project_instructions/);
  await mkdir(join(cwd, "home"));
  await mkdir(join(cwd, "child"));
  await writeFile(join(cwd, "home", "AGENTS.md"), "Global convention.");
  await writeFile(join(cwd, "child", "AGENTS.md"), "Child convention.");
  await writeFile(join(cwd, "AGENTS.md"), "Use project convention A.");
  const first = await prepare();
  const full = first.find((message) => message.role === "custom" && message.customType === CONTEXT_MESSAGE);
  assert.ok(full?.role === "custom");
  assert.equal(full.display, false);
  assert.match(String(full.content), /2026-10-13/);
  assert.doesNotMatch(String(full.content), /sandbox/i);
  assert.match(String(full.content), /Use project convention A/);
  assert.match(String(full.content), /kind="global".*scope="all workspaces"/);
  assert.ok(String(full.content).includes(`scope="${join(cwd, "child")}"`));
  assert.match(String(full.content), /sibling directory rules do not apply to each other/);
  assert.match(String(full.content), /Global convention/);
  assert.match(String(full.content), /Child convention/);
  assert.ok(!session.systemPrompt.includes("Use project convention A"));
  assert.deepEqual(await prepare(), first);
  assert.deepEqual(events, []);

  shell = "E:/Program Files/Git/bin/bash.exe";
  const switched = await prepare();
  assert.match(lastText(switched), /<shell>E:\/Program Files\/Git\/bin\/bash\.exe<\/shell>/);
  assert.doesNotMatch(lastText(switched), /powershell\.exe|project_instructions/);
  assert.deepEqual(await prepare(), switched);
  now = new Date("2026-10-13T16:01:00Z");
  const midnight = await prepare();
  assert.deepEqual(midnight.slice(0, switched.length), switched);
  assert.match(lastText(midnight), /<current_date>2026-10-14<\/current_date>/);
  assert.doesNotMatch(lastText(midnight), /<cwd>|project_instructions/);
  await writeFile(join(cwd, "AGENTS.md"), "Use project convention B.");
  const changed = await prepare();
  assert.match(lastText(changed), /replace all previously supplied project instructions/);
  assert.match(lastText(changed), /Use project convention B/);
  await unlink(join(cwd, "child", "AGENTS.md"));
  await unlink(join(cwd, "home", "AGENTS.md"));
  const removed = await prepare();
  assert.match(lastText(removed), /replace all previously supplied project instructions, including global instructions/);
  assert.doesNotMatch(lastText(removed), /Child convention|Global convention/);

  manager.appendCompaction("Earlier task summary with stale project instructions", null, 100);
  const compacted = await prepare();
  assert.match(lastText(compacted), /<cwd>/);
  assert.match(lastText(compacted), /2026-10-14/);
  assert.match(lastText(compacted), /Use project convention B/);
  assert.deepEqual(await prepare(), compacted);
  await unlink(join(cwd, "AGENTS.md"));
  const clearedAnchor = await dynamic.capture();
  assert.match(String(clearedAnchor.content), /global and project instructions no longer apply/);
  const cleared = await prepare();
  assert.match(lastText(cleared), /No trusted project instructions apply/);
  assert.deepEqual(await prepare(), cleared);
  manager.appendCompaction("Stale instructions in an older summary", null, 100);
  manager.appendCustomMessageEntry(clearedAnchor.customType, clearedAnchor.content, false, clearedAnchor.details);
  const afterCompact = await prepare();
  assert.deepEqual(await prepare(), afterCompact);
  assert.doesNotMatch(String((await dynamic.capture()).content), /project_instructions/);
  const entriesBeforeAbort = manager.getEntries().length;
  await assert.rejects(prepare(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(manager.getEntries().length, entriesBeforeAbort);
});
