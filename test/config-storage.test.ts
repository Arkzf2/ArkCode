import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, appendFile, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, createResources, loadConfig, saveConfig, selectModel } from "../src/config.js";
import { inspectSession, readRunMarker, recoverRunMarker, WorkspaceLease, writeRunMarker } from "../src/storage.js";

test("settings persist defaults and reject unknown permission values", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-config-"));
  try {
    const defaults = loadConfig(home);
    assert.equal(defaults.permission, "ask");
    assert.deepEqual(defaults.trustedWorkspaces, []);
    saveConfig(home, { ...defaults, permission: "read-only" });
    assert.equal(loadConfig(home).permission, "read-only");
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "ask", theme: "light", statusline: "expanded" }));
    const migrated = loadConfig(home);
    assert.deepEqual(migrated, { permission: "ask", thinking: "medium", trustedWorkspaces: [] });
    saveConfig(home, migrated);
    assert.deepEqual(JSON.parse(await readFile(join(home, "settings.json"), "utf8")), migrated);
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "ask", unexpected: true }));
    assert.throws(() => loadConfig(home), /Cannot load ArkCode settings/);
    await writeFile(join(home, "settings.json"), JSON.stringify({ permission: "unsafe" }));
    assert.throws(() => loadConfig(home), /Cannot load ArkCode settings/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("resources read bounded trusted ancestor instructions and never discover extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-resources-"));
  const cwd = join(root, "nested");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  try {
    await writeFile(join(root, "AGENTS.md"), "Use focused edits.");
    await writeFile(join(cwd, "AGENTS.md"), "x".repeat(70 * 1024));
    await writeFile(join(cwd, ".pi", "extensions", "bad.ts"), "throw new Error('must not execute');");
    const untrusted = createResources(cwd, false);
    assert.deepEqual(untrusted.getAgentsFiles().agentsFiles, []);
    await untrusted.reload();
    const trusted = createResources(cwd, true);
    const instructions = trusted.getAgentsFiles().agentsFiles;
    assert.equal(instructions.find((file) => file.path === join(root, "AGENTS.md"))?.content, "Use focused edits.");
    assert.match(instructions.find((file) => file.path === join(cwd, "AGENTS.md"))?.content ?? "", /Instructions truncated/);
    assert.deepEqual(trusted.getExtensions().extensions, []);
    assert.deepEqual(trusted.getSkills().skills, []);
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

test("a crashed real process releases ownership by stale lease recovery and does not replay runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "arkcode-crash-"));
  const moduleUrl = pathToFileURL(resolve("src/storage.ts")).href;
  const script = `const { WorkspaceLease } = await import(${JSON.stringify(moduleUrl)}); await WorkspaceLease.acquire(${JSON.stringify(root)}, ${JSON.stringify(root)}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const output = await once(child.stdout, "data");
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
    const before = await readFile(file, "utf8");
    await appendFile(file, '{"type":"message"');
    await assert.rejects(inspectSession(file, root), /Invalid session line/);
    assert.equal(await readFile(file, "utf8"), `${before}{"type":"message"`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DeepSeek configuration references the environment and selects Flash without a model network request", async () => {
  const home = await mkdtemp(join(tmpdir(), "arkcode-model-"));
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "arkcode-test-key-not-secret";
  try {
    const runtime = await createModelRuntime(home);
    const source = await readFile(join(home, "models.json"), "utf8");
    assert.match(source, /\$\{DEEPSEEK_API_KEY\}/);
    assert.equal(source.includes("arkcode-test-key-not-secret"), false);
    const selected = await selectModel(runtime);
    assert.equal(selected?.provider, "deepseek");
    assert.equal(selected?.id, "deepseek-flash");
    await assert.rejects(selectModel(runtime, "does-not-exist"), /Unknown model/);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});
