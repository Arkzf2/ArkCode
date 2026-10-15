import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "../src/app/types.js";
import { createTools } from "../src/tools/index.js";
import { ManagedShell } from "../src/tools/shell.js";
import { workspacePath } from "../src/tools/workspace.js";
import { getBranch } from "../src/ui/review.js";

const execute = promisify(execFile);

async function executeTool(tool: ToolDefinition, id: string, params: unknown): Promise<unknown> {
  return Reflect.apply(tool.execute, tool, [id, tool.prepareArguments?.(params) ?? params, undefined, undefined]);
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
    const expectedRead = "changed\n\n[1 more lines in file. Use offset=3 to continue.]";
    assert.deepEqual(read, { content: [{ type: "text", text: expectedRead }], details: undefined, structuredContent: expectedRead });
    await call("Write", { path: "repeat.txt", content: "same same" });
    await assert.rejects(call("Edit", { path: "repeat.txt", oldText: "same", newText: "other" }), /occurrences|unique/);
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

test("Write returns real changes for new files and overwrites without changing its model-facing receipt", async (t) => {
  const files = await fixture();
  t.after(() => files.cleanup());
  const shell = new ManagedShell(files.cwd);
  t.after(() => shell.stopAll());
  const write = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Write");
  assert.ok(write);
  const resultSchema = z.object({ content: z.array(z.object({ text: z.string() })), details: z.object({ diff: z.string() }) });
  const created = resultSchema.parse(await executeTool(write, "new", { path: "preview.txt", content: "first\r\nsecond\r\n" }));
  assert.equal(created.content[0]?.text, "Successfully wrote to preview.txt");
  assert.match(created.details.diff, /\+1 first\n\+2 second/);
  const updated = resultSchema.parse(await executeTool(write, "overwrite", { path: "preview.txt", content: "first\r\nchanged\r\n" }));
  assert.match(updated.details.diff, /-2 second\n\+2 changed/);
  assert.equal(await readFile(join(files.cwd, "preview.txt"), "utf8"), "first\r\nchanged\r\n");
  const large = z.object({ details: z.undefined() }).parse(await executeTool(write, "large", { path: "large.txt", content: "x".repeat(300000) }));
  assert.equal(large.details, undefined);
  assert.equal((await readFile(join(files.cwd, "large.txt"))).length, 300000);
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
    assert.deepEqual(output, { content: [{ type: "text", text: "src/a.ts\nsrc/b.js" }], details: undefined });
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("SDK edit applies disjoint changes against the original file and preserves BOM and CRLF", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    await writeFile(join(files.cwd, "source.txt"), "\uFEFFfirst\r\nsecond\r\nthird\r\n");
    const edit = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Edit");
    assert.ok(edit);
    const output = z.object({ details: z.object({ diff: z.string(), patch: z.string() }) }).parse(await executeTool(edit, "edit", {
      path: "source.txt", edits: [{ oldText: "first", newText: "second" }, { oldText: "third", newText: "last" }],
    }));
    assert.equal(await readFile(join(files.cwd, "source.txt"), "utf8"), "\uFEFFsecond\r\nsecond\r\nlast\r\n");
    assert.match(output.details.patch, /\+last/);
    assert.match(output.details.diff, /last/);
    await assert.rejects(executeTool(edit, "overlap", {
      path: "source.txt", edits: [{ oldText: "second\nsecond", newText: "x" }, { oldText: "second\nlast", newText: "y" }],
    }), /overlap/);
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("SDK read returns a structured image and enforces credential guards", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    await writeFile(join(files.cwd, "pixel.gif"), Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    await writeFile(join(files.cwd, ".env"), "PASSWORD=hidden");
    await writeFile(join(files.cwd, ".env.example"), "PASSWORD=example");
    const read = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Read");
    assert.ok(read);
    const output = z.object({ structuredContent: z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }) }).parse(await executeTool(read, "image", { path: "pixel.gif" }));
    assert.equal(output.structuredContent.mimeType, "image/gif");
    assert.ok(output.structuredContent.data.length > 0);
    await assert.rejects(executeTool(read, "secret", { path: ".env" }), /Credential/);
    const example = z.object({ structuredContent: z.string() }).parse(await executeTool(read, "example", { path: ".env.example" }));
    assert.equal(example.structuredContent, "PASSWORD=example");
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("SDK grep searches with ripgrep while host exclusions override the model glob", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    await mkdir(join(files.cwd, "nested", ".ArKcOdE"), { recursive: true });
    await mkdir(join(files.cwd, "node_modules"));
    await writeFile(join(files.cwd, "source.txt"), "before\nneedle visible\nafter\n");
    await writeFile(join(files.cwd, ".ENV.production"), "needle secret");
    await writeFile(join(files.cwd, "nested", ".ArKcOdE", "state.txt"), "needle metadata");
    await writeFile(join(files.cwd, "node_modules", "dep.txt"), "needle dependency");
    const tools = createTools({ cwd: files.cwd, shell, authorize: async () => true });
    const grep = tools.find((tool) => tool.name === "Grep");
    const find = tools.find((tool) => tool.name === "Glob");
    assert.ok(grep);
    assert.ok(find);
    const result = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
    for (const context of [0, 1]) {
      const output = result.parse(await executeTool(grep, "grep", { pattern: "needle", glob: "**/*", context }));
      const text = output.content.map((entry) => entry.text).join("\n");
      assert.match(text, /source\.txt:2: needle visible/);
      assert.doesNotMatch(text, /secret|metadata|dependency/);
      if (context === 1) assert.match(text, /source\.txt-1- before/);
    }
    await assert.rejects(executeTool(grep, "explicit", { pattern: "needle", path: ".ENV.production" }), /Credential/);
    await assert.rejects(executeTool(grep, "metadata", { pattern: "needle", path: "nested/.ArKcOdE" }), /Protected/);
    const names = result.parse(await executeTool(find, "find", { pattern: "**/*" })).content.map((entry) => entry.text).join("\n");
    assert.equal(names, "source.txt");
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("Grep applies the same file size limit with and without context", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    await writeFile(join(files.cwd, "large.txt"), "needle\n" + "x".repeat(2 * 1024 * 1024));
    await writeFile(join(files.cwd, "small.txt"), "needle\n");
    const grep = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Grep");
    assert.ok(grep);
    for (const context of [0, 1]) {
      const result = JSON.stringify(await executeTool(grep, `size-${context}`, { pattern: "needle", context }));
      assert.match(result, /small.txt/);
      assert.doesNotMatch(result, /large.txt|unable to read/);
    }
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("SDK shell provides structured output beyond the bounded process receipt", { timeout: 15000 }, async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    const bash = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "Bash");
    assert.ok(bash);
    const output = z.object({ structuredContent: z.object({ output: z.string(), exit_code: z.number() }) }).parse(await executeTool(bash, "large", {
      command: "node -e \"process.stdout.write('a'.repeat(150000)+'END')\"",
    }));
    assert.equal(output.structuredContent.exit_code, 0);
    assert.equal(output.structuredContent.output.length, 150003);
    assert.ok(output.structuredContent.output.endsWith("END"));
    assert.equal(shell.list()[0]?.truncated, true);
    assert.equal(shell.list()[0]?.output.length, 128 * 1024);
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
    assert.match(JSON.stringify(failure.content), /exited with code 9/);
    const timeout = failedReceipt.parse(await executeTool(bash, "timeout", { command: "node -e \"setTimeout(()=>{},30000)\"", timeout: 1 }));
    assert.equal(timeout.isError, true);
    assert.equal(timeout.details.exitCode, 130);
    assert.equal(timeout.details.status, "cancelled");
    assert.match(JSON.stringify(timeout.content), /cancelled/);
    assert.equal(shell.list().filter((entry) => entry.status === "running").length, 0);
  } finally { await shell.stopAll(); await files.cleanup(); }
});

