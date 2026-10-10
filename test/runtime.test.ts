import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { parseCli } from "../src/args.js";
import { ArkHost } from "../src/runtime.js";
import { ApprovalBroker } from "../src/approval.js";
import { inspectSession, writeRunMarker } from "../src/storage.js";
import type { ApprovalDecision, ApprovalRequest, Choice, Permission, Status, UserInterface } from "../src/domain.js";

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional(),
}).passthrough();
type ModelRequest = z.infer<typeof requestSchema>;
type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; arguments: object };

class RecordingUI implements UserInterface {
  statuses: Status[] = [];
  messages: Array<{ kind: "user" | "assistant" | "info" | "error"; text: string }> = [];
  tools: Array<{ name: string; text: string; state: "running" | "done" | "error" }> = [];
  answers: string[] = [];
  deltas = "";
  approvals: ApprovalRequest[] = [];
  draftText = "";
  dismissed = false;
  constructor(private decision: (request: ApprovalRequest) => Promise<ApprovalDecision> = async () => "once") {}
  status(value: Status): void { this.statuses.push(value); }
  message(kind: "user" | "assistant" | "info" | "error", text: string): void { this.messages.push({ kind, text }); }
  assistantDelta(text: string): void { this.deltas += text; }
  assistantEnd(text: string): void { this.answers.push(text); }
  tool(_id: string, name: string, text: string, state: "running" | "done" | "error"): void { this.tools.push({ name, text, state }); }
  async choose(_title: string, _choices: Choice[]): Promise<string | null> { return null; }
  async input(_title: string, _initial?: string): Promise<string | null> { return null; }
  approve(request: ApprovalRequest): Promise<ApprovalDecision> { this.approvals.push(request); return this.decision(request); }
  dismiss(): void { this.dismissed = true; }
  draft(): string { return this.draftText; }
  setDraft(text: string): void { this.draftText = text; }
  clear(): void {}
  async copy(_text: string): Promise<boolean> { return true; }
  stop(): void {}
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the agent state.");
    await delay(10);
  }
}

function stream(response: ServerResponse, reply: Reply, index: number): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
    id: `chat-${index}`, object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  chunk({ role: "assistant" });
  if (reply.kind === "text") {
    const midpoint = Math.floor(reply.text.length / 2);
    chunk({ content: reply.text.slice(0, midpoint) });
    chunk({ content: reply.text.slice(midpoint) });
    chunk({}, "stop");
  } else {
    const args = JSON.stringify(reply.arguments);
    const midpoint = Math.floor(args.length / 2);
    chunk({ tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name: reply.name, arguments: args.slice(0, midpoint) } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(midpoint) } }] });
    chunk({}, "tool_calls");
  }
  response.write(`data: ${JSON.stringify({ id: `chat-${index}`, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function fixture(t: TestContext, respond: (request: ModelRequest, index: number) => Reply | Promise<Reply>) {
  const directory = await mkdtemp(join(tmpdir(), "arkcode-runtime-"));
  const cwd = join(directory, "workspace");
  const home = join(directory, "home");
  await mkdir(cwd); await mkdir(home);
  const requests: ModelRequest[] = [];
  const failures: Error[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-key");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed = requestSchema.parse(JSON.parse(body));
      const index = requests.push(parsed) - 1;
      stream(response, await respond(parsed, index), index);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) response.writeHead(500);
      response.end("Fixture rejected request");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-key",
    models: [
      { id: "test", name: "Local test model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
      { id: "alternate", name: "Alternate test model", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
    ],
  } } }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", trustedWorkspaces: [cwd] }));
  const hosts: ArkHost[] = [];
  const start = async (ui = new RecordingUI(), args: string[] = []) => {
    const host = new ArkHost(parseCli(["--cwd", cwd, "--home", home, "--model", "fixture/test", "--permissions", "full-access", ...args]), ui);
    hosts.push(host);
    await host.start();
    return { host, ui };
  };
  t.after(async () => {
    for (const host of hosts.reverse()) await host.exit();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  const sessions = async () => (await readdir(join(home, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl")).map((path) => join(home, "sessions", path));
  return { cwd, home, requests, start, sessions };
}

test("removed commands are rejected without running the agent, while @ references still work", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "File reference received." }));
  const { host, ui } = await f.start();
  await host.submit("/help");
  assert.equal(ui.messages.at(-1)?.text.split("\n")[0], "/help /model /connect /permissions /status /new /resume /rename /fork /compact /copy /init /exit");
  for (const command of ["diff", "review", "ps", "theme", "statusline", "stop", "quit", "mention", "clear"]) {
    await host.submit(`/${command}`);
    assert.deepEqual(ui.messages.at(-1), { kind: "error", text: `Unknown command /${command}. Use /help.` });
    assert.equal(ui.draft(), `/${command}`);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(host.outcome, null);
  await writeFile(join(f.cwd, "reference file.txt"), "attached source evidence");
  await host.submit('Inspect @"reference file.txt"');
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0]?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("attached source evidence")));
  await host.submit("/exit");
  await host.submit("This must not run after exit");
  assert.equal(f.requests.length, 1);
});

test("a streamed agent turn reads, writes, edits and executes the native shell", { timeout: 30000 }, async (t) => {
  const shell = process.platform === "win32" ? "[Console]::Write('shell verified')" : "printf 'shell verified'";
  const replies: Reply[] = [
    { kind: "tool", name: "read", arguments: { path: "input.txt" } },
    { kind: "tool", name: "write", arguments: { path: "result.txt", content: "before\n" } },
    { kind: "tool", name: "edit", arguments: { path: "result.txt", oldText: "before", newText: "after" } },
    { kind: "tool", name: "bash", arguments: { command: shell } },
    { kind: "text", text: "Verified all changes." },
  ];
  const f = await fixture(t, (_request, index) => {
    const reply = replies[index]; assert.ok(reply, "Unexpected model request"); return reply;
  });
  await writeFile(join(f.cwd, "input.txt"), "source evidence\n");
  const { host, ui } = await f.start();
  await host.submit("Read the input and change the result.");
  assert.equal(host.outcome, "completed");
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "after\n");
  assert.equal(ui.deltas, "Verified all changes.");
  assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("1: source evidence")));
  assert.ok(ui.tools.some((tool) => tool.name === "bash" && tool.state === "done" && tool.text.includes("shell verified") && tool.text.includes("exit code 0")));
  const lastRequest = f.requests.at(-1); assert.ok(lastRequest);
  assert.ok(lastRequest.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("Edited result.txt")));
  const saved = await f.sessions(); assert.equal(saved.length, 1);
  assert.ok((await readFile(saved[0] ?? "", "utf8")).includes("Verified all changes."));
});

test("interrupt during run preparation prevents the model from starting", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Must not run." }));
  const { host } = await f.start();
  const work = host.submit("Do not start after interruption.");
  await host.interrupt();
  await work;
  assert.equal(host.outcome, "interrupted");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.sessions(), []);
});

test("failed compaction reports failure even after an interrupted run", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Must not run." }));
  const { host, ui } = await f.start();
  await host.submit("/compact");
  assert.equal(host.outcome, "failed");
  assert.ok(ui.messages.some((message) => message.kind === "error" && message.text.includes("Nothing to compact")));
  const work = host.submit("Cancel this run.");
  await host.interrupt();
  await work;
  assert.equal(host.outcome, "interrupted");
  await host.submit("/compact");
  assert.equal(host.outcome, "failed");
  assert.equal(f.requests.length, 0);
});

test("an active first-run marker without history keeps the workspace read-only", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Inspection only." }));
  await writeRunMarker(f.home, "unpersisted-session", {
    status: "active", runId: "unconfirmed-first-run", startedAt: Date.now(), pid: process.pid, cwd: f.cwd,
  });
  await assert.rejects(f.sessions(), { code: "ENOENT" });
  const { host, ui } = await f.start();
  assert.equal(ui.statuses.at(-1)?.permission, "read-only");
  assert.ok(ui.messages.some((message) => message.text.includes("Execution unconfirmed")));
  await host.submit("/permissions full-access");
  assert.equal(ui.statuses.at(-1)?.permission, "read-only");
  await host.submit("/new");
  await host.submit("!echo must-not-execute");
  assert.equal(ui.tools.length, 0);
  assert.equal(f.requests.length, 0);
  await host.submit("Inspect only.");
  assert.equal(host.outcome, "completed");
  assert.deepEqual(f.requests[0]?.tools?.map((tool) => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
});

test("denied writes return a tool error and the agent can continue", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "write", arguments: { path: "denied.txt", content: "must not exist" } }
    : { kind: "text", text: "Write was denied." });
  const ui = new RecordingUI(async () => "deny");
  const { host } = await f.start(ui, ["--permissions", "ask"]);
  await host.submit("Write a file.");
  assert.equal(ui.approvals[0]?.tool, "write");
  assert.ok(ui.tools.some((tool) => tool.name === "write" && tool.state === "error" && tool.text.includes("denied")));
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  assert.equal(ui.answers.at(-1), "Write was denied.");
  assert.equal(host.outcome, "completed");
});

test("read-only agents can inspect files and cannot execute a model-requested write", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return { kind: "tool", name: "read", arguments: { path: "input.txt" } };
    if (index === 1) return { kind: "tool", name: "write", arguments: { path: "denied.txt", content: "must not exist" } };
    return { kind: "text", text: "Inspection complete. Writing unavailable." };
  });
  await writeFile(join(f.cwd, "input.txt"), "read-only evidence\n");
  const { host, ui } = await f.start(new RecordingUI(), ["--permissions", "read-only"]);
  await host.submit("Inspect the input");
  assert.equal(host.outcome, "completed");
  assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("1: read-only evidence")));
  assert.equal(ui.approvals.length, 0);
  assert.ok(ui.tools.some((tool) => tool.name === "write" && tool.state === "error"));
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  assert.equal(ui.answers.at(-1), "Inspection complete. Writing unavailable.");
  assert.deepEqual(f.requests[0]?.tools?.map((tool) => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
});

test("steering and follow-up inputs are consumed by the real agent queue", { timeout: 30000 }, async (t) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, async (_request, index) => {
    if (index === 0) { await gate; return { kind: "text", text: "Initial answer." }; }
    if (index === 1) return { kind: "text", text: "Steering accepted." };
    return { kind: "text", text: "Follow-up accepted." };
  });
  const { host, ui } = await f.start();
  const run = host.submit("Initial input");
  await until(() => f.requests.length === 1);
  await host.submit("Change direction now", "steer");
  await host.submit("Then verify the result", "follow-up");
  assert.ok(ui.statuses.at(-1)?.queued.some((text) => text.includes("Change direction now")));
  release();
  await run;
  assert.deepEqual(ui.answers, ["Initial answer.", "Steering accepted.", "Follow-up accepted."]);
  assert.ok(f.requests[1]?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Change direction now")));
  assert.ok(f.requests[2]?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Then verify the result")));
  assert.deepEqual(ui.statuses.at(-1)?.queued, []);
  assert.equal(host.outcome, "completed");
});

test("interrupting pending approval restores queued inputs and prevents the write", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "tool", name: "write", arguments: { path: "cancelled.txt", content: "must not exist" } }));
  const ui = new RecordingUI(() => new Promise<ApprovalDecision>(() => {}));
  const { host } = await f.start(ui, ["--permissions", "ask"]);
  const run = host.submit("Start a write");
  await until(() => ui.statuses.at(-1)?.state.kind === "awaiting-approval");
  await host.submit("Pending steering", "steer");
  await host.submit("Pending follow-up", "follow-up");
  await host.interrupt(); await run;
  assert.equal(host.outcome, "interrupted");
  assert.equal(ui.dismissed, true);
  assert.equal(ui.draft(), "Pending steering\n\nPending follow-up");
  await assert.rejects(readFile(join(f.cwd, "cancelled.txt")), { code: "ENOENT" });
  assert.deepEqual(ui.statuses.at(-1)?.queued, []);
  assert.equal(f.requests.length, 1);
});

test("resume and fork preserve conversation history without replaying tools", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "write", arguments: { path: "result.txt", content: "first result" } }
    : { kind: "text", text: "Original completed answer." });
  const original = await f.start();
  await original.host.submit("Create one result");
  await original.host.exit();
  await writeFile(join(f.cwd, "result.txt"), "edited outside the agent");
  const resume = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.ok(resume.ui.messages.some((message) => message.kind === "assistant" && message.text === "Original completed answer."));
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "edited outside the agent");
  assert.equal(f.requests.length, 2);
  await resume.host.submit("/fork");
  assert.ok(resume.ui.messages.filter((message) => message.kind === "assistant" && message.text === "Original completed answer.").length >= 2);
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "edited outside the agent");
  assert.equal(f.requests.length, 2);
  await resume.host.submit("Continue this fork");
  assert.equal(resume.host.outcome, "completed");
  assert.equal((await f.sessions()).length, 2);
  assert.ok(f.requests[2]?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Create one result")));
});

test("a second workspace process is a viewer and cannot mutate sessions", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Owner answer." }));
  const owner = await f.start();
  await owner.host.submit("Owner prompt");
  const paths = await f.sessions();
  const saved = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const viewer = await f.start(new RecordingUI(), ["resume", "--last", "--model", "fixture/alternate", "--thinking", "high"]);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
  assert.equal(viewer.ui.statuses.at(-1)?.model, "fixture/alternate");
  assert.equal(viewer.ui.statuses.at(-1)?.thinking, "high");
  assert.ok(viewer.ui.messages.some((message) => message.text === "Owner answer."));
  for (const input of ["Run another prompt", "/rename overwritten", "/new", "/fork", "/permissions full-access"]) await viewer.host.submit(input);
  assert.equal(viewer.ui.messages.filter((message) => message.kind === "error" && message.text.includes("viewer")).length, 5);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.sessions(), paths);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), saved);
  await assert.rejects(f.start(new RecordingUI(), ["fork", "--last"]), /Read-only viewer cannot fork a session/);
  assert.deepEqual(await f.sessions(), paths);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), saved);
});

test("a user shell queued during a turn runs afterward and persists its result", { timeout: 30000 }, async (t) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return { kind: "text", text: "Original turn finished." }; });
  class OrderedUI extends RecordingUI {
    override tool(id: string, name: string, text: string, state: "running" | "done" | "error"): void {
      if (name === "shell") assert.deepEqual(this.answers, ["Original turn finished."]);
      super.tool(id, name, text, state);
    }
  }
  const { host, ui } = await f.start(new OrderedUI());
  const command = process.platform === "win32"
    ? "Set-Content -NoNewline -Path queued.txt -Value 'queued shell output'; [Console]::Write('queued shell output')"
    : "printf 'queued shell output' > queued.txt; printf 'queued shell output'";
  const run = host.submit("Hold the original turn");
  await until(() => f.requests.length === 1);
  await host.submit(`!${command}`);
  assert.ok(ui.statuses.at(-1)?.queued.some((text) => text.startsWith("Queued shell:")));
  assert.equal(ui.tools.filter((tool) => tool.name === "shell").length, 0);
  await assert.rejects(readFile(join(f.cwd, "queued.txt")), { code: "ENOENT" });
  release();
  await run;
  assert.equal(host.outcome, "completed");
  assert.deepEqual(ui.answers, ["Original turn finished."]);
  assert.equal(await readFile(join(f.cwd, "queued.txt"), "utf8"), "queued shell output");
  assert.ok(ui.tools.some((tool) => tool.name === "shell" && tool.state === "done" && tool.text.includes("queued shell output") && tool.text.includes("Exit code: 0")));
  assert.deepEqual(ui.statuses.at(-1)?.queued, []);
  assert.equal(f.requests.length, 1);
  const paths = await f.sessions(); assert.equal(paths.length, 1);
  const entries = (await readFile(paths[0] ?? "", "utf8")).trim().split("\n").map((line) => z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)));
  assert.ok(entries.some((entry) => JSON.stringify(entry).includes("arkcode-shell") && JSON.stringify(entry).includes("queued shell output") && JSON.stringify(entry).includes("Exit code: 0")));
});

test("interrupt restores queued local commands without executing them", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "tool", name: "write", arguments: { path: "blocked.txt", content: "blocked mutation" } }));
  const ui = new RecordingUI(() => new Promise<ApprovalDecision>(() => {}));
  const { host } = await f.start(ui, ["--permissions", "ask"]);
  const run = host.submit("Wait for approval");
  await until(() => ui.statuses.at(-1)?.state.kind === "awaiting-approval");
  const command = process.platform === "win32" ? "Set-Content -Path queued.txt -Value 'must not execute'" : "printf 'must not execute' > queued.txt";
  await host.submit(`!${command}`);
  ui.setDraft("Existing draft");
  await host.interrupt(); await run;
  assert.equal(host.outcome, "interrupted");
  assert.ok(ui.draft().startsWith(`Existing draft\n\n!${command}`));
  assert.deepEqual(ui.statuses.at(-1)?.queued, []);
  assert.equal(ui.tools.filter((tool) => tool.name === "shell").length, 0);
  await assert.rejects(readFile(join(f.cwd, "queued.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.cwd, "blocked.txt")), { code: "ENOENT" });
  assert.equal(f.requests.length, 1);
});

test("new sessions cannot bypass the unconfirmed execution permission gate", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return { kind: "text", text: "Saved original history." };
    if (index === 1) return { kind: "tool", name: "write", arguments: { path: "recovery.txt", content: "forbidden during recovery" } };
    throw new Error("Recovery actions must not send another model request.");
  });
  const original = await f.start();
  await original.host.submit("Save history before the interrupted process");
  await original.host.exit();
  const paths = await f.sessions(); assert.equal(paths.length, 1);
  const saved = await inspectSession(paths[0] ?? "", f.cwd);
  await writeRunMarker(f.home, saved.id, { status: "active", runId: "unconfirmed-run", startedAt: 123, pid: process.pid });
  const { host, ui } = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.equal(host.outcome, "interrupted");
  assert.equal(ui.statuses.at(-1)?.permission, "read-only");
  assert.ok(ui.messages.some((message) => message.kind === "assistant" && message.text === "Saved original history."));
  assert.ok(ui.messages.some((message) => message.kind === "error" && message.text.includes("Execution unconfirmed.")));
  assert.equal(f.requests.length, 1);
  for (const command of ["/permissions ask", "/permissions full-access"]) await host.submit(command);
  assert.equal(ui.statuses.at(-1)?.permission, "read-only");
  await assert.rejects(readFile(join(f.cwd, "recovery.txt")), { code: "ENOENT" });
  await host.submit("/fork");
  await host.submit("/permissions ask");
  assert.equal(ui.statuses.at(-1)?.permission, "read-only");
  assert.equal(ui.messages.filter((message) => message.kind === "error" && message.text.startsWith("Execution unconfirmed.")).length, 4);
  await host.submit("/new");
  await host.submit("/permissions ask");
  assert.equal(ui.statuses.at(-1)?.permission, "read-only");
  assert.equal(ui.messages.filter((message) => message.kind === "error" && message.text.startsWith("Execution unconfirmed.")).length, 5);
  await host.submit("!echo must remain blocked");
  assert.equal(host.outcome, "failed");
  assert.equal(ui.tools.filter((tool) => tool.name === "shell").length, 0);
  assert.equal(ui.approvals.length, 0);
  assert.equal(f.requests.length, 1);
  await assert.rejects(readFile(join(f.cwd, "recovery.txt")), { code: "ENOENT" });
  await host.exit();
  const restarted = await f.start();
  assert.equal(restarted.ui.statuses.at(-1)?.permission, "read-only");
  await restarted.host.submit("/permissions full-access");
  assert.equal(restarted.ui.statuses.at(-1)?.permission, "read-only");
  assert.equal(f.requests.length, 1);
});

for (const command of ["/new", "/resume --last", "/fork"]) {
  test(`${command} preserves queued drafts while replacing a busy session`, { timeout: 30000 }, async (t) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(t, async (_request, index) => {
      if (index === 0) return { kind: "text", text: "Saved answer." };
      await gate;
      return { kind: "text", text: "Interrupted answer." };
    });
    class ClearingUI extends RecordingUI { override clear(): void { this.draftText = ""; } }
    const { host, ui } = await f.start(new ClearingUI());
    await host.submit("Save original history");
    const run = host.submit("Block this turn");
    await until(() => f.requests.length === 2);
    await host.submit("Pending steering", "steer");
    await host.submit("Pending follow-up", "follow-up");
    await host.submit("!echo pending shell");
    ui.setDraft("Existing draft");
    try { await host.submit(command); await run; }
    finally { release(); }
    assert.equal(ui.draft(), "Existing draft\n\nPending steering\n\nPending follow-up\n\n!echo pending shell");
    assert.equal(ui.statuses.at(-1)?.state.kind, "idle");
    assert.deepEqual(ui.statuses.at(-1)?.queued, []);
    assert.equal(f.requests.length, 2);
    assert.equal(ui.tools.filter((tool) => tool.name === "shell").length, 0);
    assert.equal(ui.messages.filter((message) => message.kind === "error").length, 0);
  });
}

test("session approval grants apply only to the same tool, cwd and exact operation", async () => {
  const ui: RecordingUI = new RecordingUI(async (): Promise<ApprovalDecision> => ui.approvals.length === 1 ? "session" : "deny");
  const broker = new ApprovalBroker(ui, () => "ask", () => {});
  const request: ApprovalRequest = { id: "first", tool: "write", cwd: "/workspace", description: "Write file.txt\ncontent A" };
  assert.equal(await broker.authorize(request), true);
  assert.equal(await broker.authorize({ ...request, id: "another-call" }), true);
  assert.equal(ui.approvals.length, 1);
  assert.equal(await broker.authorize({ ...request, id: "content-change", description: "Write file.txt\ncontent B" }), false);
  assert.equal(await broker.authorize({ ...request, id: "tool-change", tool: "edit" }), false);
  assert.equal(await broker.authorize({ ...request, id: "cwd-change", cwd: "/another-workspace" }), false);
  assert.equal(ui.approvals.length, 4);
  assert.equal(await broker.authorize(request), true);
  broker.reset();
  assert.equal(await broker.authorize(request), false);
  assert.equal(ui.approvals.length, 5);
});

test("cancelled approvals ignore late session grants and require fresh approval", async () => {
  let resolveLate: (decision: ApprovalDecision) => void = () => {};
  const late = new Promise<ApprovalDecision>((resolve) => { resolveLate = resolve; });
  const ui: RecordingUI = new RecordingUI(async (): Promise<ApprovalDecision> => ui.approvals.length === 1 ? late : "deny");
  const changes: Array<ApprovalRequest | null> = [];
  const broker = new ApprovalBroker(ui, () => "ask", (request) => changes.push(request));
  const request: ApprovalRequest = { id: "cancelled", tool: "bash", cwd: "/workspace", description: "echo command" };
  const pending = broker.authorize(request);
  broker.cancel();
  assert.equal(await pending, false);
  assert.equal(ui.dismissed, true);
  resolveLate("session");
  await Promise.resolve();
  assert.equal(await broker.authorize({ ...request, id: "retry" }), false);
  assert.equal(ui.approvals.length, 2);
  assert.deepEqual(changes, [request, null, { ...request, id: "retry" }, null]);
});

test("permission changes invalidate pending approval decisions", async () => {
  let permission: Permission = "ask";
  let resolveDecision: (decision: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => { resolveDecision = resolve; });
  const ui: RecordingUI = new RecordingUI(async (): Promise<ApprovalDecision> => ui.approvals.length === 1 ? decision : "once");
  const broker = new ApprovalBroker(ui, () => permission, () => {});
  const request: ApprovalRequest = { id: "permission-change", tool: "write", cwd: "/workspace", description: "Write output.txt\ncontent" };
  const pending = broker.authorize(request);
  permission = "read-only";
  resolveDecision("session");
  assert.equal(await pending, false);
  assert.equal(await broker.authorize(request), false);
  permission = "ask";
  assert.equal(await broker.authorize({ ...request, id: "fresh" }), true);
  assert.equal(ui.approvals.length, 2);
  assert.equal(await broker.authorize({ ...request, id: "once-needs-another-approval" }), true);
  assert.equal(ui.approvals.length, 3);
});
