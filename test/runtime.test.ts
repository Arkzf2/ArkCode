import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseCli } from "../src/args.js";
import { ArkHost } from "../src/runtime.js";
import { ApprovalBroker } from "../src/approval.js";
import { CONTEXT_MESSAGE } from "../src/context.js";
import { inspectSession, WorkspaceLease, writeRunMarker } from "../src/storage.js";
import type { ApprovalDecision, ApprovalRequest, Choice, Permission, SessionBrowserResult, SessionDetails, SessionItem, Status, ToolDetails, UserInterface } from "../src/domain.js";

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional(),
}).passthrough();
type ModelRequest = z.infer<typeof requestSchema>;
type Reply = { kind: "text"; text: string; thinking?: string } | { kind: "tool"; name: string; arguments: object };

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function largePng(): Buffer {
  const width = 256;
  const height = 256;
  const pixels = randomBytes(width * height * 3);
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row++) pixels.copy(rows, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

class RecordingUI implements UserInterface {
  statuses: Status[] = [];
  messages: Array<{ kind: "user" | "assistant" | "info" | "error"; text: string }> = [];
  tools: Array<{ name: string; text: string; state: "running" | "done" | "error"; details?: ToolDetails }> = [];
  thoughts: Array<{ id: string; text: string; active: boolean }> = [];
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
  reasoning(id: string, text: string, active: boolean): void { this.thoughts.push({ id, text, active }); }
  tool(_id: string, name: string, text: string, state: "running" | "done" | "error", details?: ToolDetails): void { this.tools.push({ name, text, state, details }); }
  async choose(_title: string, _choices: Choice[]): Promise<string | null> { return null; }
  async input(_title: string, _initial?: string): Promise<string | null> { return null; }
  async secret(_title: string): Promise<string | null> { return null; }
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
    if (reply.thinking) {
      const middle = Math.floor(reply.thinking.length / 2);
      chunk({ reasoning_content: reply.thinking.slice(0, middle) });
      chunk({ reasoning_content: reply.thinking.slice(middle) });
    }
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

async function fixture(t: TestContext, respond: (request: ModelRequest, index: number) => Reply | Promise<Reply>, imageInput = false, contextWindow = 128000) {
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
      { id: "test", name: "Local test model", reasoning: false, input: imageInput ? ["text", "image"] : ["text"], contextWindow, maxTokens: 4096 },
      { id: "alternate", name: "Alternate test model", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
    ],
  } } }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", trustedWorkspaces: [cwd] }));
  const hosts: ArkHost[] = [];
  const start = async (ui = new RecordingUI(), args: string[] = []) => {
    const host = new ArkHost(parseCli(["--cwd", cwd, "--home", home, "--model", "fixture/test", "--permissions", "never-ask", ...args]), ui);
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

test("/connect chooses a Pi provider, credentials, then an available catalog model", async (t) => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-builtin-key";
  t.after(() => { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const titles: string[] = [];
  class ConnectUI extends RecordingUI {
    override async choose(title: string, choices: Choice[]): Promise<string | null> {
      titles.push(title);
      const value = title === "Connect model" ? "builtin" : title === "Provider" ? "openai" : title === "Credentials" ? "existing" : "gpt-4.1";
      assert.ok(choices.some((choice) => choice.value === value));
      return value;
    }
  }
  const { host, ui } = await f.start(new ConnectUI());
  await host.submit("/connect");
  assert.deepEqual(titles, ["Connect model", "Provider", "Credentials", "Model"]);
  assert.equal(ui.statuses.at(-1)?.model, "openai/gpt-4.1");
  assert.equal(JSON.parse(await readFile(join(f.home, "settings.json"), "utf8")).model, "gpt-4.1");
});

test("/connect creates a custom endpoint and switches the active session model", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const source = JSON.parse(await readFile(join(f.home, "models.json"), "utf8"));
  const baseUrl = source.providers.fixture.baseUrl as string;
  class ConnectUI extends RecordingUI {
    override async choose(title: string, choices: Choice[]): Promise<string | null> {
      const value = title === "Connect model" ? "custom" : title === "API protocol" ? "openai-completions"
        : title === "Model input" ? "text" : title === "Reasoning" ? "false" : "key";
      assert.ok(choices.some((choice) => choice.value === value));
      return value;
    }
    override async input(title: string): Promise<string> {
      if (title === "Custom provider ID") return "custom-fixture";
      if (title === "API base URL") return baseUrl;
      if (title === "Model ID" || title === "Model name") return "sample";
      if (title === "Context window (tokens)") return "32768";
      if (title === "Maximum output tokens") return "2048";
      assert.fail(`Unexpected input: ${title}`);
    }
    override async secret(): Promise<string> { return "fixture-key"; }
  }
  const { host, ui } = await f.start(new ConnectUI());
  await host.submit("/connect");
  assert.equal(ui.statuses.at(-1)?.model, "custom-fixture/sample");
  assert.equal(JSON.parse(await readFile(join(f.home, "settings.json"), "utf8")).model, "sample");
  assert.equal(JSON.parse(await readFile(join(f.home, "models.json"), "utf8")).providers["custom-fixture"].apiKey, undefined);
  assert.equal((await readFile(join(f.home, "auth.json"), "utf8")).includes("fixture-key"), true);
});

test("a new session asks for a model instead of letting Pi silently choose one", async (t) => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-builtin-key";
  t.after(() => { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ thinking: "off", trustedWorkspaces: [f.cwd] }));
  class ModelUI extends RecordingUI {
    choices = 0;
    override async choose(title: string, choices: Choice[]): Promise<string | null> {
      assert.equal(title, "Select a model");
      assert.ok(choices.length > 1);
      this.choices++;
      return "fixture/test";
    }
  }
  const ui = new ModelUI();
  const host = new ArkHost(parseCli(["--cwd", f.cwd, "--home", f.home, "--permissions", "never-ask"]), ui);
  t.after(() => host.exit());
  await host.start();
  assert.equal(ui.choices, 1);
  assert.equal(ui.statuses.at(-1)?.model, "fixture/test");
  assert.equal(JSON.parse(await readFile(join(f.home, "settings.json"), "utf8")).model, "test");
});

test("print mode without an explicit or saved model stops before creating a session", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ thinking: "off", trustedWorkspaces: [f.cwd] }));
  const host = new ArkHost(parseCli(["--cwd", f.cwd, "--home", f.home, "--print", "--permissions", "never-ask"]), new RecordingUI());
  t.after(() => host.exit());
  await assert.rejects(host.start(), /Select a model with --model or arkcode config/);
  assert.equal((await readdir(join(f.home, "sessions"), { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".jsonl")).length, 0);
});

test("session browser retains the current Agent and draft after a failed cross-project open", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Current answer." }));
  const other = join(f.home, "other-project");
  await mkdir(other);
  const encoded = Buffer.from(process.platform === "win32" ? other.toLowerCase() : other).toString("base64url");
  const dir = join(f.home, "sessions", encoded);
  const sound = SessionManager.create(other, dir);
  sound.appendMessage({ role: "user", content: "Sound history", timestamp: Date.now() });
  const soundFile = sound.getSessionFile() ?? assert.fail("Test session was not persisted.");
  const original = await readFile(soundFile, "utf8");
  class BrowserUI extends RecordingUI {
    corrupt = true;
    calls = 0;
    seen: SessionItem[] = [];
    async choose(): Promise<string> { return "continue"; }
    async browseSessions(items: SessionItem[], details?: (item: SessionItem) => Promise<SessionDetails>): Promise<SessionBrowserResult | null> {
      this.calls++;
      this.seen = items;
      const item = items.find((candidate) => candidate.id === sound.getSessionId());
      assert.ok(item);
      if (!this.corrupt) {
        const detail = await details?.(item);
        assert.equal(detail?.lastMessage, "Sound history");
        assert.equal(detail?.prompt, "Sound history");
      }
      if (this.corrupt) await writeFile(soundFile, `${original}{broken tail`);
      return { kind: "open", item };
    }
  }
  const ui = new BrowserUI();
  const { host } = await f.start(ui);
  ui.setDraft("Preserve this draft");
  await Promise.all([host.browseSessions(), host.browseSessions()]);
  assert.equal(ui.calls, 1);
  assert.equal(host.cwd, f.cwd);
  assert.equal(ui.draft(), "Preserve this draft");
  assert.match(ui.messages.at(-1)?.text ?? "", /Invalid session line/);
  assert.ok(ui.seen.some((item) => item.current && item.title === "Untitled session"));
  await writeFile(soundFile, original);
  ui.corrupt = false;
  await host.browseSessions();
  assert.equal(host.cwd, other);
  assert.equal(ui.draft(), "Preserve this draft");
  assert.ok(ui.messages.some((item) => item.kind === "user" && item.text === "Sound history"));
  assert.equal(ui.statuses.at(-1)?.permission, "never-ask");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, false);
});

test("session center new creates in the selected project with a fresh workspace lease", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused" }));
  const other = join(f.home, "another-project");
  await mkdir(other);
  const encoded = Buffer.from(process.platform === "win32" ? other.toLowerCase() : other).toString("base64url");
  const saved = SessionManager.create(other, join(f.home, "sessions", encoded));
  saved.appendMessage({ role: "user", content: "Earlier task", timestamp: Date.now() });
  class NewUI extends RecordingUI {
    async choose(): Promise<string> { return "continue"; }
    async browseSessions(items: SessionItem[]): Promise<SessionBrowserResult | null> {
      assert.ok(items.some((item) => item.cwd === other && item.path));
      return { kind: "new", cwd: other };
    }
  }
  const ui = new NewUI();
  const { host } = await f.start(ui);
  ui.setDraft("Keep writing here");
  await host.browseSessions();
  assert.equal(host.cwd, other);
  assert.equal(ui.draft(), "Keep writing here");
  assert.equal(ui.statuses.at(-1)?.permission, "never-ask");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, false);
  assert.equal(ui.messages.some((entry) => entry.kind === "user" && entry.text === "Earlier task"), false);
});

test("cancelling cross-project trust keeps the current session and releases the target lease", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused" }));
  const other = join(f.home, "cancelled-project");
  await mkdir(other);
  const encoded = Buffer.from(process.platform === "win32" ? other.toLowerCase() : other).toString("base64url");
  const saved = SessionManager.create(other, join(f.home, "sessions", encoded));
  saved.appendMessage({ role: "user", content: "Previous work", timestamp: Date.now() });
  class CancelUI extends RecordingUI {
    async browseSessions(items: SessionItem[]): Promise<SessionBrowserResult | null> {
      const item = items.find((entry) => entry.id === saved.getSessionId());
      assert.ok(item);
      return { kind: "open", item };
    }
  }
  const ui = new CancelUI();
  const { host } = await f.start(ui);
  ui.setDraft("Current draft");
  await host.browseSessions();
  assert.equal(host.cwd, f.cwd);
  assert.equal(ui.draft(), "Current draft");
  const lease = await WorkspaceLease.acquire(other, f.home);
  try { assert.equal(lease.viewer, false); }
  finally { await lease.release(); }
});

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
  assert.ok(f.requests[0]?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes('Inspect @\\"reference file.txt\\"')));
  assert.ok(!JSON.stringify(f.requests[0]?.messages).includes("attached source evidence"));
  await host.submit("/exit");
  await host.submit("This must not run after exit");
  assert.equal(f.requests.length, 1);
});

test("a streamed agent turn reads, writes, edits and executes the native shell", { timeout: 30000 }, async (t) => {
  const shell = process.platform === "win32" ? "[Console]::Write('shell verified')" : "printf 'shell verified'";
  const replies: Reply[] = [
    { kind: "tool", name: "Read", arguments: { path: "input.txt" } },
    { kind: "tool", name: "Write", arguments: { path: "result.txt", content: "before\n" } },
    { kind: "tool", name: "Edit", arguments: { path: "result.txt", oldText: "before", newText: "after" } },
    { kind: "tool", name: "Bash", arguments: { command: shell } },
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
  assert.deepEqual(ui.tools.filter((tool) => tool.state === "running" && tool.text === "").map((tool) => tool.details?.target), ["input.txt", "result.txt", "result.txt", shell]);
  assert.ok(ui.tools.some((tool) => tool.name === "Read" && tool.state === "done" && tool.text.includes("1: source evidence")));
  assert.ok(ui.tools.some((tool) => tool.name === "Bash" && tool.state === "done" && tool.text.includes("shell verified") && tool.text.includes("exit code 0")));
  const lastRequest = f.requests.at(-1); assert.ok(lastRequest);
  assert.ok(lastRequest.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("Edited result.txt")));
  const saved = await f.sessions(); assert.equal(saved.length, 1);
  assert.ok((await readFile(saved[0] ?? "", "utf8")).includes("Verified all changes."));
});

test("actual provider reasoning reaches the transcript with a stable identity and survives resume", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "The handler is ready.", thinking: "Inspect the existing handler before changing it." }));
  class ReasoningUI extends RecordingUI {
    override assistantDelta(text: string): void {
      assert.equal(this.thoughts.at(-1)?.active, false, "Reasoning stays active while the answer streams");
      super.assistantDelta(text);
    }
  }
  const { host, ui } = await f.start(new ReasoningUI());
  await host.submit("Inspect the handler.");
  assert.equal(host.outcome, "completed");
  assert.equal(ui.thoughts.at(-1)?.text, "Inspect the existing handler before changing it.");
  assert.equal(ui.thoughts.at(-1)?.active, false);
  assert.equal(new Set(ui.thoughts.map((thought) => thought.id)).size, 1);
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.equal(resumed.ui.thoughts.at(-1)?.text, "Inspect the existing handler before changing it.");
  assert.equal(resumed.ui.thoughts.at(-1)?.active, false);
  assert.equal(f.requests.length, 1);
});

test("failed shell receipts retain the exit code in the TUI and restored history", { timeout: 30000 }, async (t) => {
  const command = 'node -e "process.exit(9)"';
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "Bash", arguments: { command } }
    : { kind: "text", text: "The command failed with exit code 9." });
  const { host, ui } = await f.start();
  await host.submit("Run the diagnostic command.");
  const failed = ui.tools.findLast((tool) => tool.state === "error");
  assert.equal(failed?.details?.exitCode, 9);
  assert.match(failed?.text ?? "", /exit code 9/);
  assert.ok(f.requests.at(-1)?.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("exit code 9")));
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.deepEqual(resumed.ui.tools.findLast((tool) => tool.state === "error")?.details, { target: command, exitCode: 9 });
  assert.equal(f.requests.length, 2);
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
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  assert.ok(ui.messages.some((message) => message.text.includes("Execution unconfirmed")));
  await host.submit("/permissions full-access");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  await host.submit("/new");
  await host.submit("!echo must-not-execute");
  assert.equal(ui.tools.length, 0);
  assert.equal(f.requests.length, 0);
  await host.submit("Inspect only.");
  assert.equal(host.outcome, "completed");
  assert.deepEqual(f.requests[0]?.tools?.map((tool) => tool.function.name).sort(), ["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
});

test("denied writes return a tool error and the agent can continue", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "Write", arguments: { path: "denied.txt", content: "must not exist" } }
    : { kind: "text", text: "Write was denied." });
  const ui = new RecordingUI(async () => "deny");
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
  await host.submit("Write a file.");
  assert.equal(ui.approvals[0]?.tool, "Write");
  assert.ok(ui.tools.some((tool) => tool.name === "Write" && tool.state === "error" && tool.text.includes("denied")));
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  assert.equal(ui.answers.at(-1), "Write was denied.");
  assert.equal(host.outcome, "completed");
});

test("unconfirmed agents retain six tools but can only inspect files", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return { kind: "tool", name: "Read", arguments: { path: "input.txt" } };
    if (index === 1) return { kind: "tool", name: "Write", arguments: { path: "denied.txt", content: "must not exist" } };
    return { kind: "text", text: "Inspection complete. Writing unavailable." };
  });
  await writeFile(join(f.cwd, "input.txt"), "read-only evidence\n");
  await writeRunMarker(f.home, "unpersisted-session", { status: "active", runId: "unconfirmed", startedAt: Date.now(), pid: process.pid, cwd: f.cwd });
  const { host, ui } = await f.start();
  await host.submit("Inspect the input");
  assert.equal(host.outcome, "completed");
  assert.ok(ui.tools.some((tool) => tool.name === "Read" && tool.state === "done" && tool.text.includes("1: read-only evidence")));
  assert.equal(ui.approvals.length, 0);
  assert.ok(ui.tools.some((tool) => tool.name === "Write" && tool.state === "error"));
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  assert.equal(ui.answers.at(-1), "Inspection complete. Writing unavailable.");
  assert.deepEqual(f.requests[0]?.tools?.map((tool) => tool.function.name).sort(), ["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
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
  const f = await fixture(t, () => ({ kind: "tool", name: "Write", arguments: { path: "cancelled.txt", content: "must not exist" } }));
  const ui = new RecordingUI(() => new Promise<ApprovalDecision>(() => {}));
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
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
    ? { kind: "tool", name: "Write", arguments: { path: "result.txt", content: "first result" } }
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

test("resuming a compacted session displays messages from before compaction", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused" }));
  const encoded = Buffer.from(process.platform === "win32" ? f.cwd.toLowerCase() : f.cwd).toString("base64url");
  const manager = SessionManager.create(f.cwd, join(f.home, "sessions", encoded));
  manager.appendMessage({ role: "user", content: "The original requirement", timestamp: Date.now() });
  manager.appendCompaction("Summary of earlier work", null, 100);
  manager.appendMessage({ role: "user", content: "A later requirement", timestamp: Date.now() });
  const { ui } = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.deepEqual(ui.messages.filter((message) => message.kind === "user").map((message) => message.text),
    ["The original requirement", "A later requirement"]);
});

test("file mentions keep paths visible without copying file contents into history or model input", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "I will inspect the path." }));
  await writeFile(join(f.cwd, "large.txt"), "private file content\n".repeat(9000));
  await mkdir(join(f.cwd, "folder"));
  const { host, ui } = await f.start();
  const input = "Inspect @large.txt and @folder";
  await host.submit(input);
  assert.equal(host.outcome, "completed");
  assert.deepEqual(ui.messages.filter((message) => message.kind === "user").map((message) => message.text), [input]);
  const request = JSON.stringify(f.requests[0]?.messages);
  assert.ok(request.includes(input));
  assert.ok(!request.includes("private file content"));
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.deepEqual(resumed.ui.messages.filter((message) => message.kind === "user").map((message) => message.text), [input]);
});

test("image mentions above 128 KiB reach an image-capable model as image parts", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Image received." }), true);
  const png = largePng();
  assert.ok(png.length > 128 * 1024);
  await writeFile(join(f.cwd, "large.png"), png);
  const { host, ui } = await f.start();
  await host.submit("Inspect @large.png");
  assert.equal(host.outcome, "completed");
  assert.deepEqual(ui.messages.filter((message) => message.kind === "user").map((message) => message.text), ["Inspect @large.png"]);
  const userMessage = f.requests[0]?.messages.find((message) => message.role === "user");
  assert.ok(JSON.stringify(userMessage?.content).includes("image_url"));
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.deepEqual(resumed.ui.messages.filter((message) => message.kind === "user").map((message) => message.text), ["Inspect @large.png"]);
});

test("image mentions give a clear error when the selected model accepts text only", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unexpected request." }));
  await writeFile(join(f.cwd, "image.png"), largePng());
  const { host, ui } = await f.start();
  const query = "Inspect @image.png";
  await host.submit(query);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(ui.messages.filter((message) => message.kind === "user").map((message) => message.text), [query]);
  assert.ok(ui.messages.some((message) => message.kind === "error" && message.text.includes("does not support images")));
  await host.exit();
  const resumed = await f.start(new RecordingUI());
  assert.deepEqual(resumed.ui.messages.filter((message) => message.kind === "user"), []);
});

test("queued image mentions retain their image part when the running turn completes", { timeout: 30000 }, async (t) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, async (_request, index) => {
    if (index === 0) await gate;
    return { kind: "text", text: "Done." };
  }, true);
  await writeFile(join(f.cwd, "queued.png"), largePng());
  const { host } = await f.start();
  const run = host.submit("Start work");
  await until(() => f.requests.length === 1);
  await host.submit("Inspect @queued.png", "follow-up");
  release();
  await run;
  assert.equal(host.outcome, "completed");
  assert.ok(f.requests[1]?.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("image_url")));
});

test("legacy expanded file mentions display only the authored prompt", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const encoded = Buffer.from(process.platform === "win32" ? f.cwd.toLowerCase() : f.cwd).toString("base64url");
  const manager = SessionManager.create(f.cwd, join(f.home, "sessions", encoded));
  manager.appendMessage({ role: "user", content: 'Inspect @source.txt\n<file path="source.txt">\nprivate file content\n</file>', timestamp: Date.now() });
  const { ui } = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.deepEqual(ui.messages.filter((message) => message.kind === "user").map((message) => message.text), ["Inspect @source.txt"]);
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
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  const restoredShell = resumed.ui.tools.find((tool) => tool.name === "shell");
  assert.deepEqual(restoredShell?.details, { target: command, exitCode: 0 });
  assert.equal(restoredShell?.state, "done");
  assert.equal(f.requests.length, 1);
});

test("interrupt restores queued local commands without executing them", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "tool", name: "Write", arguments: { path: "blocked.txt", content: "blocked mutation" } }));
  const ui = new RecordingUI(() => new Promise<ApprovalDecision>(() => {}));
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
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
    if (index === 1) return { kind: "tool", name: "Write", arguments: { path: "recovery.txt", content: "forbidden during recovery" } };
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
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  assert.ok(ui.messages.some((message) => message.kind === "assistant" && message.text === "Saved original history."));
  assert.ok(ui.messages.some((message) => message.kind === "error" && message.text.includes("Execution unconfirmed.")));
  assert.equal(f.requests.length, 1);
  for (const command of ["/permissions ask", "/permissions full-access"]) await host.submit(command);
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  await assert.rejects(readFile(join(f.cwd, "recovery.txt")), { code: "ENOENT" });
  await host.submit("/fork");
  await host.submit("/permissions ask");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  assert.equal(ui.messages.filter((message) => message.kind === "error" && message.text.startsWith("Execution unconfirmed.")).length, 4);
  await host.submit("/new");
  await host.submit("/permissions ask");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  assert.equal(ui.messages.filter((message) => message.kind === "error" && message.text.startsWith("Execution unconfirmed.")).length, 5);
  await host.submit("!echo must remain blocked");
  assert.equal(host.outcome, "failed");
  assert.equal(ui.tools.filter((tool) => tool.name === "shell").length, 0);
  assert.equal(ui.approvals.length, 0);
  assert.equal(f.requests.length, 1);
  await assert.rejects(readFile(join(f.cwd, "recovery.txt")), { code: "ENOENT" });
  await host.exit();
  const restarted = await f.start();
  assert.equal(restarted.ui.statuses.at(-1)?.executionBlocked, true);
  await restarted.host.submit("/permissions full-access");
  assert.equal(restarted.ui.statuses.at(-1)?.executionBlocked, true);
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
  const broker = new ApprovalBroker(ui, () => "always-ask", () => {});
  const request: ApprovalRequest = { id: "first", tool: "Write", cwd: "/workspace", description: "Write file.txt\ncontent A" };
  assert.equal(await broker.authorize(request), true);
  assert.equal(await broker.authorize({ ...request, id: "another-call" }), true);
  assert.equal(ui.approvals.length, 1);
  assert.equal(await broker.authorize({ ...request, id: "content-change", description: "Write file.txt\ncontent B" }), false);
  assert.equal(await broker.authorize({ ...request, id: "tool-change", tool: "Edit" }), false);
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
  const broker = new ApprovalBroker(ui, () => "always-ask", (request) => changes.push(request));
  const request: ApprovalRequest = { id: "cancelled", tool: "Bash", cwd: "/workspace", description: "echo command" };
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
  let permission: Permission = "always-ask";
  let resolveDecision: (decision: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => { resolveDecision = resolve; });
  const ui: RecordingUI = new RecordingUI(async (): Promise<ApprovalDecision> => ui.approvals.length === 1 ? decision : "once");
  const broker = new ApprovalBroker(ui, () => permission, () => {});
  const request: ApprovalRequest = { id: "permission-change", tool: "Write", cwd: "/workspace", description: "Write output.txt\ncontent" };
  const pending = broker.authorize(request);
  permission = "ask-when-needed";
  resolveDecision("session");
  assert.equal(await pending, false);
  assert.equal(await broker.authorize(request), true);
  permission = "always-ask";
  assert.equal(await broker.authorize({ ...request, id: "fresh" }), true);
  assert.equal(ui.approvals.length, 2);
  assert.equal(await broker.authorize({ ...request, id: "once-needs-another-approval" }), true);
  assert.equal(ui.approvals.length, 3);
});

test("permission modes keep the same tool schemas and append-only hidden context across turns", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  await writeFile(join(f.cwd, "AGENTS.md"), "Project instruction A.");
  await mkdir(join(f.cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(f.cwd, ".pi", "extensions", "malicious.ts"), "throw new Error('project extensions must stay disabled');");
  const { host, ui } = await f.start(new RecordingUI(), ["--permissions", "always-ask"]);
  await host.submit("First task");
  const first = f.requests[0]; assert.ok(first);
  assert.deepEqual(first.tools?.map((tool) => tool.function.name), ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
  const context = first.messages.filter((message) => JSON.stringify(message.content).includes("<environment_context>"));
  assert.equal(context.length, 1);
  assert.equal(context[0]?.role, "user");
  assert.doesNotMatch(JSON.stringify(first.messages), /sandbox/i);
  assert.doesNotMatch(JSON.stringify(ui.messages), /sandbox/i);
  assert.match(JSON.stringify(context), /Project instruction A/);
  assert.doesNotMatch(JSON.stringify(first.messages.filter((message) => message.role === "system")), /Project instruction A|<current_date>/);

  await host.submit("/permissions ask-when-needed");
  await host.submit("Second task");
  const second = f.requests[1]; assert.ok(second);
  assert.deepEqual(second.tools, first.tools);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.equal(second.messages.filter((message) => JSON.stringify(message.content).includes("<environment_context>")).length, 1);
  await writeFile(join(f.cwd, "AGENTS.md"), "Project instruction B.");
  await host.submit("/permissions never-ask");
  await host.submit("Third task");
  const third = f.requests[2]; assert.ok(third);
  assert.deepEqual(third.tools, first.tools);
  assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages);
  assert.match(JSON.stringify(third.messages.at(-1)?.content), /Project instruction B/);
  assert.doesNotMatch(JSON.stringify(third.messages.at(-1)?.content), /<cwd>/);
  await unlink(join(f.cwd, "AGENTS.md"));
  await host.submit("Fourth task");
  assert.match(JSON.stringify(f.requests[3]?.messages.at(-1)?.content), /No trusted project instructions apply/);
  assert.deepEqual(ui.messages.filter((message) => message.kind === "user").map((message) => message.text), ["First task", "Second task", "Third task", "Fourth task"]);
  const paths = await f.sessions(); assert.equal(paths.length, 1);
  const saved = SessionManager.open(paths[0] ?? "").getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTEXT_MESSAGE);
  assert.equal(saved.length, 3);
  assert.ok(saved.every((entry) => entry.type === "custom_message" && !entry.display));
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.ok(!JSON.stringify(resumed.ui.messages).includes("environment_context"));
  await writeFile(join(f.cwd, "AGENTS.md"), "Restored project instructions.");
  await resumed.host.submit("Continue restored task");
  assert.match(JSON.stringify(f.requests[4]?.messages.at(-1)?.content), /Restored project instructions/);
  await resumed.host.submit("/fork");
  await writeFile(join(f.cwd, "AGENTS.md"), "Forked project instructions.");
  await resumed.host.submit("Continue fork");
  assert.match(JSON.stringify(f.requests[5]?.messages.at(-1)?.content), /Forked project instructions/);
  await resumed.host.submit("/new");
  await resumed.host.submit("New task");
  const last = f.requests.at(-1); assert.ok(last);
  assert.match(JSON.stringify(last.messages.at(-1)?.content), /<cwd>|Forked project instructions/);
  assert.doesNotMatch(JSON.stringify(last.messages), /First task/);
});

test("Ask When Needed executes ordinary writes, edits and shell commands without approvals", { timeout: 30000 }, async (t) => {
  const replies: Reply[] = [
    { kind: "tool", name: "Write", arguments: { path: "automatic.txt", content: "before" } },
    { kind: "tool", name: "Edit", arguments: { path: "automatic.txt", oldText: "before", newText: "after" } },
    { kind: "tool", name: "Bash", arguments: { command: "node --version" } },
    { kind: "text", text: "Done." },
  ];
  const f = await fixture(t, (_request, index) => { const reply = replies[index]; assert.ok(reply); return reply; });
  const { host, ui } = await f.start(new RecordingUI(async () => "deny"), ["--permissions", "ask-when-needed"]);
  await host.submit("Make and verify the change");
  assert.equal(host.outcome, "completed");
  assert.equal(await readFile(join(f.cwd, "automatic.txt"), "utf8"), "after");
  assert.equal(ui.approvals.length, 0);
});

test("finite danger policy precedes session grants, Never Ask skips approval and Always Ask exempts ls", async () => {
  const ui = new RecordingUI(async () => "session");
  let permission: Permission = "always-ask";
  const broker = new ApprovalBroker(ui, () => permission, () => {});
  const request = (command: string): ApprovalRequest => ({ id: command, tool: "Bash", cwd: "/workspace", description: command, invocation: { kind: "shell", command, shell: "/bin/sh" } });
  for (const tool of ["Read", "Grep", "Glob"]) assert.equal(await broker.authorize({ id: tool, tool, cwd: "/workspace", description: "inspect" }), true);
  assert.equal(await broker.authorize(request("ls -la")), true);
  assert.equal(ui.approvals.length, 0);
  assert.equal(await broker.authorize(request("echo hello")), true);
  assert.equal(await broker.authorize(request("echo hello")), true);
  assert.equal(ui.approvals.length, 1);
  assert.equal(await broker.authorize(request("ls > generated.txt")), true);
  assert.equal(ui.approvals.length, 2);
  permission = "ask-when-needed";
  assert.equal(await broker.authorize(request("shutdown now")), true);
  assert.equal(await broker.authorize(request("shutdown now")), true);
  assert.equal(ui.approvals.length, 4);
  assert.equal(await broker.authorize(request("echo '")), true);
  assert.equal(ui.approvals.length, 4);
  permission = "never-ask";
  assert.equal(await broker.authorize(request("shutdown now")), true);
  assert.equal(ui.approvals.length, 4);
});

test("mode changes during asynchronous command inspection cannot authorize a stale call", async () => {
  const ui = new RecordingUI();
  let permission: Permission = "always-ask";
  const broker = new ApprovalBroker(ui, () => permission, () => {});
  const pending = broker.authorize({ id: "stale", tool: "Bash", cwd: "/workspace", description: "ls", invocation: { kind: "shell", command: "ls", shell: "/bin/sh" } });
  permission = "never-ask";
  broker.reset();
  assert.equal(await pending, false);
  assert.equal(ui.approvals.length, 0);
});

test("manual compact preserves uppercase file tracking and refreshes hidden context when its anchor is removed", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return { kind: "tool", name: "Write", arguments: { path: "tracked.txt", content: "saved" } };
    if (index === 1) return { kind: "text", text: "Earlier detailed evidence. ".repeat(5000) };
    return { kind: "text", text: "Summary or completed answer." };
  });
  await writeFile(join(f.cwd, "AGENTS.md"), "Instructions before compact.");
  const { host, ui } = await f.start();
  await host.submit("Create the tracked file");
  await host.submit("Keep a recent turn");
  await host.submit("/compact");
  assert.equal(host.outcome, "completed");
  const paths = await f.sessions();
  const entries = SessionManager.open(paths[0] ?? "").getBranch();
  const compact = entries.findLast((entry) => entry.type === "compaction");
  assert.ok(compact?.type === "compaction");
  assert.match(compact.summary, /<modified-files>\ntracked.txt/);
  await writeFile(join(f.cwd, "AGENTS.md"), "Instructions after compact.");
  await host.submit("Continue after compact");
  const request = f.requests.at(-1); assert.ok(request);
  const context = request.messages.at(-1);
  assert.equal(context?.role, "user");
  assert.match(JSON.stringify(context?.content), /<cwd>/);
  assert.match(JSON.stringify(context?.content), /Instructions after compact/);
  assert.equal(ui.messages.some((message) => message.text.includes("<environment_context>")), false);
});

test("automatic compact during tool continuation reinjects current context before the next conversational request", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "Read", arguments: { path: "large.txt", limit: 2000 } }
    : { kind: "text", text: "Compacted evidence or completed answer." }, false, 24000);
  await writeFile(join(f.cwd, "large.txt"), "Large inspected evidence. ".repeat(5200));
  await writeFile(join(f.cwd, "AGENTS.md"), "Current automatic compact instructions.");
  const { host, ui } = await f.start();
  await host.submit("Inspect the large file");
  assert.equal(host.outcome, "completed");
  const paths = await f.sessions();
  const entries = SessionManager.open(paths[0] ?? "").getBranch();
  const compact = entries.findLast((entry) => entry.type === "compaction");
  assert.ok(compact?.type === "compaction");
  const after = f.requests.findLast((request) => request.messages.some((message) => JSON.stringify(message.content).includes("<summary>")));
  assert.ok(after);
  assert.equal(after.messages.at(-1)?.role, "user");
  assert.match(JSON.stringify(after.messages.at(-1)?.content), /<environment_context>|Current automatic compact instructions/);
  assert.equal(ui.messages.some((message) => message.text.includes("<environment_context>")), false);
});
