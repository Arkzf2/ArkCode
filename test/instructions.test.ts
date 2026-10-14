import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InstructionsLoader } from "../src/instructions.js";
import { loadConfig, saveConfig } from "../src/config.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "arkcode-instructions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "repo", "workspace");
  await mkdir(home);
  await mkdir(cwd, { recursive: true });
  const warnings: string[] = [];
  const loader = (trusted = true, projectDocMaxBytes = 32 * 1024) => new InstructionsLoader({
    cwd, home, trusted, projectDocMaxBytes, onWarning: (message) => warnings.push(message),
  });
  return { root, cwd, home, warnings, loader };
}

async function makeUnreadable(t: TestContext, path: string): Promise<() => Promise<void>> {
  let released = false;
  let restore: () => Promise<void>;
  if (process.platform === "win32") {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command",
      "$lock = [System.IO.File]::Open($env:ARKCODE_TEST_INSTRUCTIONS, 'Open', 'Read', 'None'); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $lock.Dispose();",
    ], { env: { ...process.env, ARKCODE_TEST_INSTRUCTIONS: path }, stdio: ["pipe", "pipe", "pipe"] });
    const ready = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("File lock process exited before acquiring the lock."); })]);
    assert.match(String(ready[0]), /ready/);
    restore = async () => { const exited = once(child, "exit"); child.stdin.end("\n"); await exited; };
  } else {
    await rename(path, `${path}.saved`);
    await symlink(path, path);
    restore = async () => { await unlink(path); await rename(`${path}.saved`, path); };
  }
  const release = async () => { if (!released) { released = true; await restore(); } };
  t.after(release);
  return release;
}

test("global, Git ancestor and recursive workspace rules load in stable scoped order", async (t) => {
  const f = await fixture(t);
  const repo = join(f.root, "repo");
  await writeFile(join(repo, ".git"), "gitdir: elsewhere");
  await writeFile(join(f.root, "AGENTS.md"), "Outside project.");
  await writeFile(join(f.home, "AGENTS.md"), " Global rule. \n");
  await writeFile(join(repo, "AGENTS.md"), "Repository rule.");
  await writeFile(join(f.cwd, "AGENTS.md"), "Workspace rule.");
  for (const path of ["b", "a/deep"]) await mkdir(join(f.cwd, path), { recursive: true });
  for (const path of ["b", "a", "a/deep"]) await writeFile(join(f.cwd, path, "AGENTS.md"), path);
  await mkdir(join(repo, "sibling"));
  await writeFile(join(repo, "sibling", "AGENTS.md"), "Outside workspace.");
  const instructions = await f.loader().load();
  assert.deepEqual(instructions, [
    { kind: "global", path: join(f.home, "AGENTS.md"), content: "Global rule." },
    ...[[repo, "Repository rule."], [f.cwd, "Workspace rule."], [join(f.cwd, "a"), "a"],
      [join(f.cwd, "a", "deep"), "a/deep"], [join(f.cwd, "b"), "b"]].map(([scope, content]) => {
        assert.ok(scope && content);
        return { kind: "project", path: join(scope, "AGENTS.md"), scope, content };
      }),
  ]);
  assert.deepEqual(await f.loader().load(), instructions);
  assert.deepEqual(f.warnings, []);
});

test("nearest Git root stops ancestor discovery and directories count as Git markers", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "repo", ".git"));
  await mkdir(join(f.cwd, ".git"));
  await writeFile(join(f.cwd, ".git", "AGENTS.md"), "Git metadata must not load.");
  await symlink(join(f.cwd, ".git"), join(f.cwd, "metadata-alias"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(f.root, "repo", "AGENTS.md"), "Outer repository.");
  await writeFile(join(f.cwd, "AGENTS.md"), "Nested repository.");
  assert.deepEqual((await f.loader().load()).map((file) => file.content), ["Nested repository."]);
});

test("all intermediate Git ancestors load before a deeply nested workspace", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "repo", ".git"));
  const cwd = join(f.cwd, "service", "payments");
  await mkdir(cwd, { recursive: true });
  for (const directory of [join(f.root, "repo"), f.cwd, join(f.cwd, "service"), cwd]) {
    await writeFile(join(directory, "AGENTS.md"), directory);
  }
  const loader = new InstructionsLoader({ cwd, home: f.home, trusted: true, projectDocMaxBytes: 32768, onWarning: (warning) => f.warnings.push(warning) });
  assert.deepEqual((await loader.load()).map((file) => file.content), [join(f.root, "repo"), f.cwd, join(f.cwd, "service"), cwd]);
});

test("without Git, only workspace and its descendants load; overrides, empty files and non-files are ignored", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "repo", "AGENTS.md"), "Parent without Git.");
  await writeFile(join(f.cwd, "AGENTS.override.md"), "Override must be ignored.");
  await writeFile(join(f.cwd, "AGENTS.md"), " \n\t");
  await mkdir(join(f.cwd, "a", "AGENTS.md"), { recursive: true });
  await mkdir(join(f.cwd, "a", "deep"));
  await writeFile(join(f.cwd, "a", "deep", "AGENTS.md"), "Deep rule.");
  assert.deepEqual((await f.loader().load()).map((file) => file.content), ["Deep rule."]);
});

test("project files share a byte budget; global contents and formatting do not consume it", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "AGENTS.md"), "g".repeat(40 * 1024));
  await writeFile(join(f.cwd, "AGENTS.md"), "root");
  await mkdir(join(f.cwd, "a"));
  await mkdir(join(f.cwd, "b"));
  await writeFile(join(f.cwd, "a", "AGENTS.md"), "中文");
  await writeFile(join(f.cwd, "b", "AGENTS.md"), "Must not load.");
  const loader = f.loader(true, 7);
  assert.deepEqual((await loader.load()).map((file) => file.content), ["g".repeat(40 * 1024), "root", "中"]);
  assert.match(f.warnings[0] ?? "", /remaining 3-byte budget; truncating/);
  await loader.load();
  assert.equal(f.warnings.length, 1);
  await writeFile(join(f.cwd, "a", "AGENTS.md"), "中");
  await loader.load();
  await writeFile(join(f.cwd, "a", "AGENTS.md"), "中文");
  await loader.load();
  assert.equal(f.warnings.length, 2);
});

test("default project cap is 32 KiB, with no independent file cap or model-visible truncation suffix", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "AGENTS.md"), "x".repeat(80 * 1024));
  assert.equal((await f.loader().load())[0]?.content, "x".repeat(32 * 1024));
  assert.equal((await f.loader(true, 72 * 1024).load())[0]?.content, "x".repeat(72 * 1024));
});

test("untrusted workspaces and a zero project budget still receive global instructions", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "AGENTS.md"), "Global.");
  await writeFile(join(f.cwd, "AGENTS.md"), "Project.");
  for (const loader of [f.loader(false), f.loader(true, 0)]) {
    assert.deepEqual(await loader.load(), [{ kind: "global", path: join(f.home, "AGENTS.md"), content: "Global." }]);
  }
  await unlink(join(f.home, "AGENTS.md"));
  assert.deepEqual(await f.loader(false).load(), []);
});

test("instruction creation, modification and deletion refresh without retaining removed sources", async (t) => {
  const f = await fixture(t);
  const loader = f.loader();
  assert.deepEqual(await loader.load(), []);
  await writeFile(join(f.home, "AGENTS.md"), "Global A.");
  await mkdir(join(f.cwd, "new"));
  await writeFile(join(f.cwd, "new", "AGENTS.md"), "Child A.");
  assert.deepEqual((await loader.load()).map((file) => file.content), ["Global A.", "Child A."]);
  await writeFile(join(f.home, "AGENTS.md"), "Global B.");
  await unlink(join(f.cwd, "new", "AGENTS.md"));
  assert.deepEqual((await loader.load()).map((file) => file.content), ["Global B."]);
  await unlink(join(f.home, "AGENTS.md"));
  assert.deepEqual(await loader.load(), []);
});

test("directory links cannot recurse in cycles or escape the workspace; instruction file links are supported", async (t) => {
  const f = await fixture(t);
  const child = join(f.cwd, "child");
  await mkdir(child);
  await writeFile(join(child, "AGENTS.md"), "Child.");
  await symlink(child, join(f.cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  await symlink(f.cwd, join(child, "loop"), process.platform === "win32" ? "junction" : "dir");
  await symlink(f.home, join(f.cwd, "external"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(f.home, "AGENTS.md"), "Global.");
  const instructions = await f.loader().load();
  assert.deepEqual(instructions.map((file) => file.content), ["Global.", "Child."]);
  const childRule = instructions.find((file) => file.content === "Child.");
  assert.ok(childRule?.kind === "project");
  assert.equal(childRule.scope, child);
  if (process.platform !== "win32") {
    await writeFile(join(f.cwd, "target"), "Linked file.");
    await symlink(join(f.cwd, "target"), join(f.cwd, "AGENTS.md"));
    assert.deepEqual((await f.loader().load()).map((file) => file.content), ["Global.", "Linked file.", "Child."]);
  }
});

test("global read failures retain the last successful value, warn once and recover", async (t) => {
  const f = await fixture(t);
  const loader = f.loader();
  await writeFile(join(f.home, "AGENTS.md"), "Global.");
  await writeFile(join(f.cwd, "AGENTS.md"), "Project.");
  await loader.load();
  const release = await makeUnreadable(t, join(f.home, "AGENTS.md"));
  try {
    assert.deepEqual((await loader.load()).map((file) => file.content), ["Global.", "Project."]);
    assert.match(f.warnings[0] ?? "", /retaining the last successful value/);
    await loader.load();
    assert.equal(f.warnings.length, 1);
  } finally { await release(); }
  await loader.load();
  await unlink(join(f.home, "AGENTS.md"));
  assert.deepEqual((await loader.load()).map((file) => file.content), ["Project."]);
});

test("project read failures omit the entire project set while retaining global rules, then recover", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "AGENTS.md"), "Global.");
  await writeFile(join(f.cwd, "AGENTS.md"), "Workspace.");
  await mkdir(join(f.cwd, "child"));
  const path = join(f.cwd, "child", "AGENTS.md");
  await writeFile(path, "Child.");
  const loader = f.loader();
  await loader.load();
  const release = await makeUnreadable(t, path);
  try {
    assert.deepEqual((await loader.load()).map((file) => file.content), ["Global."]);
    assert.match(f.warnings[0] ?? "", /project instructions are omitted/);
  } finally { await release(); }
  assert.deepEqual((await loader.load()).map((file) => file.content), ["Global.", "Workspace.", "Child."]);
});

test("settings validate and persist the project instruction byte budget", async (t) => {
  const f = await fixture(t);
  assert.equal(loadConfig(f.home).projectDocMaxBytes, 32768);
  saveConfig(f.home, { ...loadConfig(f.home), projectDocMaxBytes: 65536 });
  assert.equal(loadConfig(f.home).projectDocMaxBytes, 65536);
  for (const projectDocMaxBytes of [-1, 1.5, "65536"]) {
    await writeFile(join(f.home, "settings.json"), JSON.stringify({ projectDocMaxBytes }));
    assert.throws(() => loadConfig(f.home), /Cannot load ArkCode settings/);
  }
});

test("cancelled discovery does not emit warnings or return a partial snapshot", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.loader().load(AbortSignal.abort()), { name: "AbortError" });
  assert.deepEqual(f.warnings, []);
});
