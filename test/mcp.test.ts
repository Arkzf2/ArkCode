import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadMcpConfig, mcpToolEnabled, setMcpEnabled } from "../src/integrations/mcp/config.js";
import { McpManager } from "../src/integrations/mcp/manager.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, createResources } from "../src/config/settings.js";
import { WorkspaceAutocompleteProvider } from "../src/ui/autocomplete.js";
import { httpMcpFixture } from "./mcp-fixture.js";

async function managerFixture(t: import("node:test").TestContext, servers: object) {
  const home = await mkdtemp(join(tmpdir(), "arkcode-mcp-manager-"));
  const path = join(home, "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
  const manager = new McpManager({ home, cwd: home, trusted: true,
    canConnect: () => true, authorize: async () => false, warning: () => {},
  });
  const loader = new DefaultResourceLoader({ cwd: home, agentDir: home, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [manager.extension],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir: home, modelRuntime: await createModelRuntime(home),
    sessionManager: SessionManager.inMemory(home), settingsManager: SettingsManager.inMemory({}),
    resourceLoader: createResources(loader.getExtensions()), tools: ["mcp__*"],
  });
  t.after(async () => { await manager.close(); session.dispose(); await rm(home, { recursive: true, force: true }); });
  await session.bindExtensions({ mode: "print" });
  return { manager, home, path };
}

test("MCP defaults allow a 60 second cold package startup instead of killing it at 10 seconds", async (t) => {
  const slow = await httpMcpFixture(t, { initialize: () => delay(10200) });
  const { manager } = await managerFixture(t, { slow: { url: slow.url } });
  await manager.waitReady();
  assert.equal(manager.statuses[0]?.state.kind, "connected");
});

test("MCP startup timeout identifies the deadline rather than a generic connection close", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = await httpMcpFixture(t, { initialize: () => gate });
  const { manager } = await managerFixture(t, { slow: { url: slow.url, startupTimeoutMs: 150 } });
  t.after(() => release());
  await manager.waitReady();
  assert.match(manager.statusText(), /Startup timed out after 150 ms/);
});

test("MCP startup failures expose stderr and redact configured credentials", async (t) => {
  const { manager } = await managerFixture(t, { broken: {
    command: process.execPath, args: ["-e", "console.error('dependency failed: '+process.env.MCP_TEST_SECRET);process.exit(1)"],
    env: { MCP_TEST_SECRET: "fixture-secret-do-not-display" },
  } });
  await manager.waitReady();
  assert.match(manager.statusText(), /dependency failed: \[redacted\]/);
  assert.doesNotMatch(manager.statusText(), /fixture-secret-do-not-display/);
});

test("MCP stderr redacts long credentials before truncating the diagnostic tail", async (t) => {
  const { manager } = await managerFixture(t, { broken: {
    command: process.execPath, args: ["-e", "console.error(process.env.MCP_TEST_SECRET);console.error('dependency failed');process.exit(1)"],
    env: { MCP_TEST_SECRET: "credential-part-".repeat(200) },
  } });
  await manager.waitReady();
  assert.match(manager.statusText(), /\[redacted\]\ndependency failed/);
  assert.doesNotMatch(manager.statusText(), /credential-part/);
});

test("MCP reconnect reads edited configuration and can retire a deleted server", async (t) => {
  const first = await httpMcpFixture(t);
  const second = await httpMcpFixture(t);
  const { manager, path } = await managerFixture(t, { service: { url: first.url } });
  await manager.waitReady();
  await writeFile(path, JSON.stringify({ mcpServers: { service: { url: second.url } } }));
  await manager.reconnect("service");
  assert.equal(second.initialized, 1);
  assert.equal(first.closed, 1);
  assert.equal(manager.statuses[0]?.state.kind, "connected");
  await writeFile(path, JSON.stringify({ mcpServers: {} }));
  await manager.reconnect("service");
  assert.equal(second.closed, 1);
  assert.deepEqual(manager.statuses, []);
});

test("MCP config validates each server, skips untrusted project config and overrides user identities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "arkcode-mcp-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home"); const cwd = join(directory, "workspace");
  await mkdir(home); await mkdir(join(cwd, ".arkcode"), { recursive: true });
  await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: {
    shared: { url: "http://localhost:1/mcp", autoApproveTools: ["read_*"] },
    local: { command: "node", enabledTools: ["read_*"], disabledTools: ["read_secret"] },
    invalid: { url: "file:///secret" }, legacy: { transport: "sse", url: "https://example.test" },
  } }));
  const path = join(cwd, ".arkcode", "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: {
    shared: { command: "node" }, selfApproved: { command: "node", autoApproveTools: ["*"] },
  } }));
  const untrusted = loadMcpConfig({ home, cwd, trusted: false });
  assert.equal(untrusted.entries.find((entry) => entry.name === "shared")?.scope, "user");
  assert.equal(untrusted.entries.length, 2);
  assert.ok(untrusted.diagnostics.some((message) => message.includes("untrusted")));
  const trusted = loadMcpConfig({ home, cwd, trusted: true });
  const shared = trusted.entries.find((entry) => entry.name === "shared"); assert.ok(shared);
  assert.equal(shared.scope, "project");
  assert.deepEqual(shared.config.autoApproveTools, []);
  assert.ok(!trusted.entries.some((entry) => entry.name === "selfApproved"));
  const local = trusted.entries.find((entry) => entry.name === "local"); assert.ok(local);
  assert.equal(mcpToolEnabled(local.config, "read_file"), true);
  assert.equal(mcpToolEnabled(local.config, "read_secret"), false);
  assert.equal(mcpToolEnabled(local.config, "write_file"), false);
  setMcpEnabled(shared, false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.shared.enabled, false);
  assert.throws(() => setMcpEnabled(shared, true), /configuration changed/);
});

test("SDK MCP registration preserves distinct original identities and fits provider constraints", async (t) => {
  const fixture = await httpMcpFixture(t, { tools: ["echo", "tool/one", "tool_one"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
  const { manager } = await managerFixture(t, Object.fromEntries(["server", "a.b", "a_b", "long".repeat(40)].map((name) => [name, { url: fixture.url }])));
  await manager.waitReady();
  const names = manager.statuses.flatMap((server) => server.tools.map((tool) => tool.modelName));
  assert.ok(names.includes("mcp__server__echo"));
  assert.equal(names.length, 12);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) { assert.ok(name.length <= 64); assert.match(name, /^[A-Za-z0-9_-]+$/); }
});

test("/mcp completion includes subcommands and current server names after a reload", async () => {
  let servers = ["github", "local"];
  const provider = new WorkspaceAutocompleteProvider(process.cwd(), () => servers);
  const suggestions = async (text: string) => provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
  const command = (await suggestions("/mc"))?.items.find((item) => item.value === "mcp"); assert.ok(command);
  assert.equal(provider.applyCompletion(["/mc"], 0, 3, command, "/mc").lines[0], "/mcp ");
  assert.ok((await suggestions("/mcp re"))?.items.some((item) => item.value === "reconnect"));
  assert.ok((await suggestions("/mcp tools g"))?.items.some((item) => item.value === "tools github"));
  servers = ["gitlab"];
  assert.ok((await suggestions("/mcp tools g"))?.items.some((item) => item.value === "tools gitlab"));
  assert.ok(!(await suggestions("/mcp tools g"))?.items.some((item) => item.value.includes("github")));
});
