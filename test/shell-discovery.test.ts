import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveShell } from "../src/tools/shell-config.js";
import { ManagedShell } from "../src/tools/shell.js";
import { createTools } from "../src/tools/index.js";
import { inspectShell } from "../src/permissions/shell-policy.js";

async function installation(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "arkcode-shell-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = async (...parts: string[]) => {
    const path = join(root, ...parts);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    return path;
  };
  return { root, file };
}

test("Windows discovers Git Bash beside git.exe in a nonstandard installation with spaces", async (t) => {
  const { root, file } = await installation(t);
  await file("Custom Programs", "Git", "cmd", "git.exe");
  const bash = await file("Custom Programs", "Git", "bin", "bash.exe");
  await file("PowerShell", "pwsh.exe");
  const shell = resolveShell({ platform: "win32", env: { Path: `${join(root, "PowerShell")};"${join(root, "Custom Programs", "Git", "cmd")}"` } });
  assert.deepEqual(shell, { kind: "posix", executable: bash });
});

test("Windows discovers Git Bash from its usr/bin entry or a per-user installation", async (t) => {
  const { root, file } = await installation(t);
  await file("Git", "cmd", "git.exe");
  const bash = await file("Git", "usr", "bin", "bash.exe");
  assert.equal(resolveShell({ platform: "win32", env: { PATH: dirname(bash) } }).executable, bash);
  const local = await file("Local", "Programs", "Git", "bin", "bash.exe");
  assert.equal(resolveShell({ platform: "win32", env: { LOCALAPPDATA: join(root, "Local") } }).executable, local);
  const system = await file("Program Files", "Git", "bin", "bash.exe");
  assert.equal(resolveShell({ platform: "win32", env: { ProgramFiles: join(root, "Program Files") } }).executable, system);
});

test("Windows skips WSL bash and falls back to PowerShell, preferring pwsh", async (t) => {
  const { root, file } = await installation(t);
  await file("Windows", "System32", "bash.exe");
  const powershell = await file("PowerShell", "powershell.exe");
  const env = { PATH: `${join(root, "Windows", "System32")};${dirname(powershell)}` };
  assert.deepEqual(resolveShell({ platform: "win32", env }), { kind: "powershell", executable: powershell });
  const pwsh = await file("PowerShell", "pwsh.exe");
  assert.equal(resolveShell({ platform: "win32", env }).executable, pwsh);
  assert.deepEqual(resolveShell({ platform: "linux", env }), { kind: "posix", executable: "/bin/sh" });
});

test("discovered Git Bash runs Chinese output in a Unicode workspace and exposes matching tool metadata", { skip: process.platform !== "win32" }, async (t) => {
  const { root } = await installation(t);
  const cwd = join(root, "中文 workspace");
  await mkdir(cwd);
  const shell = new ManagedShell(cwd);
  if (shell.kind !== "posix") { t.skip("Git Bash is not installed"); return; }
  t.after(() => shell.stopAll());
  const receipt = await shell.execute("printf '%s\\n' '中文 Bash 😀' \"$BASH_VERSION\" \"$OSTYPE\"");
  assert.equal(receipt.status, "completed", receipt.output);
  assert.match(receipt.output, /^中文 Bash 😀\n\d+\.\d+.*\n(?:msys|cygwin)\n$/);
  assert.equal(receipt.shell, shell.executable);
  const tool = createTools({ cwd, shell, authorize: async () => true }).find((entry) => entry.name === "bash");
  assert.ok(tool);
  assert.match(tool.description, /Execute a bash command/i);
  assert.match(tool.promptSnippet ?? "", /bash/i);
  assert.ok(!tool.description.includes(shell.executable));
  assert.ok(!shell.instructions.includes(JSON.stringify(shell.executable)));
  assert.equal((await inspectShell("ls", shell.executable)).listing, true);
});

test("explicit PowerShell still runs with UTF-8 and exposes PowerShell metadata", { skip: process.platform !== "win32" }, async (t) => {
  const shell = new ManagedShell(process.cwd(), "powershell.exe");
  t.after(() => shell.stopAll());
  const receipt = await shell.execute("[Console]::Write('中文 PowerShell 😀')");
  assert.equal(receipt.output, "中文 PowerShell 😀");
  assert.equal(receipt.exitCode, 0);
  const tool = createTools({ cwd: shell.cwd, shell, authorize: async () => true }).find((entry) => entry.name === "bash");
  assert.ok(tool);
  assert.match(tool.description, /Execute a PowerShell command/);
  assert.match(tool.promptSnippet ?? "", /PowerShell/);
  assert.match(shell.instructions, /Use PowerShell syntax/);
});

test("a session's shell configuration cannot be mutated or replaced", () => {
  const shell = new ManagedShell(process.cwd());
  const selected = shell.configuration;
  assert.equal(Object.isFrozen(selected), true);
  assert.throws(() => Object.assign(selected, { executable: "other-shell.exe" }), TypeError);
  assert.throws(() => Object.assign(shell, { configuration: resolveShell({ executable: "other-shell.exe" }) }), TypeError);
  assert.equal(shell.configuration, selected);
});

test("a failed shell launch does not silently switch the interpreter", async (t) => {
  const { root } = await installation(t);
  const executable = join(root, "missing-bash.exe");
  const shell = new ManagedShell(root, executable);
  t.after(() => shell.stopAll());
  const receipt = await shell.execute("echo must-not-run-in-another-shell");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.shell, executable);
  assert.equal(shell.executable, executable);
});
