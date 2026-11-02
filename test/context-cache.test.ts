import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, createResources } from "../src/config/settings.js";
import { installDynamicContext } from "../src/context/dynamic.js";

test("request preparation reuses instruction contents and compact capture forces a fresh baseline", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-context-cache-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "AGENTS.md"), "Current project rule.");
  const runtime = await createModelRuntime(cwd);
  const model = runtime.getModel("openai", "gpt-4.1"); assert.ok(model);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd), tools: [], resourceLoader: createResources(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  t.after(() => session.dispose());
  const dynamic = installDynamicContext(session, { cwd, home: join(cwd, "home"), trusted: true,
    projectDocMaxBytes: 32768, shell: () => "bash", executionBlocked: () => false,
  });
  const open = t.mock.method(fs, "open");
  const readdir = t.mock.method(fs, "readdir");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const prepare = () => session.agent.prepareRequest?.({
    context: { messages: session.messages, tools: [] }, model, thinkingLevel: "off",
  });
  await prepare();
  const opens = open.mock.callCount(), scans = readdir.mock.callCount();
  assert.ok(opens > 0 && scans > 0);
  await prepare();
  assert.equal(open.mock.callCount(), opens);
  assert.equal(readdir.mock.callCount(), scans);
  assert.match(String((await dynamic.capture()).content), /Current project rule/);
  assert.equal(open.mock.callCount(), opens + 1);
  assert.ok(readdir.mock.callCount() > scans);
  await prepare();
  assert.equal(open.mock.callCount(), opens + 1);
  dynamic.invalidate();
  await prepare();
  assert.equal(open.mock.callCount(), opens + 2);
});
