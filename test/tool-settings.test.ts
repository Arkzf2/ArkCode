import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../src/config/settings.js";
import { loadMcpConfig } from "../src/integrations/mcp/config.js";
import { SessionToolSettings, TOOL_SETTINGS_ENTRY } from "../src/session/tool-settings.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "arkcode-tool-settings-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { home, cwd, trusted: true };
  return { ...options, manager: SessionManager.inMemory(cwd), options };
}

test("tool snapshots keep only exposure policy, preserve old branches and stage newly configured servers", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: {
    original: { url: "https://example.com/mcp", headers: { Authorization: "private-secret" }, exposure: "direct", toolExposure: { read: "hidden" } },
  } }));
  const settings = new SessionToolSettings(f.manager, f.options);
  const initial = f.manager.getLeafId(); assert.ok(initial);
  assert.ok(!JSON.stringify(f.manager.getEntries()).includes("private-secret"));
  assert.ok(!JSON.stringify(f.manager.getEntries()).includes("Authorization"));
  saveConfig(f.home, { ...loadConfig(f.home), toolMode: "codemode-only" });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: {
    original: { url: "https://example.com/mcp", exposure: "codemode" },
    added: { url: "https://example.com/added", exposure: "direct" },
  } }));
  const [original, added] = loadMcpConfig(f.options).entries; assert.ok(original); assert.ok(added);
  assert.equal(settings.exposure(original).exposure, "direct");
  assert.equal(settings.exposure(added).exposure, "hidden");
  f.manager.appendCompaction("Saved summary", null, 100);
  const recovered = new SessionToolSettings(f.manager, f.options);
  assert.equal(recovered.current.toolMode, "codemode-only");
  assert.equal(recovered.exposure(original).exposure, "codemode");
  assert.equal(recovered.exposure(added).exposure, "direct");
  saveConfig(f.home, { ...loadConfig(f.home), toolMode: "direct" });
  assert.equal(new SessionToolSettings(f.manager, f.options).current.toolMode, "codemode-only");
  f.manager.branch(initial);
  assert.equal(new SessionToolSettings(f.manager, f.options).current.toolMode, "codemode");
});

test("legacy histories keep the original hybrid behavior while new sessions use the latest preference", async (t) => {
  const f = await fixture(t);
  saveConfig(f.home, { ...loadConfig(f.home), toolMode: "codemode-only" });
  f.manager.appendMessage({ role: "user", content: "An existing conversation", timestamp: 0 });
  assert.equal(new SessionToolSettings(f.manager, f.options).current.toolMode, "codemode");
  assert.equal(new SessionToolSettings(SessionManager.inMemory(f.cwd), f.options).current.toolMode, "codemode-only");
});

test("invalid tool snapshots and invalid configured modes fail validation", async (t) => {
  const f = await fixture(t);
  f.manager.appendCustomEntry(TOOL_SETTINGS_ENTRY, { version: 1, toolMode: "unsafe", mcp: [] });
  assert.throws(() => new SessionToolSettings(f.manager, f.options));
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ toolMode: "unsafe" }));
  assert.throws(() => loadConfig(f.home), /Cannot load ArkCode settings/);
});
