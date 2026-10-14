import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type McpExtensionOptions, type McpHostController, type McpServerEntry, type McpToolInvocation,
} from "@earendil-works/pi-coding-agent";
import { echoMcpTool, httpMcpFixture } from "./mcp-fixture.js";

async function sdkMcp(t: TestContext, entries: McpServerEntry[], options: McpExtensionOptions = {}, setup: {
  beforeStart?: (home: string) => Promise<void>; waitReady?: boolean;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "arkcode-sdk-mcp-"));
  await setup.beforeStart?.(home);
  let controller: McpHostController | undefined;
  const extension = createMcpExtension({
    agentDir: home, resources: false, loadConfig: () => ({ servers: entries, errors: [] }),
    ...options, onController: (value) => { controller = value; },
  });
  const loader = new DefaultResourceLoader({
    cwd: home, agentDir: home, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "sdk-mcp-test", factory: extension }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: home, agentDir: home, resourceLoader: loader, tools: ["mcp__*"],
    sessionManager: SessionManager.inMemory(home), settingsManager: SettingsManager.inMemory({}),
  });
  assert.ok(controller);
  const host = controller;
  t.after(async () => { await host.close(); session.dispose(); await rm(home, { recursive: true, force: true }); });
  await session.bindExtensions({ mode: "print" });
  if (setup.waitReady !== false) await host.waitReady();
  let callId = 0;
  return { host, session, home, call: async (name: string, args: Record<string, unknown>) => {
    const definition = session.extensionRunner.getToolDefinition(name);
    assert.ok(definition);
    const id = `sdk-test-${++callId}`;
    try {
      const result = await definition.execute(id, args, undefined, undefined, session.extensionRunner.createToolContext(id, undefined));
      return { isError: result.isError ?? false, result };
    } catch (error) {
      return { isError: true, result: { content: [{ type: "text", text: String(error) }] } };
    }
  } };
}

function entry(name: string, url: string): McpServerEntry {
  return { name, config: { url, exposure: "direct", timeout: 1 }, source: "test", scope: "global" };
}

test("SDK MCP authorizes the live client and keeps structured results", async (t) => {
  const fixture = await httpMcpFixture(t, { call: () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { value: 7 } }) });
  const calls: McpToolInvocation[] = [];
  const sdk = await sdkMcp(t, [entry("fixture", fixture.url)], { authorizeTool: async (call) => { calls.push(call); } });
  const result = await sdk.call("mcp__fixture__echo", { text: "hello" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "mcp__fixture__echo");
  assert.equal(calls[0]?.tool.name, "echo");
  assert.deepEqual(calls[0]?.args, { text: "hello" });
  assert.match(calls[0]?.connectionId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(fixture.calls.length, 1);
  assert.match(JSON.stringify(result), /structuredContent.*value.*7/);
  assert.equal(sdk.session.extensionRunner.getToolDefinition("mcp__fixture__echo")?.executionMode, "sequential");
});

test("SDK target reconnect rereads config, preserves siblings, and rejects an approval for the retired client", async (t) => {
  const first = await httpMcpFixture(t);
  const replacement = await httpMcpFixture(t);
  const sibling = await httpMcpFixture(t);
  let entries = [entry("fixture", first.url), entry("sibling", sibling.url)];
  let approve = () => {};
  let requested = () => {};
  const requestedPromise = new Promise<void>((resolve) => { requested = resolve; });
  const approval = new Promise<void>((resolve) => { approve = resolve; });
  const sdk = await sdkMcp(t, entries, {
    loadConfig: () => ({ servers: entries, errors: [] }),
    authorizeTool: async () => { requested(); await approval; },
  });
  const pending = sdk.call("mcp__fixture__echo", { text: "pending" });
  await requestedPromise;
  entries = [entry("fixture", replacement.url), entry("sibling", sibling.url)];
  await sdk.host.reconnect("fixture");
  approve();
  const stale = await pending;
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /no longer available|connection changed/);
  assert.equal(first.calls.length, 0);
  assert.equal(replacement.calls.length, 0);
  assert.equal(sibling.initialized, 1);
  assert.equal(sibling.closed, 0);
  assert.equal((await sdk.call("mcp__fixture__echo", { text: "fresh" })).isError, false);
  assert.equal(replacement.calls.length, 1);
});

test("SDK metadata changes while approval is pending invalidate the call", async (t) => {
  const fixture = await httpMcpFixture(t);
  let approve = () => {};
  let requested = () => {};
  const requestedPromise = new Promise<void>((resolve) => { requested = resolve; });
  const approval = new Promise<void>((resolve) => { approve = resolve; });
  const sdk = await sdkMcp(t, [entry("fixture", fixture.url)], {
    authorizeTool: async () => { requested(); await approval; },
  });
  const pending = sdk.call("mcp__fixture__echo", { text: "pending" });
  await requestedPromise;
  fixture.setTools([{ ...echoMcpTool, annotations: { destructiveHint: true } }]);
  for (let attempt = 0; attempt < 100 && !sdk.host.snapshot().servers[0]?.tools[0]?.tool.annotations?.destructiveHint; attempt++) await delay(10);
  assert.equal(sdk.host.snapshot().servers[0]?.tools[0]?.tool.annotations?.destructiveHint, true);
  approve();
  assert.equal((await pending).isError, true);
  assert.equal(fixture.calls.length, 0);
});

test("SDK startup deadline is separate from tool timeout and blocks new connections while the host stops", async (t) => {
  const fixture = await httpMcpFixture(t, { initialize: async () => { await delay(200); } });
  let canConnect = true;
  const sdk = await sdkMcp(t, [entry("fixture", fixture.url)], {
    startupTimeoutMs: () => 50, canConnect: () => canConnect,
  });
  assert.equal(sdk.host.snapshot().servers[0]?.state, "failed");
  assert.match(sdk.host.snapshot().servers[0]?.error ?? "", /Startup timed out after 50 ms/);
  const initialized = fixture.initialized;
  canConnect = false;
  await sdk.host.reconnect("fixture");
  assert.equal(fixture.initialized, initialized);
  assert.notEqual(sdk.host.snapshot().servers[0]?.state, "connected");
});

test("SDK host tool filter prevents registration and the install patch is idempotent", async (t) => {
  const fixture = await httpMcpFixture(t);
  const sdk = await sdkMcp(t, [entry("fixture", fixture.url)], { filterTool: () => false });
  assert.deepEqual(sdk.host.snapshot().servers[0]?.tools, []);
  assert.equal(sdk.session.extensionRunner.getToolDefinition("mcp__fixture__echo"), undefined);
  await promisify(execFile)(process.execPath, ["scripts/patch-pi-sdk.mjs"], { cwd: process.cwd() });
});

test("SDK OAuth credentials are read and removed only in the host agent directory", async (t) => {
  const fixture = await httpMcpFixture(t, { authorization: "Bearer host-only-token" });
  const sdk = await sdkMcp(t, [entry("fixture", fixture.url)], {}, { beforeStart: async (home) => {
    await writeFile(join(home, "mcp-auth.json"), JSON.stringify({
      [`mcp__fixture|${fixture.url}`]: { tokens: { access_token: "host-only-token", token_type: "Bearer" } },
    }));
  } });
  assert.equal(sdk.host.snapshot().servers[0]?.state, "connected");
  assert.equal((await sdk.call("mcp__fixture__echo", { text: "authenticated" })).isError, false);
  assert.equal(await sdk.host.logout("fixture"), true);
  assert.deepEqual(JSON.parse(await readFile(join(sdk.home, "mcp-auth.json"), "utf8")), {});
  assert.equal(sdk.host.snapshot().servers[0]?.state, "needs-auth");
});

test("SDK cancellation settles a pending initialization and close prevents late registrations", async (t) => {
  let release = () => {};
  const initialization = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await httpMcpFixture(t, { initialize: () => initialization });
  const sdk = await sdkMcp(t, [entry("fixture", fixture.url)], { startupTimeoutMs: () => 5000 }, { waitReady: false });
  for (let attempt = 0; attempt < 100 && fixture.initialized === 0; attempt++) await delay(10);
  assert.equal(fixture.initialized, 1);
  await sdk.host.cancelConnecting();
  assert.equal(sdk.host.snapshot().servers[0]?.state, "closed");
  await sdk.host.close();
  release();
  await sdk.host.waitReady();
  assert.deepEqual(sdk.host.snapshot().servers, []);
  assert.equal(sdk.session.extensionRunner.getToolDefinition("mcp__fixture__echo"), undefined);
});

test("SDK patch applies to a fresh installation, recovers partial application, and refuses drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-sdk-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const manifest = z.object({ files: z.record(z.string(), z.object({ original: z.string(), patched: z.string() })) })
    .parse(JSON.parse(await readFile("scripts/pi-sdk-patch/manifest.json", "utf8")));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp("scripts/patch-pi-sdk.mjs", join(root, "scripts/patch-pi-sdk.mjs"));
  await cp("scripts/pi-sdk-patch", join(root, "scripts/pi-sdk-patch"), { recursive: true });
  await mkdir(join(sdk, "dist"), { recursive: true });
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.0", type: "module", exports: { ".": "./dist/index.js" } }));
  await writeFile(join(sdk, "dist/index.js"), "");
  const upstream = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/.arkcode-sdk-originals");
  for (const file of Object.keys(manifest.files)) {
    await mkdir(dirname(join(sdk, file)), { recursive: true });
    await cp(join(upstream, file), join(sdk, file));
  }
  const runPatch = () => promisify(execFile)(process.execPath, [join(root, "scripts/patch-pi-sdk.mjs")], { cwd: root });
  const hash = (text: string) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
  await runPatch();
  for (const [file, checksum] of Object.entries(manifest.files)) {
    assert.equal(hash(await readFile(join(sdk, file), "utf8")), checksum.patched);
    assert.equal(hash(await readFile(join(sdk, ".arkcode-sdk-originals", file), "utf8")), checksum.original);
  }
  const partial = "dist/extensions/mcp/runtime.js";
  await cp(join(upstream, partial), join(sdk, partial));
  await runPatch();
  assert.equal(hash(await readFile(join(sdk, partial), "utf8")), manifest.files[partial]?.patched);
  const drifted = "dist/core/tools/grep.js";
  await writeFile(join(sdk, drifted), "unexpected change");
  await assert.rejects(runPatch, /changed unexpectedly/);
  assert.equal(await readFile(join(sdk, drifted), "utf8"), "unexpected change");
});
