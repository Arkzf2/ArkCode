import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { Value } from "typebox/value";
import { z } from "zod";
import { createTools } from "../src/tools/index.js";
import { ManagedShell, ShellOperationError } from "../src/tools/shell.js";
import { ToolOutputFiles } from "../src/tools/output-files.js";
import { ShellOutput } from "../src/tools/shell-output.js";
import { createOutputCleaner } from "../src/tools/output.js";
import { bashInputSchema, shellControlInputSchema, shellResultSchema, parseShellArguments, ShellArgumentError } from "../src/tools/shell-contract.js";

async function fixture(t: TestContext, executable?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-control-test-"));
  const shell = new ManagedShell(cwd, executable);
  const files = new ToolOutputFiles();
  t.after(async () => { await shell.endRun(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, shell, files, tools: createTools({ cwd, shell, outputFiles: files, authorize: async () => true }) };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(25); }
  throw new Error("Timed out waiting for real process readiness.");
}
const worker = `process.stdin.setEncoding('utf8');process.stdout.write('READY\\n');process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));process.stdin.on('end',()=>{process.stdout.write('EOF\\n');process.exit(0)});`;
const command = (source: string) => `node -e "${source}"`;

test("capture preserves exact preview boundaries and the tail of oversized UTF-8 lines", async (t) => {
  for (const body of ["x".repeat(51200), "line\n".repeat(2000)]) {
    const log = await ShellOutput.create(); t.after(() => log.close());
    log.append(body);
    const result = await log.project({ bytes: 0, newlines: 0, openLine: false }, true);
    assert.equal(result.display.truncated, false);
    assert.equal(result.display.content, body);
    assert.equal(result.outputFile, undefined);
  }
  const body = "中🙂".repeat(40000) + "END\n";
  const log = await ShellOutput.create(); t.after(() => log.close());
  log.append(body);
  const result = await log.project({ bytes: 0, newlines: 0, openLine: false }, true);
  assert.equal(result.display.truncated, true);
  assert.equal(result.display.lastLinePartial, true);
  assert.ok(Buffer.byteLength(result.display.content) <= 51200);
  assert.match(result.display.content, /END$/);
  assert.doesNotMatch(result.display.content, /\ufffd/);
  assert.equal(result.display.startLine, 1);
  assert.equal(result.output, body);
  assert.ok(result.outputFile);
  assert.equal(await readFile(result.outputFile, "utf8"), body);
});

test("shell output cleaning retains text across split ANSI escape sequences", () => {
  const clean = createOutputCleaner();
  const result = ["before\x1b[", "31m红色\x1b[0", "m\x1b]52;c;hidden", "\x1b", "\\after"].map(clean).join("");
  assert.equal(result, "before红色after");
});

test("shell schemas enforce exact timing, operation fields, input presence and byte size before effects", () => {
  for (const yield_time_ms of [0, 9999, 60001, 10000.5, "10000", null]) assert.throws(() => parseShellArguments(bashInputSchema, { command: "echo ok", yield_time_ms }));
  for (const yield_time_ms of [10000, 60000]) assert.ok(parseShellArguments(bashInputSchema, { command: "echo ok", yield_time_ms }));
  assert.deepEqual(parseShellArguments(bashInputSchema, { command: "echo ok" }), { command: "echo ok", io_mode: "pipe", yield_time_ms: 10000 });
  let removedTimeout: unknown;
  try { parseShellArguments(bashInputSchema, { command: "echo ok", timeout: 1 }); }
  catch (error) { removedTimeout = error; }
  assert.ok(removedTimeout instanceof ShellArgumentError);
  assert.equal(removedTimeout.field, "timeout");
  assert.match(removedTimeout.hint ?? "", /Omit timeout/);
  for (const yield_time_ms of [0, 499, 300001, 10000.5]) assert.throws(() => parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", yield_time_ms }));
  for (const yield_time_ms of [10000, 300000]) assert.ok(parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", yield_time_ms }));
  for (const yield_time_ms of [0, 499, 60001, 10000.5]) assert.throws(() => parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", chars: "x", yield_time_ms }));
  for (const yield_time_ms of [500, 60000]) assert.ok(parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", chars: "x", yield_time_ms }));
  for (const chars of [" ", "\n"]) assert.ok(parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", chars }));
  assert.ok(parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", eof: true }));
  assert.deepEqual(parseShellArguments(shellControlInputSchema, { session_id: "s" }), { action: "wait", session_id: "s", yield_time_ms: 10000 });
  assert.deepEqual(parseShellArguments(shellControlInputSchema, { session_id: "s", wait_ms: 60000 }), { action: "wait", session_id: "s", yield_time_ms: 60000 });
  assert.deepEqual(parseShellArguments(shellControlInputSchema, { action: "send", session_id: "s", data: "x" }), { action: "wait", session_id: "s", chars: "x", yield_time_ms: 500 });
  for (const params of [
    { action: "send", session_id: "s" }, { action: "send", session_id: "s", data: "" },
    { action: "wait", session_id: "s", chars: "中".repeat(22000) },
    { action: "wait", session_id: "s", chars: "x", yield_time_ms: 499 },
    { action: "stop", session_id: "s", yield_time_ms: 5000 },
    { action: "wait", session_id: "s", max_output_tokens: 10000 },
  ]) assert.throws(() => parseShellArguments(shellControlInputSchema, params));
});

test("shell argument and operation errors identify the repair", async (t) => {
  let caught: unknown;
  try { parseShellArguments(shellControlInputSchema, { action: "wait", session_id: "s", chars: "x", yield_time_ms: 499 }); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof ShellArgumentError);
  const invalid = caught;
  assert.match(invalid.message, /between 500 and 60000/);
  assert.equal(invalid.field, "yield_time_ms");
  assert.ok(invalid.hint);
  assert.match(invalid.hint, /inclusive range/);
  const { cwd, shell } = await fixture(t);
  const tool = createTools({ cwd, shell, authorize: async () => true }).find(candidate => candidate.name === "shell_control");
  assert.ok(tool);
  const result = await Reflect.apply(tool.execute, tool, ["invalid", { action: "wait", session_id: "s", yield_time_ms: 500 }]);
  const parsed = z.object({ isError: z.literal(true), structuredContent: z.object({ kind: z.literal("error"), error: z.object({
    code: z.literal("invalid_arguments"), field: z.literal("yield_time_ms"), hint: z.string(), retryable: z.literal(true), message: z.string(),
  }) }) }).parse(result);
  assert.match(parsed.structuredContent.error.message, /10000 and 300000/);
});

test("shell handoff names the requested window and finished waits report only this call's seconds", { timeout: 10000 }, async (t) => {
  const { shell } = await fixture(t);
  const started = await shell.launch({ command: command("setTimeout(()=>console.log('FINISHED'),1200)"), yield_time_ms: 50 });
  const id = started.result.session_id;
  assert.match(id, /^sh_[a-f0-9]{8}$/);
  assert.equal(started.result.status, "running");
  assert.equal(started.result.wake_reason, "wait_limit");
  assert.match(started.result.message ?? "", /after the 50ms observation window/);
  assert.ok(started.result.message?.includes(id));
  assert.match(started.result.message ?? "", /shell_control.*wait.*Do not launch the command again/);
  assert.ok(started.text.includes(started.result.message ?? "missing continuation guidance"));
  assert.match(started.text, /Wall time: \d+\.\d{3} seconds/);
  assert.ok(started.result.wall_time_seconds >= 0.05);
  assert.ok(Value.Check(shellResultSchema, started.result));
  for (const key of ["waited_ms", "elapsed_ms", "shell", "cwd"]) assert.equal(key in started.result, false);

  await until(() => shell.list()[0]?.status === "completed");
  const ended = await shell.control({ action: "wait", session_id: id, yield_time_ms: 300000 }, { signal: AbortSignal.timeout(1500) });
  assert.equal(ended.result.status, "completed");
  assert.equal(ended.result.output, "FINISHED\n");
  assert.equal(ended.result.wake_reason, "exit");
  assert.equal(ended.result.message, undefined);
  assert.doesNotMatch(ended.text, /still running|observation window/);
  assert.ok(ended.result.wall_time_seconds < 1);
  assert.ok(Value.Check(shellResultSchema, ended.result));

  await shell.endRun();
  await assert.rejects(shell.control({ action: "wait", session_id: id }), error => error instanceof ShellOperationError && error.code === "session_expired");
  const next = await shell.launch({ command: command("console.log('NEXT')") });
  assert.match(next.result.session_id, /^sh_[a-f0-9]{8}$/);
  assert.notEqual(next.result.session_id, id);
});

test("PTY sessions accept chars and report that EOF is unsupported", { timeout: 15000 }, async (t) => {
  const { shell, tools } = await fixture(t);
  const interactive = `process.stdin.setEncoding('utf8');process.stdout.write('READY\\n');process.stdin.once('data',d=>{process.stdout.write('INPUT:'+d);process.exit(0)});`;
  const started = await shell.launch({ command: command(interactive), io_mode: "pty", yield_time_ms: 500 });
  assert.equal(started.result.status, "running");
  const sent = await shell.control({ action: "wait", session_id: started.result.session_id, chars: "go\r\n", yield_time_ms: 3000 });
  assert.equal(sent.result.status, "completed");
  assert.equal(sent.result.input?.state, "accepted");
  assert.match(sent.result.output, /INPUT:go/);

  const waiting = await shell.launch({ command: command("setTimeout(()=>{},10000)"), io_mode: "pty", yield_time_ms: 100 });
  const control = tools.find(tool => tool.name === "shell_control");
  assert.ok(control);
  const eofResult = await Reflect.apply(control.execute, control, ["pty-eof", { action: "wait", session_id: waiting.result.session_id, eof: true }]);
  const eofError = z.object({ isError: z.literal(true), structuredContent: z.object({
    kind: z.literal("error"), error: z.object({ code: z.literal("eof_not_supported"), hint: z.string(), retryable: z.literal(true) }),
    input: z.object({ state: z.literal("not_sent") }),
  }) }).parse(eofResult);
  assert.match(eofError.structuredContent.error.hint, /chars/);
  await shell.control({ action: "stop", session_id: waiting.result.session_id });
});

for (const executable of [undefined, ...(process.platform === "win32" ? ["powershell.exe"] : [])]) {
  test(`real redirected input and EOF work with ${executable ?? "selected shell"}`, async (t) => {
    const { shell } = await fixture(t, executable);
    const eofOnlyStart = await shell.launch({ command: command(worker), io_mode: "pipe", yield_time_ms: 200 });
    const eofOnly = await shell.control({ action: "wait", session_id: eofOnlyStart.result.session_id, eof: true });
    assert.equal(eofOnly.result.status, "completed");
    assert.equal(eofOnly.result.stdin_open, false);
    assert.equal(eofOnly.result.input?.state, "accepted");
    assert.match(eofOnly.result.output, /EOF\n$/);

    const started = await shell.launch({ command: command(worker), io_mode: "pipe", yield_time_ms: 200 });
    assert.equal(started.result.status, "running");
    const id = started.result.session_id;
    const sent = await shell.control({ action: "wait", session_id: id, chars: "中文🙂\n", eof: true });
    assert.equal(sent.result.status, "completed");
    assert.equal(sent.result.stdin_open, false);
    assert.equal(sent.result.input?.state, "accepted");
    assert.match(sent.result.output, /INPUT:中文🙂\nEOF/);
    assert.ok(Value.Check(shellResultSchema, sent.result));
    assert.equal((await shell.control({ action: "wait", session_id: id })).result.output, "");
    await assert.rejects(shell.control({ action: "wait", session_id: id, chars: "again" }), error => error instanceof ShellOperationError && error.delivery === "not_sent");
  });
}

test("wait batches progress, steering releases observation, and input/stop remain usable during wait", async (t) => {
  const { shell } = await fixture(t);
  const started = await shell.launch({ command: command(worker), io_mode: "pipe", yield_time_ms: 50 });
  const id = started.result.session_id;
  const waiting = shell.control({ action: "wait", session_id: id, yield_time_ms: 10000 });
  await assert.rejects(shell.control({ action: "wait", session_id: id }), /Another wait/);
  const sent = await shell.control({ action: "wait", session_id: id, chars: "ping\n", yield_time_ms: 500 });
  assert.equal(sent.result.status, "running");
  assert.match(sent.result.output, /INPUT:ping/);
  shell.steer();
  const steered = await waiting;
  assert.equal(steered.result.wake_reason, "user_steer");
  assert.equal(steered.result.output, "");
  assert.match(steered.result.message ?? "", /still running; session_id:/);
  assert.doesNotMatch(steered.result.message ?? "", /observation window/);
  const nextWait = shell.control({ action: "wait", session_id: id });
  const stopped = await shell.control({ action: "stop", session_id: id });
  assert.equal(stopped.result.status, "cancelled");
  assert.equal((await nextWait).result.status, "cancelled");
  const again = await shell.control({ action: "stop", session_id: id });
  assert.equal(again.result.status, "cancelled");
  assert.equal(again.result.output, "");
});

test("denied input has no effect and duplicate control call ids do not resend input", async (t) => {
  const { cwd, shell } = await fixture(t);
  const started = await shell.launch({ command: command(worker), io_mode: "pipe", yield_time_ms: 200 });
  const deniedTools = createTools({ cwd, shell, authorize: async () => false });
  const tool = deniedTools.find(tool => tool.name === "shell_control"); assert.ok(tool);
  const denied = await Reflect.apply(tool.execute, tool, ["denied", { action: "wait", session_id: started.result.session_id, chars: "DENIED\n" }]);
  const parsed = z.object({ isError: z.literal(true), structuredContent: z.object({ input: z.object({ state: z.literal("not_sent") }) }) }).parse(denied);
  assert.equal(parsed.isError, true);
  const send = () => shell.control({ action: "wait", session_id: started.result.session_id, chars: "ONCE\n", eof: true });
  const [first, repeated] = await Promise.all([shell.once("same-call", send), shell.once("same-call", send)]);
  assert.deepEqual(first, repeated);
  assert.doesNotMatch(first.result.output, /DENIED/);
  assert.equal(first.result.output.match(/INPUT:ONCE/g)?.length, 1);
  const other = await fixture(t);
  await assert.rejects(other.shell.control({ action: "stop", session_id: started.result.session_id }), error => error instanceof ShellOperationError && error.code === "session_not_found");
});

test("truncated live output yields an immutable readable prefix and later waits contain only new output", async (t) => {
  const { shell, files } = await fixture(t);
  const source = `for(let i=1;i<=2500;i++)console.log('line '+i);process.stdin.once('data',()=>{console.log('LATER');process.exit(0)});require('fs').writeFileSync('ready','yes');`;
  const first = await shell.launch({ command: command(source), io_mode: "pipe", yield_time_ms: 500 }, { exportFile: path => files.capture("shell_control", { fullOutputPath: path }) });
  await until(async () => { try { await stat(join(shell.cwd, "ready")); return true; } catch { return false; } });
  const observed = first.text.includes("line 2500") ? first : await shell.control({ action: "wait", session_id: first.result.session_id, yield_time_ms: 10000 });
  assert.equal(observed.result.status, "running");
  assert.match(observed.text, /Output truncated.*Showing lines 501-2500/s);
  assert.equal(observed.result.truncated, false);
  assert.equal(observed.result.output.split("\n").filter(Boolean).length, 2500);
  const path = observed.result.output_file;
  assert.ok(path);
  await files.capture("shell_control", { fullOutputPath: path });
  const before = await readFile(path, "utf8");
  assert.ok(before.startsWith("line 1\n"));
  const read = await files.readText(shell.cwd, path, { offset: 1, limit: 2 });
  assert.ok(read?.startsWith("line 1\nline 2\n"));
  const final = await shell.control({ action: "wait", session_id: first.result.session_id, chars: "go\n" });
  assert.equal(final.result.status, "completed");
  assert.equal(final.result.output, "LATER\n");
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(shell.completions(), []);
});

test("programmatic output retains its independent 1-MiB limit and a complete saved file", async (t) => {
  const { shell } = await fixture(t);
  const result = await shell.launch({ command: command("process.stdout.write('a'.repeat(1400000)+'END')") });
  assert.equal(result.result.truncated, true);
  if (!result.result.truncated) return;
  assert.ok(result.result.output.startsWith("aaa") && result.result.output.endsWith("END"));
  assert.ok(result.result.truncation.shown_bytes <= 1048576);
  assert.equal(result.result.truncation.shown_bytes + result.result.truncation.omitted_bytes, 1400003);
  assert.ok(Value.Check(shellResultSchema, result.result));
  assert.equal((await readFile(result.result.output_file, "utf8")).length, 1400003);
  const repeated = await shell.control({ action: "wait", session_id: result.result.session_id });
  assert.equal(repeated.result.output, "");
});

test("a failed artifact export does not consume the observation", async (t) => {
  const { shell } = await fixture(t);
  let id = "";
  await assert.rejects(shell.launch({ command: command("process.stdout.write('x'.repeat(70000))") }, { exportFile: async () => { throw new Error("export denied"); } }), error => {
    if (!(error instanceof ShellOperationError)) return false;
    id = error.snapshot?.session_id ?? "";
    return error.code === "internal_error";
  });
  assert.ok(id);
  const result = await shell.control({ action: "wait", session_id: id });
  assert.equal(result.result.output.length, 70000);
});

test("completion notices are once-only metadata and do not consume output", async (t) => {
  const { shell } = await fixture(t);
  const initial = await shell.launch({ command: command("setTimeout(()=>console.log('FINISHED'),300)"), yield_time_ms: 50 });
  await until(() => shell.list()[0]?.status === "completed");
  assert.equal(shell.completions().length, 1);
  assert.deepEqual(shell.completions(), []);
  const result = await shell.control({ action: "wait", session_id: initial.result.session_id });
  assert.equal(result.result.output, "FINISHED\n");
});

test("a natural exit wins over stop while final output is still flushing", async (t) => {
  const { shell } = await fixture(t);
  let blocked = false;
  let flushing = false;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const flush = ShellOutput.prototype.flush;
  t.mock.method(ShellOutput.prototype, "flush", async function (this: ShellOutput) {
    await flush.call(this);
    if (blocked) { flushing = true; await gate; }
  });
  const initial = await shell.launch({ command: command("setTimeout(()=>console.log('NATURAL'),500)"), yield_time_ms: 50 });
  blocked = true;
  try {
    await until(() => flushing);
    const stopped = shell.control({ action: "stop", session_id: initial.result.session_id });
    assert.equal(shell.describe(initial.result.session_id).status, "completed");
    release();
    const result = await stopped;
    assert.equal(result.result.status, "completed");
    assert.match(result.result.output, /NATURAL/);
    assert.equal("termination_reason" in result.result, false);
  } finally { release(); }
});

test("saved files over 64 MiB support bounded authorized reads and reject mutation", async (t) => {
  const { cwd, files, tools } = await fixture(t);
  const path = join(cwd, "large.log");
  const file = await open(path, "wx");
  const prefix = "first\nsecond\n";
  await file.write(prefix);
  await file.truncate(65 * 1024 * 1024);
  await file.close();
  await files.capture("shell_control", { fullOutputPath: path });
  const read = tools.find(tool => tool.name === "read"); assert.ok(read);
  const result = await Reflect.apply(read.execute, read, ["range", { path, offset: 2, limit: 1 }, undefined, undefined]);
  const parsed = z.object({ structuredContent: z.string() }).parse(result);
  assert.ok(parsed.structuredContent.startsWith("second\n"));
  assert.ok(parsed.structuredContent.length < 1000);
  await writeFile(path, "changed");
  await assert.rejects(files.readText(cwd, path), /changed/);
});
