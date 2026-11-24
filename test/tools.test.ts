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

test("independent tool sets for overlapping workspaces share Pi's queue for the same file", async () => {
  const files = await fixture();
  const child = join(files.cwd, "child");
  await mkdir(child);
  const shells = [new ManagedShell(files.cwd), new ManagedShell(child)];
  try {
    const sets = [files.cwd, child].map((cwd, index) => createTools({ cwd, shell: shells[index]!, authorize: async () => true }));
    const call = async (index: number, name: string, params: unknown) => {
      const tool = sets[index]?.find((tool) => tool.name === name);
      assert.ok(tool);
      return executeTool(tool, `session-${index}`, params);
    };
    const path = join(child, "shared.txt");
    await writeFile(path, "alpha=0\nbeta=0\n");
    await Promise.all([
      call(0, "edit", { path: "child/shared.txt", edits: [{ oldText: "alpha=0", newText: "alpha=1" }] }),
      call(1, "edit", { path: "shared.txt", edits: [{ oldText: "beta=0", newText: "beta=2" }] }),
    ]);
    assert.equal(await readFile(path, "utf8"), "alpha=1\nbeta=2\n");
    const conflicting = await Promise.allSettled([
      call(0, "edit", { path: "child/shared.txt", edits: [{ oldText: "alpha=1", newText: "alpha=3" }] }),
      call(1, "edit", { path: "shared.txt", edits: [{ oldText: "alpha=1", newText: "alpha=4" }] }),
    ]);
    assert.equal(conflicting.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(conflicting.filter((item) => item.status === "rejected").length, 1);
  } finally { await Promise.all(shells.map((shell) => shell.stopAll())); await files.cleanup(); }
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
    await call("write", { path: "source.txt", content: "first\nsecond\n" });
    await call("edit", { path: "source.txt", oldText: "second", newText: "changed" });
    assert.equal(await readFile(join(files.cwd, "source.txt"), "utf8"), "first\nchanged\n");
    const read = await call("read", { path: "source.txt", offset: 2, limit: 1 });
    const expectedRead = "changed\n\n[1 more lines in file. Use offset=3 to continue.]";
    assert.deepEqual(read, { content: [{ type: "text", text: expectedRead }], details: undefined, structuredContent: expectedRead });
    await call("write", { path: "repeat.txt", content: "same same" });
    await assert.rejects(call("edit", { path: "repeat.txt", oldText: "same", newText: "other" }), /occurrences|unique/);
    await assert.rejects(workspacePath(files.cwd, "../outside.txt"), /limited/);
    await assert.rejects(call("write", { path: ".git/config", content: "bad" }), /Protected/);
    await assert.rejects(call("write", { path: ".GIT/config", content: "bad" }), /Protected/);
    const denied = createTools({ cwd: files.cwd, shell, authorize: async () => false }).find((tool) => tool.name === "write");
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

test("concurrent SDK edits to the same file preserve both changes", async (t) => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  t.after(async () => { await shell.stopAll(); await files.cleanup(); });
  await writeFile(join(files.cwd, "source.txt"), "first\nsecond\n");
  const edit = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "edit");
  assert.ok(edit);
  await Promise.all([
    executeTool(edit, "first", { path: "source.txt", oldText: "first", newText: "changed first" }),
    executeTool(edit, "second", { path: join(files.cwd, "source.txt"), oldText: "second", newText: "changed second" }),
  ]);
  assert.equal(await readFile(join(files.cwd, "source.txt"), "utf8"), "changed first\nchanged second\n");
});

test("Write returns real changes for new files and overwrites without changing its model-facing receipt", async (t) => {
  const files = await fixture();
  t.after(() => files.cleanup());
  const shell = new ManagedShell(files.cwd);
  t.after(() => shell.stopAll());
  const write = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "write");
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
    const find = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "glob");
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
    const edit = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "edit");
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
    const read = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "read");
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
    const grep = tools.find((tool) => tool.name === "grep");
    const find = tools.find((tool) => tool.name === "glob");
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
    const grep = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "grep");
    assert.ok(grep);
    for (const context of [0, 1]) {
      const result = JSON.stringify(await executeTool(grep, `size-${context}`, { pattern: "needle", context }));
      assert.match(result, /small.txt/);
      assert.doesNotMatch(result, /large.txt|unable to read/);
    }
  } finally { await shell.stopAll(); await files.cleanup(); }
});

test("SDK shell tool returns Chinese output intact in model content and session details", { skip: process.platform !== "win32" }, async (t) => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd, "powershell.exe");
  t.after(async () => { await shell.stopAll(); await files.cleanup(); });
  const tool = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((entry) => entry.name === "bash");
  assert.ok(tool);
  const result = z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    details: z.object({ output: z.string(), exitCode: z.number() }),
  }).parse(await executeTool(tool, "unicode", { command: '\'今天：中文输出 😀\'' }));
  assert.ok(result.content[0]?.text.includes("今天：中文输出 😀\r\n"));
  assert.match(result.content[0]?.text ?? "", /Status: completed/);
  assert.equal(result.details.output, "今天：中文输出 😀\r\n");
  assert.equal(result.details.exitCode, 0);
});

test("SDK shell provides structured output beyond the bounded process receipt", { timeout: 15000 }, async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    const bash = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "bash");
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

test("approval requests identify exact write content and shell commands", async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  const requests: ApprovalRequest[] = [];
  try {
    const tools = createTools({ cwd: files.cwd, shell, authorize: async (request) => { requests.push(request); return false; } });
    const write = tools.find((tool) => tool.name === "write");
    const bash = tools.find((tool) => tool.name === "bash");
    assert.ok(write);
    assert.ok(bash);
    await assert.rejects(executeTool(write, "first", { path: "file.txt", content: "first" }), /denied/);
    await assert.rejects(executeTool(write, "second", { path: "file.txt", content: "second" }), /denied/);
    const denied = z.object({ isError: z.literal(true), structuredContent: z.object({ kind: z.literal("error"), error: z.object({ code: z.literal("permission_denied") }) }) });
    denied.parse(await executeTool(bash, "third", { command: "node --version" }));
    denied.parse(await executeTool(bash, "fourth", { command: "node -e \"console.log('different command')\"" }));
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

test("bash and nonzero exit retain structured session outcomes and real exit codes", { timeout: 15000 }, async () => {
  const files = await fixture();
  const shell = new ManagedShell(files.cwd);
  try {
    const bash = createTools({ cwd: files.cwd, shell, authorize: async () => true }).find((tool) => tool.name === "bash");
    assert.ok(bash);
    const failedReceipt = z.object({ isError: z.undefined().optional(), content: z.array(z.object({ type: z.literal("text"), text: z.string() })), details: z.object({ exitCode: z.number().nullable(), status: z.string() }), structuredContent: z.object({ kind: z.literal("session"), status: z.string(), exit_code: z.number().nullable() }) });
    const failure = failedReceipt.parse(await executeTool(bash, "failure", { command: "node -e \"process.exit(9)\"" }));
    assert.equal(failure.isError, undefined);
    assert.equal(failure.details.exitCode, 9);
    assert.equal(failure.structuredContent.status, "failed");
    assert.match(JSON.stringify(failure.content), /Exit code: 9/);
    assert.equal(shell.list().filter((entry) => entry.status === "running").length, 0);
  } finally { await shell.stopAll(); await files.cleanup(); }
});

