import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../src/domain.js";
import { createTools, ManagedShell, workspacePath } from "../src/tools.js";
import { getBranch } from "../src/review.js";

const execute = promisify(execFile);

async function executeTool(tool: ToolDefinition, id: string, params: unknown): Promise<unknown> {
  return Reflect.apply(tool.execute, tool, [id, params, undefined, undefined]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "arkcode-tools-"));
  const cwd = join(root, "中文工作区");
  await mkdir(cwd);
  return {
    root, cwd,
    async cleanup() {
      assert.ok(resolve(root).startsWith(resolve(tmpdir(), "arkcode-tools-")));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Git branch status works without a commit and outside a repository", async () => {
  const files = await fixture();
  try {
    assert.equal(await getBranch(files.cwd), "No Git");
    await execute("git", ["init", "--initial-branch=arkcode-test"], { cwd: files.cwd, windowsHide: true });
    assert.equal(await getBranch(files.cwd), "arkcode-test");
  } finally { await files.cleanup(); }
});

test("file tools preserve exact edits and reject duplicate or denied writes", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    const tools = createTools({ cwd: files.cwd, shell, authorize: async () => true });
    const call = async (name: string, params: unknown) => {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool);
      return executeTool(tool, "call", params);
    };
    await call("Write", { path: "source.txt", content: "first\nsecond\n" });
    await call("Edit", { path: "source.txt", oldText: "second", newText: "changed" });
    assert.equal(await readFile(join(files.cwd, "source.txt"), "utf8"), "first\nchanged\n");
    const read = await call("Read", { path: "source.txt", offset: 2, limit: 1 });
    assert.deepEqual(read, { content: [{ type: "text", text: "2: changed\n[Continue with offset 3; 3 total lines]" }], details: {} });
    await call("Write", { path: "repeat.txt", content: "same same" });
    await assert.rejects(call("Edit", { path: "repeat.txt", oldText: "same", newText: "other" }), /more than once/);
    await assert.rejects(workspacePath(files.cwd, "../outside.txt"), /limited/);
    await assert.rejects(call("Write", { path: ".git/config", content: "bad" }), /Protected/);
    await assert.rejects(call("Write", { path: ".GIT/config", content: "bad" }), /Protected/);
    const denied = createTools({ cwd: files.cwd, shell, authorize: async () => false }).find((tool) => tool.name === "Write");
    assert.ok(denied);
    await assert.rejects(executeTool(denied, "denied", { path: "blocked.txt", content: "bad" }), /denied/);
    await assert.rejects(readFile(join(files.cwd, "blocked.txt")), /ENOENT/);
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("file tools reject symlinks to outside and protected metadata", async () => {
  const files = await fixture();
  try {
    await mkdir(join(files.cwd, ".git"));
    await writeFile(join(files.cwd, ".git", "config"), "protected");
    await mkdir(join(files.root, "outside"));
    await symlink(join(files.root, "outside"), join(files.cwd, "outside-link"), "junction");
    await symlink(join(files.cwd, ".git"), join(files.cwd, "metadata-link"), "junction");
    await assert.rejects(workspacePath(files.cwd, "outside-link/new.txt", true), /outside/);
    await assert.rejects(workspacePath(files.cwd, "metadata-link/config", true), /protected/);
  } finally { await files.cleanup(); }
});

test("find supports globstar, character classes and brace alternatives", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    await mkdir(join(files.cwd, "src"));
    await writeFile(join(files.cwd, "src", "a.ts"), "export const a = 1;");
    await writeFile(join(files.cwd, "src", "b.js"), "export const b = 1;");
    await writeFile(join(files.cwd, "src", "c.txt"), "text");
    const find = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Glob");
    assert.ok(find);
    const output = await executeTool(find, "glob", { pattern: "**/[ab].{ts,js}" });
    assert.deepEqual(output, { content: [{ type: "text", text: "src/a.ts\nsrc/b.js" }], details: {} });
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("approval requests identify exact write content and shell timeout", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  const requests: ApprovalRequest[] = [];
  try {
    const tools = createTools({ cwd: files.cwd, shell, authorize: async (request) => { requests.push(request); return false; } });
    const write = tools.find((tool) => tool.name === "Write");
    const bash = tools.find((tool) => tool.name === "Bash");
    assert.ok(write);
    assert.ok(bash);
    await assert.rejects(executeTool(write, "first", { path: "file.txt", content: "first" }), /denied/);
    await assert.rejects(executeTool(write, "second", { path: "file.txt", content: "second" }), /denied/);
    await assert.rejects(executeTool(bash, "third", { command: "node --version", timeout: 1 }), /denied/);
    await assert.rejects(executeTool(bash, "fourth", { command: "node --version", timeout: 2 }), /denied/);
    assert.notEqual(requests[0]?.description, requests[1]?.description);
    assert.notEqual(requests[2]?.description, requests[3]?.description);
    assert.equal(shell.list().length, 0);
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("managed native shell records exit codes and waits for descendant cancellation", { timeout: 15000 }, async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    const failure = await shell.execute("node -e \"process.exit(7)\"");
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.status, "failed");
    const running = shell.execute("node -e \"console.log(process.pid);setTimeout(()=>{},30000)\"");
    for (let attempt = 0; attempt < 40 && !shell.list().some((receipt) => /^\d+/m.test(receipt.output)); attempt++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await shell.stopAll();
    const receipt = await running;
    assert.equal(receipt.status, "cancelled");
    assert.ok(receipt.endedAt);
    assert.equal(shell.list().filter((entry) => entry.status === "running").length, 0);
    const descendantPid = Number(receipt.output.trim());
    assert.ok(descendantPid > 0);
    assert.throws(() => process.kill(descendantPid, 0));
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("bash timeout and nonzero exit report a failed tool result", { timeout: 15000 }, async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    const bash = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Bash");
    assert.ok(bash);
    const failedReceipt = z.object({ isError: z.literal(true), content: z.array(z.object({ type: z.literal("text"), text: z.string() })), details: z.object({ exitCode: z.number().nullable(), status: z.string() }) });
    const failure = failedReceipt.parse(await executeTool(bash, "failure", { command: "node -e \"process.exit(9)\"" }));
    assert.equal(failure.isError, true);
    assert.equal(failure.details.exitCode, 9);
    assert.match(JSON.stringify(failure.content), /exit code 9/);
    const timeout = failedReceipt.parse(await executeTool(bash, "timeout", { command: "node -e \"setTimeout(()=>{},30000)\"", timeout: 1 }));
    assert.equal(timeout.isError, true);
    assert.equal(timeout.details.status, "cancelled");
    assert.match(JSON.stringify(timeout.content), /cancelled/);
    assert.equal(shell.list().filter((entry) => entry.status === "running").length, 0);
  } finally { await shell.stopAll(); await files.cleanup(); }
});

