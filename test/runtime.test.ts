import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { parseCli } from "../src/app/args.js";
import { ArkHost } from "../src/app/host.js";
import { loadConfig } from "../src/config/settings.js";
import { ApprovalBroker } from "../src/permissions/approval.js";
import { CONTEXT_MESSAGE } from "../src/context/dynamic.js";
import { TOOL_NAMES } from "../src/tools/index.js";
import { resolveShell } from "../src/tools/shell-config.js";
import { ManagedShell } from "../src/tools/shell.js";
import { TOOL_REQUEST_STATE_ENTRY, TOOL_SETTINGS_ENTRY } from "../src/session/tool-settings.js";
import { parseCheckpoint } from "../src/compaction/checkpoint.js";
import { renderUser, textTokens, TOOL_PRUNING_MARKER } from "../src/compaction/policy.js";
import { SUMMARY_PREFIX } from "../src/compaction/prompts.js";
import { echoMcpTool, httpMcpFixture } from "./mcp-fixture.js";
import { inspectSession, readRunMarker, SessionLease, writeRunMarker } from "../src/session/storage.js";
import type { ApprovalDecision, ApprovalRequest, Choice, ChoiceOptions, Permission, SessionBrowserResult, SessionDetails, SessionItem, Status, ToolDetails, UserInterface } from "../src/app/types.js";

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional(),
}).passthrough();

test("Skills advertise only .agents metadata, expand selections, and read registered references", async (t) => {
  let reference = "";
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool", name: "read", arguments: { path: reference } } : { kind: "text", text: "Reviewed." });
  const directory = join(f.home, ".agents", "skills", "review");
  await mkdir(join(directory, "references"), { recursive: true });
  reference = join(directory, "references", "guide.md");
  await writeFile(reference, "Skill reference evidence.");
  await writeFile(join(directory, "SKILL.md"), "---\nname: review\ndescription: Review a patch.\n---\nPrivate full Skill instructions.");
  const secondDirectory = join(f.home, ".agents", "skills", "style");
  await mkdir(secondDirectory, { recursive: true });
  await writeFile(join(secondDirectory, "SKILL.md"), "---\nname: style\ndescription: Check style.\n---\nSecond full Skill instructions.");
  await mkdir(join(f.cwd, ".pi", "skills", "sentinel"), { recursive: true });
  await writeFile(join(f.cwd, ".pi", "skills", "sentinel", "SKILL.md"), "---\nname: sentinel\ndescription: Must not be discovered.\n---\nForbidden pi body.");
  const { host, ui } = await f.start();
  assert.equal(ui.statuses.at(-1)?.skills?.[0]?.name, "review");
  const input = "Use @skill:review and @skill:style with @skill:review to inspect the change.";
  await host.submit(input);
  const system = JSON.stringify(f.requests[0]?.messages.filter((message) => message.role === "system"));
  const user = JSON.stringify(f.requests[0]?.messages.filter((message) => message.role === "user"));
  assert.match(system, /Review a patch/); assert.doesNotMatch(system, /Private full Skill instructions|Second full Skill instructions|sentinel|Forbidden pi body|Use Read to load Skill files/);
  assert.match(user, /Private full Skill instructions/);
  assert.match(user, /Second full Skill instructions/);
  assert.equal(user.split('<skill-loaded name=\\"review\\">').length - 1, 1);
  assert.equal(user.split('<skill-loaded name=\\"style\\">').length - 1, 1);
  assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("Skill reference evidence")));
  assert.ok(ui.messages.some((message) => message.kind === "user" && message.text === input));
  assert.ok(ui.messages.every((message) => !/Private full Skill instructions|Second full Skill instructions|<skill-loaded/.test(message.text)));
  await host.submit("/skills disable style");
  await host.submit("/skills disable review");
  const count = f.requests.length;
  await host.submit("/skill:review inspect again");
  assert.equal(f.requests.length, count); assert.match(ui.messages.at(-1)?.text ?? "", /disabled/);
  assert.deepEqual(ui.statuses.at(-1)?.skills, []);
  await host.submit("An unrelated task.");
  assert.equal(toolPrompt(f.requests.at(-1), "skills"), "");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /No Skills are available for automatic selection/);
  await host.submit("/skills enable review");
  await host.submit("/skill:review inspect again");
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /Private full Skill instructions/);
});

test("Skill follow-ups retain submission-time instructions and hide expanded bodies in the queue", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (_request, index) => { if (index === 0) await gate; return { kind: "text", text: "Done." }; });
  const directory = join(f.cwd, ".agents", "skills", "review"); await mkdir(directory, { recursive: true });
  const file = join(directory, "SKILL.md");
  await writeFile(file, "---\nname: review\ndescription: Inspect changes.\n---\nQueued Skill version one.");
  const { host, ui } = await f.start();
  const active = host.submit("Start work.");
  await until(() => f.requests.length === 1);
  await host.submit("@skill:review inspect", "follow-up");
  assert.ok(ui.statuses.at(-1)?.queued.some((text) => text.includes("@skill:review")));
  assert.ok(ui.statuses.at(-1)?.queued.every((text) => !text.includes("Queued Skill version")));
  await writeFile(file, "---\nname: review\ndescription: Inspect changes.\n---\nQueued Skill version two.");
  await host.submit("/skills disable review");
  assert.match(ui.messages.at(-1)?.text ?? "", /Wait until/);
  release(); await active;
  assert.match(JSON.stringify(f.requests[1]?.messages), /Queued Skill version one/);
  assert.doesNotMatch(JSON.stringify(f.requests[1]?.messages), /Queued Skill version two/);
});

test("Skills reload discovers new entries and manual-only Skills load only on selection", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const { host, ui } = await f.start();
  const directory = join(f.cwd, ".agents", "skills", "manual"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: manual\ndescription: Manual workflow.\ndisable-model-invocation: true\n---\nSelected manual instructions.");
  assert.deepEqual(ui.statuses.at(-1)?.skills, []);
  await host.submit("/skills reload");
  assert.equal(f.requests.length, 0);
  assert.equal(ui.statuses.at(-1)?.skills?.[0]?.name, "manual");
  await host.submit("Ordinary task.");
  assert.doesNotMatch(JSON.stringify(f.requests[0]?.messages), /Manual workflow|Selected manual instructions/);
  await host.submit("@skill:manual perform the task");
  assert.match(JSON.stringify(f.requests.at(-1)?.messages.filter((message) => message.role === "user")), /Selected manual instructions/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages.filter((message) => message.role === "system")), /Manual workflow|Selected manual instructions/);
  const viewer = await f.start(new RecordingUI(), ["resume", ui.statuses.at(-1)?.sessionId ?? ""]);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
  await viewer.host.submit("/skills list");
  assert.match(viewer.ui.inspections.at(-1)?.text ?? "", /manual/);
  await viewer.host.submit("/skills disable manual");
  assert.match(viewer.ui.messages.at(-1)?.text ?? "", /Read-only/);
  assert.equal(viewer.ui.statuses.at(-1)?.skills?.[0]?.name, "manual");
});

test("Skill queues return only authored text when edited or interrupted", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "tool", name: "write", arguments: { path: "cancelled.txt", content: "must not exist" } }));
  const directory = join(f.cwd, ".agents", "skills", "review"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: review\ndescription: Inspect changes.\n---\nHidden queued instructions.");
  const ui = new RecordingUI(() => new Promise<ApprovalDecision>(() => {}));
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
  const run = host.submit("Start a write");
  await until(() => ui.statuses.at(-1)?.state.kind === "awaiting-approval");
  await host.submit("@skill:review steering", "steer");
  await host.submit("@skill:review follow-up", "follow-up");
  await host.editPrevious();
  assert.equal(ui.draft(), "@skill:review follow-up");
  await host.interrupt(); await run;
  assert.equal(ui.draft(), "@skill:review follow-up\n\n@skill:review steering");
  assert.equal(f.requests.length, 1);
  await assert.rejects(readFile(join(f.cwd, "cancelled.txt")), { code: "ENOENT" });
});
type ModelRequest = z.infer<typeof requestSchema>;
const defaultShell = resolveShell();
const usesPowerShell = defaultShell.kind === "powershell";

function toolPrompt(request: ModelRequest | undefined, section: "builtin_tool_mode" | "mcp_tool_modes" | "skills" | "shell_environment"): string {
  assert.ok(request);
  const text = request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
  return [...text.matchAll(new RegExp(`<${section}>\\n([\\s\\S]*?)\\n</${section}>`, "g"))].at(-1)?.[1] ?? "";
}
type ToolReply = { kind: "tool"; name: string; arguments: object };
type Reply = { kind: "text"; text: string; thinking?: string; finish?: "stop" | "length" } | ToolReply | { kind: "tools"; calls: ToolReply[] } | { kind: "error"; status: number; message: string };

test("global and recursive workspace rules reach the model as hidden scoped user context", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  await writeFile(join(f.home, "AGENTS.md"), "Global shared rule.");
  await mkdir(join(f.cwd, "child"));
  await writeFile(join(f.cwd, "child", "AGENTS.md"), "Scoped child rule.");
  const { host, ui } = await f.start();
  await host.submit("Inspect the workspace.");
  const request = f.requests[0];
  assert.ok(request);
  const userContext = request.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
  assert.match(userContext, /Global shared rule/);
  assert.match(userContext, /Scoped child rule/);
  assert.match(userContext, /sibling directory rules do not apply to each other/);
  assert.doesNotMatch(JSON.stringify(request.messages.filter((message) => message.role === "system")), /Global shared rule|Scoped child rule/);
  assert.ok(ui.messages.every((message) => !/Global shared rule|Scoped child rule/.test(message.text)));
  await host.submit("Inspect again.");
  assert.equal(f.requests[1]?.messages.filter((message) => JSON.stringify(message.content).includes("Global shared rule")).length, 1);
});

test("untrusted runtime keeps global instructions but omits workspace instructions", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", trustedWorkspaces: [] }));
  await writeFile(join(f.home, "AGENTS.md"), "Trusted global rule.");
  await writeFile(join(f.cwd, "AGENTS.md"), "Untrusted project rule.");
  const { host } = await f.start();
  await host.submit("Inspect the workspace.");
  const context = JSON.stringify(f.requests[0]?.messages);
  assert.match(context, /Trusted global rule/);
  assert.doesNotMatch(context, /Untrusted project rule/);
});

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
  inspections: Array<{ title: string; text: string }> = [];
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
  async choose(title: string, _choices: Choice[]): Promise<string | null> { return title.startsWith("MCP startup incomplete") ? "continue" : null; }
  async inspect(title: string, text: string): Promise<void> { this.inspections.push({ title, text }); }
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

test("switching sessions keeps both model requests running and restores separate output and drafts", { timeout: 30000 }, async (t) => {
  let releaseA = () => {};
  let releaseB = () => {};
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  const f = await fixture(t, async (_request, index) => {
    await (index === 0 ? gateA : gateB);
    return { kind: "text", text: index === 0 ? "Answer for session A" : "Answer for session B" };
  });
  t.after(() => { releaseA(); releaseB(); });
  const { host, ui } = await f.start();
  const idA = ui.statuses.at(-1)?.sessionId;
  assert.ok(idA);
  const runA = host.submit("Only session A knows this prompt");
  await until(() => f.requests.length === 1);
  ui.setDraft("Draft for A");
  await host.submit("/new");
  const idB = ui.statuses.at(-1)?.sessionId;
  assert.ok(idB && idB !== idA);
  assert.equal(ui.draft(), "");
  const runB = host.submit("Only session B knows this prompt");
  await until(() => f.requests.length === 2);
  assert.ok(ui.statuses.at(-1)?.backgroundSessions?.some((item) => item.id === idA && item.state === "working"));
  releaseB(); await runB;
  assert.deepEqual(ui.answers, ["Answer for session B"]);
  releaseA(); await runA;
  assert.deepEqual(ui.answers, ["Answer for session B"]);
  ui.setDraft("Draft for B");
  await host.submit(`/sessions ${idA}`);
  assert.equal(ui.statuses.at(-1)?.sessionId, idA);
  assert.equal(ui.draft(), "Draft for A");
  assert.equal(ui.answers.at(-1), "Answer for session A");
  await host.submit(`/sessions ${idB}`);
  assert.equal(ui.draft(), "Draft for B");
  const histories = await Promise.all((await f.sessions()).map((path) => readFile(path, "utf8")));
  assert.equal(histories.length, 2);
  for (const history of histories) assert.notEqual(history.includes("Only session A knows"), history.includes("Only session B knows"));
});

test("editing the previous prompt creates a separate session without changing the original runtime", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const { host, ui } = await f.start();
  await host.submit("Original first prompt");
  await host.submit("Original second prompt");
  const originalId = ui.statuses.at(-1)?.sessionId;
  assert.ok(originalId);
  ui.setDraft("Original draft");
  await host.editPrevious();
  const branchId = ui.statuses.at(-1)?.sessionId;
  assert.ok(branchId && branchId !== originalId);
  assert.equal(ui.draft(), "Original second prompt");
  await host.submit("Revised second prompt");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /Original second prompt/);
  await host.submit(`/sessions ${originalId}`);
  assert.equal(ui.statuses.at(-1)?.sessionId, originalId);
  assert.equal(ui.draft(), "Original draft");
  await host.submit("Continue original session");
  const original = (await f.sessions()).find((path) => path.includes(originalId));
  assert.ok(original);
  const history = await readFile(original, "utf8");
  assert.match(history, /Original second prompt/);
  assert.match(history, /Continue original session/);
  assert.doesNotMatch(history, /Revised second prompt/);
  const viewer = await f.start(new RecordingUI(), ["resume", originalId]);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
});

test("two terminal hosts can run different sessions in the same workspace", { timeout: 30000 }, async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return { kind: "text", text: "Concurrent answer" }; });
  t.after(() => release());
  const first = await f.start();
  const second = await f.start();
  assert.equal(first.ui.statuses.at(-1)?.viewer, false);
  assert.equal(second.ui.statuses.at(-1)?.viewer, false);
  assert.notEqual(first.ui.statuses.at(-1)?.sessionId, second.ui.statuses.at(-1)?.sessionId);
  const runs = [first.host.submit("Terminal A"), second.host.submit("Terminal B")];
  await until(() => f.requests.length === 2);
  release(); await Promise.all(runs);
  assert.equal(first.host.outcome, "completed");
  assert.equal(second.host.outcome, "completed");
});

test("real CLI processes run separate sessions together and reject concurrent input into the same session", { timeout: 60000 }, async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return { kind: "text", text: "Process completed" }; });
  t.after(() => release());
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const args = ["--import", "tsx", cli, "--cwd", f.cwd, "--home", f.home, "--model", "fixture/test", "--print", "--full-access"];
  const first = execute(process.execPath, [...args, "Process A"], { timeout: 45000, windowsHide: true });
  await until(() => f.requests.length === 1, 20000);
  const files = await f.sessions();
  const file = files[0]; assert.ok(file);
  const saved = await inspectSession(file, f.cwd);
  await assert.rejects(execute(process.execPath, [...args, "resume", saved.id, "Blocked input"], { timeout: 20000, windowsHide: true }), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /Read-only viewer/);
    return true;
  });
  assert.equal(f.requests.length, 1);
  const second = execute(process.execPath, [...args, "Process B"], { timeout: 25000, windowsHide: true });
  await until(() => f.requests.length === 2, 20000);
  release();
  const completed = await Promise.all([first, second]);
  assert.ok(completed.every((result) => result.stdout.includes("Process completed")));
  assert.equal((await f.sessions()).length, 2);
  assert.doesNotMatch(await readFile(file, "utf8"), /Blocked input|Process B/);
});

test("a session viewer follows saved history, cannot send, and can acquire input after its owner exits", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => ({ kind: "text", text: `Answer ${index}` }));
  const owner = await f.start();
  await owner.host.submit("Owner first prompt");
  const id = owner.ui.statuses.at(-1)?.sessionId;
  assert.ok(id);
  const viewer = await f.start(new RecordingUI(), ["resume", id]);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
  const path = (await f.sessions())[0];
  assert.ok(path);
  const saved = await readFile(path, "utf8");
  for (const text of ["Blocked prompt", "/rename blocked", "/compact"]) await viewer.host.submit(text);
  assert.equal(f.requests.length, 1);
  assert.equal(await readFile(path, "utf8"), saved);
  await owner.host.submit("Owner second prompt");
  await until(() => viewer.ui.messages.some((message) => message.text === "Answer 1"));
  await owner.host.exit();
  await viewer.host.submit(`/sessions ${id}`);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, false);
  await viewer.host.submit("New owner prompt");
  assert.equal(viewer.host.outcome, "completed");
  assert.equal(f.requests.length, 3);
});

test("background approvals wait for their session and never open over the foreground session", { timeout: 30000 }, async (t) => {
  let releaseA = () => {};
  let releaseB = () => {};
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  const f = await fixture(t, async (_request, index) => {
    if (index === 0) { await gateA; return { kind: "tool", name: "write", arguments: { path: "background.txt", content: "approved A" } }; }
    if (index === 1) await gateB;
    return { kind: "text", text: "Done" };
  });
  t.after(() => { releaseA(); releaseB(); });
  const { host, ui } = await f.start(new RecordingUI(), ["--permissions", "always-ask"]);
  const idA = ui.statuses.at(-1)?.sessionId;
  assert.ok(idA);
  const runA = host.submit("Write from A");
  await until(() => f.requests.length === 1);
  await host.submit("/new");
  const runB = host.submit("Work in B");
  await until(() => f.requests.length === 2);
  releaseA();
  await until(() => Boolean(ui.statuses.at(-1)?.backgroundSessions?.some((item) => item.id === idA && item.state === "needs-you")));
  assert.equal(ui.approvals.length, 0);
  releaseB(); await runB;
  await host.submit(`/sessions ${idA}`);
  await runA;
  assert.equal(ui.approvals.length, 1);
  assert.equal(await readFile(join(f.cwd, "background.txt"), "utf8"), "approved A");
});

async function until(predicate: () => boolean, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the agent state.");
    await delay(10);
  }
}

function stream(response: ServerResponse, reply: Reply, index: number): void {
  if (reply.kind === "error") {
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: reply.message, type: "invalid_request_error", code: reply.status === 400 ? "context_length_exceeded" : "fixture_error" } }));
    return;
  }
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
    chunk({}, reply.finish ?? "stop");
  } else {
    for (const [callIndex, call] of (reply.kind === "tools" ? reply.calls : [reply]).entries()) {
      const args = JSON.stringify(call.arguments);
      const midpoint = Math.floor(args.length / 2);
      chunk({ tool_calls: [{ index: callIndex, id: `call-${index}-${callIndex}`, type: "function", function: { name: call.name, arguments: args.slice(0, midpoint) } }] });
      chunk({ tool_calls: [{ index: callIndex, function: { arguments: args.slice(midpoint) } }] });
    }
    chunk({}, "tool_calls");
  }
  response.write(`data: ${JSON.stringify({ id: `chat-${index}`, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function fixture(t: TestContext, respond: (request: ModelRequest, index: number) => Reply | Promise<Reply>, imageInput = false, contextWindow = 128000,
  compat: { supportsMidConvoSystemMessages?: boolean; supportsMidConvoToolAdditions?: boolean } = {}) {
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
      { id: "test", name: "Local test model", reasoning: false, input: imageInput ? ["text", "image"] : ["text"], contextWindow, maxTokens: 4096, compat },
      { id: "alternate", name: "Alternate test model", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
    ],
  } } }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", trustedWorkspaces: [cwd] }));
  const hosts: ArkHost[] = [];
  const start = async (ui = new RecordingUI(), args: string[] = []) => {
    const host = new ArkHost(parseCli(["--cwd", cwd, "--home", home, "--model", "fixture/test", "--permissions", "never-ask", ...args]), ui, { userHome: home });
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

for (const text of ["Partial answer", ""]) {
  test(`output limit exhaustion preserves ${text ? "partial text" : "reasoning-only output"} and fails after bounded continuation`, async (t) => {
    const f = await fixture(t, () => ({ kind: "text", text, thinking: "Reasoning before the output limit.", finish: "length" }));
    const { host, ui } = await f.start();
    await host.submit("Complete this task.");
    assert.equal(host.outcome, "failed");
    assert.equal(f.requests.length, 3);
    assert.equal(ui.answers.length, 3);
    assert.ok(ui.answers.every((answer) => answer === text));
    assert.match(ui.messages.find((message) => message.kind === "error")?.text ?? "", /output.*limit|truncated/i);
    const path = (await f.sessions())[0]; assert.ok(path);
    const manager = SessionManager.open(path);
    const answers = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    assert.equal(answers.length, 3);
    assert.ok(answers.every((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length"));
    assert.equal((await readRunMarker(f.home, manager.getSessionId()))?.status, "failed");
  });
}

test("output limit continuation keeps completed tool results without replaying the tool", async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "write", arguments: { path: "once.txt", content: "Saved once." } }
    : index === 1 ? { kind: "text", text: "The saved file", finish: "length" } : { kind: "text", text: " contains the result." });
  const { host, ui } = await f.start();
  await host.submit("Write the result and explain it.");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 3);
  assert.equal(ui.tools.filter((tool) => tool.name === "write" && tool.state === "done").length, 1);
  assert.equal(await readFile(join(f.cwd, "once.txt"), "utf8"), "Saved once.");
  assert.ok(f.requests[2]?.messages.some((message) => message.role === "tool"));
  assert.match(JSON.stringify(f.requests[2]?.messages), /The saved file/);
});

test("output limit continuation stops on user cancellation", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (_request, index) => {
    if (index > 0) await gate;
    return { kind: "text", text: "Partial", finish: "length" };
  });
  const { host } = await f.start();
  const run = host.submit("Complete this task.");
  await until(() => f.requests.length === 2);
  await host.interrupt(); await run;
  assert.equal(host.outcome, "interrupted");
  assert.equal(f.requests.length, 2);
});

test("output limit continuation stops on insufficient provider balance", async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "text", text: "Partial", finish: "length" }
    : { kind: "error", status: 402, message: "Insufficient account balance" });
  const { host, ui } = await f.start();
  await host.submit("Complete this task.");
  assert.equal(host.outcome, "failed");
  assert.equal(f.requests.length, 2);
  assert.ok(ui.messages.some((message) => message.kind === "error" && /Insufficient account balance/.test(message.text)));
});

test("normal empty stop is completed without guessing that the response was truncated", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "", finish: "stop" }));
  const { host } = await f.start();
  await host.submit("Complete this task.");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 1);
});

test("CLI exits unsuccessfully when output limit continuations are exhausted", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Partial answer", finish: "length" }));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath,
    ["--import", "tsx", cli, "--cwd", f.cwd, "--home", f.home, "--model", "fixture/test", "--print", "Complete the task."],
    { timeout: 25000, windowsHide: true }), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error && "stdout" in error);
      assert.equal(error.code, 1);
      assert.match(String(error.stderr), /truncated by the output limit/);
      assert.match(String(error.stdout), /Partial answer/);
      return true;
    });
  assert.equal(f.requests.length, 3);
});

for (const permission of ["always-ask", "ask-when-needed", "never-ask"]) {
  test(`CodeMode MCP ${permission} uses nested permissions and keeps hidden tools unreachable`, async (t) => {
    const code = `text(await searchTools("echo")); text(await Promise.allSettled([
      tools.mcp__fixture__echo({text:"nested"}), Promise.resolve().then(() => tools.mcp__fixture__hidden({text:"forbidden"}))
    ])); text(typeof models); text(typeof process);`;
    const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool", name: "codemode", arguments: { code } } : { kind: "text", text: "Done." });
    const mcp = await httpMcpFixture(t, { tools: [echoMcpTool, { ...echoMcpTool, name: "hidden" }] });
    await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, disabledTools: ["hidden"] } } }));
    const { host, ui } = await f.start(new RecordingUI(async () => "deny"), ["--permissions", permission]);
    await host.submit("Call the tools from CodeMode.");
    assert.ok(f.requests[0]?.tools?.some((tool) => tool.function.name === "codemode"));
    assert.ok(!f.requests[0]?.tools?.some((tool) => tool.function.name.startsWith("mcp__")));
    assert.equal(ui.approvals.length, permission === "never-ask" ? 0 : 1);
    assert.deepEqual(mcp.calls.map((call) => call.name), permission === "never-ask" ? ["echo"] : []);
    assert.ok(ui.tools.some((tool) => tool.name === "mcp__fixture__echo"));
    const output = f.requests[1]?.messages.find((message) => message.role === "tool")?.content;
    assert.match(JSON.stringify(output), /undefined/);
  });
}

test("CodeMode composes SDK basic tools and MCP structured results, serializes approvals and restores nested history", async (t) => {
  const code = `await Promise.all([tools.write({path:"one.txt",content:"first"}), tools.write({path:"two.txt",content:"second"})]);
    const result = await tools.mcp__fixture__echo({text:"structured"}); text(result.structuredContent.answer);
    text(await tools.read({path:"one.txt"}));`;
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool", name: "codemode", arguments: { code } } : { kind: "text", text: "Done." });
  const mcp = await httpMcpFixture(t, { tools: [{ ...echoMcpTool, outputSchema: { type: "object", properties: { answer: { type: "number" } } } }],
    call: () => ({ content: [{ type: "text", text: "summary" }], structuredContent: { answer: 42 } }),
  });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  let pending = 0;
  const ui = new RecordingUI(async () => { assert.equal(++pending, 1); await delay(10); pending--; return "once"; });
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
  await host.submit("Compose tools.");
  assert.equal(await readFile(join(f.cwd, "one.txt"), "utf8"), "first");
  assert.equal(await readFile(join(f.cwd, "two.txt"), "utf8"), "second");
  assert.equal(ui.approvals.length, 3);
  const output = JSON.stringify(f.requests[1]?.messages.find((message) => message.role === "tool")?.content);
  assert.match(output, /42/); assert.match(output, /first/);
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.ok(resumed.ui.tools.some((tool) => tool.name === "write" && tool.details?.target === "one.txt" && tool.state === "done"));
});

for (const mode of ["direct", "codemode"]) {
  test(`MCP coercion in ${mode} mode preserves approved arguments and blocks invalid or denied calls`, async (t) => {
    const inputs = [{ limit: "7", tags: "one" }, { limit: "not-a-number", tags: [] }, { limit: "9", tags: "two" }];
    const f = await fixture(t, (_request, index) => {
      const args = inputs[index];
      if (!args) return { kind: "text", text: "Done." };
      return mode === "direct"
        ? { kind: "tool", name: "mcp__fixture__coerce", arguments: args }
        : { kind: "tool", name: "codemode", arguments: { code: `text(await tools.mcp__fixture__coerce(${JSON.stringify(args)}));` } };
    });
    const mcp = await httpMcpFixture(t, { tools: [{ name: "coerce", description: "Accept a number and a string array.", inputSchema: {
      type: "object", properties: { limit: { type: "number" }, tags: { type: "array", items: { type: "string" } } }, required: ["limit", "tags"],
    } }] });
    await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: mode } } }));
    let decisions = 0;
    const ui = new RecordingUI(async () => ++decisions === 1 ? "once" : "deny");
    const { host } = await f.start(ui, ["--permissions", "always-ask"]);
    await host.submit("Check converted MCP arguments, validation and denial.");
    assert.deepEqual(mcp.calls.map((call) => call.arguments), [{ limit: 7, tags: ["one"] }]);
    assert.equal(ui.approvals.length, 2);
    assert.deepEqual(ui.approvals.map((approval) => {
      assert.equal(approval.invocation?.kind, "mcp");
      if (approval.invocation?.kind !== "mcp") throw new Error("Expected an MCP approval.");
      return approval.invocation.arguments;
    }), [{ limit: 7, tags: ["one"] }, { limit: 9, tags: ["two"] }]);
    assert.equal(f.requests.length, 4);
    assert.equal(host.outcome, "completed");
  });
}

test("CodeMode queues across sessions, cancels a waiting run and reuses worker slots", { timeout: 45000 }, async (t) => {
  const previousLimit = process.env.PI_CODEMODE_MAX_WORKERS;
  process.env.PI_CODEMODE_MAX_WORKERS = "2";
  t.after(() => {
    if (previousLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
    else process.env.PI_CODEMODE_MAX_WORKERS = previousLimit;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, (request) => request.messages.some((message) => message.role === "tool")
    ? { kind: "text", text: "Worker completed." }
    : { kind: "tool", name: "codemode", arguments: { code: 'text(await tools.mcp__fixture__echo({text:"worker"}));' } });
  let entered = 0;
  const mcp = await httpMcpFixture(t, { call: async () => {
    if (++entered <= 2) await gate;
    return { content: [{ type: "text", text: "Worker released." }] };
  } });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const first = await f.start();
  const second = await f.start();
  const waiting = await f.start();
  const next = await f.start();
  const firstRun = first.host.submit("Hold the first worker.");
  await until(() => mcp.calls.length === 1);
  const secondRun = second.host.submit("Hold the second worker.");
  await until(() => mcp.calls.length === 2);
  const waitingRun = waiting.host.submit("Wait for a worker.");
  await until(() => waiting.ui.tools.some((tool) => tool.name === "codemode" && tool.state === "running"));
  await waiting.host.interrupt();
  await waitingRun;
  assert.equal(waiting.host.outcome, "interrupted");
  assert.equal(mcp.calls.length, 2);
  const nextRun = next.host.submit("Run after a worker becomes free.");
  await until(() => next.ui.tools.some((tool) => tool.name === "codemode" && tool.state === "running"));
  assert.equal(mcp.calls.length, 2);
  release();
  await Promise.all([firstRun, secondRun, nextRun]);
  assert.equal(mcp.calls.length, 3);
  assert.deepEqual([first.host.outcome, second.host.outcome, next.host.outcome], ["completed", "completed", "completed"]);
  assert.ok(next.ui.tools.some((tool) => tool.name === "codemode" && tool.state === "done" && tool.text.includes("Worker released.")));
});

for (const source of ["MCP", "bash", "CodeMode"]) {
  test(`${source} truncated output can be read without granting writes or access to other external files`, async (t) => {
    let outputPath = "";
    let privatePath = "";
    const longOutput = "prefix evidence line\n".repeat(2500) + "middle evidence marker\n" + "suffix evidence line\n".repeat(2500);
    const f = await fixture(t, (request, index) => {
      if (index === 0) return source === "MCP" ? { kind: "tool", name: "mcp__fixture__echo", arguments: { text: "large" } }
        : source === "CodeMode" ? { kind: "tool", name: "codemode", arguments: { code: `text(${JSON.stringify(longOutput)});` } }
          : { kind: "tool", name: "bash", arguments: { command: `node -e "process.stdout.write('prefix evidence line\\n'.repeat(2500)+'middle evidence marker\\n'+'suffix evidence line\\n'.repeat(2500))"` } };
      if (index === 1) {
        const output = request.messages.findLast((message) => message.role === "tool")?.content;
        assert.equal(typeof output, "string");
        const match = /Full output: (.*?)(?: \(read (?:it )?with offset\/limit\)|\])/.exec(String(output));
        assert.ok(match?.[1]); outputPath = match[1];
        if (source === "CodeMode") assert.doesNotMatch(String(output), /middle evidence marker/);
        return { kind: "tool", name: "read", arguments: { path: outputPath, offset: 2501, limit: 1 } };
      }
      if (index === 2) return { kind: "tool", name: "write", arguments: { path: outputPath, content: "forbidden replacement" } };
      if (index === 3) return { kind: "tool", name: "read", arguments: { path: privatePath } };
      return { kind: "text", text: "Done." };
    });
    privatePath = join(f.home, "private.txt");
    await writeFile(privatePath, "outside-private-evidence");
    if (source === "MCP") {
      const mcp = await httpMcpFixture(t, { call: () => ({ content: [{ type: "text", text: longOutput }] }) });
      await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
    }
    const { host, ui } = await f.start();
    t.after(async () => { if (outputPath) await rm(outputPath, { force: true }); });
    await host.submit("Inspect the middle of the output.");
    assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("middle evidence marker")));
    assert.ok(ui.tools.some((tool) => tool.name === "write" && tool.state === "error"));
    assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "error" && tool.text.includes("workspace")));
    assert.equal(await readFile(outputPath, "utf8"), longOutput);
    assert.doesNotMatch(JSON.stringify(f.requests), /outside-private-evidence/);
  });
}

test("CodeMode-only reads registered large output in a later script with pagination", async (t) => {
  let outputPath = "";
  const f = await fixture(t, (request, index) => {
    if (index === 0) return { kind: "tool", name: "codemode", arguments: {
      code: 'text("start\\n".repeat(10000) + "middle evidence marker\\n" + "end\\n".repeat(10000));',
    } };
    if (index === 1) {
      const output = String(request.messages.findLast((message) => message.role === "tool")?.content);
      const match = /Full output: (.*?) \(read with offset\/limit\)/.exec(output);
      assert.ok(match?.[1]); outputPath = match[1];
      assert.doesNotMatch(output, /middle evidence marker/);
      return { kind: "tool", name: "codemode", arguments: {
        code: `text(await tools.read(${JSON.stringify({ path: outputPath, offset: 10001, limit: 1 })}));`,
      } };
    }
    return { kind: "text", text: "Done." };
  });
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: "codemode-only" }));
  const { host, ui } = await f.start();
  t.after(async () => { if (outputPath) await rm(outputPath, { force: true }); });
  await host.submit("Read a page from CodeMode output.");
  assert.equal(host.outcome, "completed");
  assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("middle evidence marker")));
  assert.ok(f.requests.every((request) => !request.tools?.some((tool) => tool.function.name === "read")));
});

test("/mcp exposure persists without changing declarations until successful compact", async (t) => {
  const f = await fixture(t, (_request, index) => ({ kind: "text", text: index === 0 ? "Earlier inspected evidence. ".repeat(5000) : "Done." }));
  const mcp = await httpMcpFixture(t);
  const path = join(f.home, "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const { host } = await f.start();
  await host.submit("Initial tools.");
  assert.match(toolPrompt(f.requests[0], "mcp_tool_modes"), /codemode: Access these MCP tools through codemode/);
  assert.ok(!f.requests[0]?.tools?.some((tool) => tool.function.name.startsWith("mcp__")));
  await host.submit("/mcp exposure fixture direct");
  assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.fixture.exposure, "direct");
  await host.submit("Updated tools.");
  assert.match(toolPrompt(f.requests[1], "mcp_tool_modes"), /codemode: Access these MCP tools through codemode/);
  assert.doesNotMatch(toolPrompt(f.requests[1], "mcp_tool_modes"), /direct: MCP tools/);
  assert.ok(!f.requests[1]?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
  await host.submit("/mcp reconnect fixture");
  await host.submit("Keep the session exposure.");
  assert.ok(!f.requests.at(-1)?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
  await host.submit("/compact");
  assert.equal(host.outcome, "completed");
  await host.submit("Apply after compact.");
  assert.match(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), /direct: MCP tools/);
  assert.doesNotMatch(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), /codemode: Access these MCP tools through codemode/);
  assert.ok(f.requests.at(-1)?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
});

for (const mode of ["direct", "codemode", "codemode-only"]) {
  test(`selected shell instructions reach the actual LLM request in ${mode} mode`, async (t) => {
    const command = usesPowerShell ? "[Console]::Write('中文 shell verified')" : "printf '%s' '中文 shell verified'";
    const f = await fixture(t, (_request, index) => index > 0 ? { kind: "text", text: "Done." }
      : mode === "codemode-only" ? { kind: "tool", name: "codemode", arguments: { code: `text(await tools.bash(${JSON.stringify({ command })}));` } }
      : { kind: "tool", name: "bash", arguments: { command } });
    await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: mode }));
    const { host } = await f.start();
    await host.submit("Verify the current shell.");
    const prompt = toolPrompt(f.requests[0], "shell_environment");
    assert.ok(!prompt.includes(JSON.stringify(defaultShell.executable)), prompt);
    assert.match(prompt, usesPowerShell ? /Use PowerShell syntax/ : /Use POSIX shell syntax/);
    const declared = f.requests[0]?.tools?.find((tool) => tool.function.name === "bash");
    if (mode !== "codemode-only") {
      assert.ok(declared);
      assert.match(String(declared.function.description), usesPowerShell ? /Execute a PowerShell command/ : /Execute a bash command/i);
    }
    assert.ok(f.requests.at(-1)?.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("中文 shell verified")));
    const environment = JSON.stringify(f.requests[0]?.messages.filter((message) => message.role === "user"));
    assert.ok(environment.includes(JSON.stringify(defaultShell.executable).slice(1, -1)), environment);
    assert.doesNotMatch(environment, /project_instructions|No trusted project instructions/);
    for (const tool of f.requests[0]?.tools ?? []) {
      assert.ok(!String(tool.function.description).includes(defaultShell.executable));
    }
  });
}

for (const mode of ["direct", "codemode", "codemode-only"]) {
  test(`unexpected shell changes refresh the next continuation prompt in ${mode} mode`, { skip: process.platform !== "win32" || defaultShell.kind !== "posix", timeout: 30000 }, async (t) => {
    let current = defaultShell;
    const powershell = resolveShell({ executable: "powershell.exe" });
    t.mock.getter(ManagedShell.prototype, "configuration", () => current);
    const execute = ManagedShell.prototype.execute;
    let completed = 0;
    t.mock.method(ManagedShell.prototype, "execute", async function (this: ManagedShell, ...args: Parameters<ManagedShell["execute"]>) {
      const result = await execute.apply(this, args);
      completed++;
      current = completed === 1 ? powershell : defaultShell;
      return result;
    });
    const f = await fixture(t, (request, index) => {
      const prompt = toolPrompt(request, "shell_environment");
      assert.ok(!prompt.includes(JSON.stringify(current.executable)), prompt);
      assert.match(prompt, current.kind === "powershell" ? /Use PowerShell syntax/ : /Use POSIX shell syntax/);
      if (mode !== "codemode-only") {
        const description = request.tools?.find((tool) => tool.function.name === "bash")?.function.description;
        assert.match(String(description), current.kind === "powershell" ? /Execute a PowerShell command/ : /Execute a bash command/i);
      }
      const userContext = JSON.stringify(request.messages.filter((message) => message.role === "user"));
      const latestShell = [...userContext.matchAll(/<shell>(.*?)<\/shell>/g)].at(-1)?.[1];
      assert.equal(latestShell, JSON.stringify(current.executable).slice(1, -1));
      if (index === 3) return { kind: "text", text: "Verified every continuation." };
      const command = current.kind === "powershell" ? `[Console]::Write('verified ${index}')` : `printf 'verified ${index}'`;
      return mode === "codemode-only"
        ? { kind: "tool", name: "codemode", arguments: { code: `text(await tools.bash(${JSON.stringify({ command })}));` } }
        : { kind: "tool", name: "bash", arguments: { command } };
    });
    await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: mode }));
    const { host } = await f.start();
    await host.submit("Check the shell after every command.");
    assert.equal(completed, 3);
    assert.equal(f.requests.length, 4);
    for (let index = 0; index < 3; index++) {
      assert.ok(f.requests[index + 1]?.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes(`verified ${index}`)));
    }
  });
}

test("resuming with no Git Bash switches the actual CLI prompt and execution to PowerShell", { skip: process.platform !== "win32", timeout: 45000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index === 1
    ? { kind: "tool", name: "bash", arguments: { command: "[Console]::Write('中文 fallback verified')" } }
    : { kind: "text", text: "Saved answer." });
  const { host } = await f.start();
  await host.submit("Save a session using the detected shell.");
  await host.exit();
  const hidden = new Set(["path", "programfiles", "programfiles(x86)", "localappdata"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !hidden.has(key.toLowerCase())));
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  env.Path = [dirname(process.execPath), join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";");
  const fallback = resolveShell({ env });
  assert.equal(fallback.kind, "powershell");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--cwd", f.cwd, "--home", f.home,
    "--model", "fixture/test", "--print", "--full-access", "resume", "--last", "Verify the fallback shell."],
  { env, timeout: 35000, windowsHide: true });
  assert.match(result.stdout, /Saved answer/);
  const request = f.requests[1];
  const prompt = toolPrompt(request, "shell_environment");
  assert.match(prompt, /executes PowerShell.*\nUse PowerShell syntax/);
  assert.ok(!prompt.includes(JSON.stringify(fallback.executable)), prompt);
  assert.match(String(request?.tools?.find((tool) => tool.function.name === "bash")?.function.description), /Execute a PowerShell command/);
  assert.ok(f.requests[2]?.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("中文 fallback verified")));
  const context = JSON.stringify(request?.messages.filter((message) => message.role === "user"));
  assert.ok(context.includes(JSON.stringify(fallback.executable).slice(1, -1)), context);
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  await resumed.host.submit("Use the detected shell again.");
  const restored = toolPrompt(f.requests[3], "shell_environment");
  assert.ok(!restored.includes(JSON.stringify(defaultShell.executable)), restored);
  assert.match(restored, usesPowerShell ? /Use PowerShell syntax/ : /Use POSIX shell syntax/);
});

for (const mode of ["direct", "codemode", "codemode-only"]) {
  test(`tool mode ${mode} scopes declarations and script calls to built-in tools`, async (t) => {
    const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool", name: "codemode", arguments: {
      code: `text(typeof tools.read); text(await tools.mcp__fixture__echo({text:"allowed"}));`,
    } } : { kind: "text", text: "Done." });
    const mcp = await httpMcpFixture(t);
    await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: mode }));
    await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "direct" } } }));
    const { host } = await f.start();
    await host.submit("Check callability.");
    const names = f.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(toolPrompt(f.requests[0], "builtin_tool_mode").startsWith(`Built-in tool mode: ${mode}.`));
    assert.match(toolPrompt(f.requests[0], "mcp_tool_modes"), /direct: MCP tools/);
    assert.deepEqual(TOOL_NAMES.filter((name) => names.includes(name)), mode === "codemode-only" ? [] : TOOL_NAMES);
    assert.ok(names.includes("mcp__fixture__echo"));
    if (mode !== "direct") {
      assert.ok(names.includes("codemode"));
      assert.match(JSON.stringify(f.requests[1]?.messages), /function/);
      assert.equal(mcp.calls.length, 1);
    } else assert.ok(!names.includes("codemode"));
  });
}

test("MCP prompt composes mixed server and tool modes and omits disabled servers", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const mcp = await httpMcpFixture(t);
  const path = join(f.home, "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: {
    fixture: { url: mcp.url, exposure: "hidden", toolExposure: { echo: "deferred", "other*": "direct" } },
    disabled: { url: mcp.url, enabled: false, exposure: "codemode" },
  } }));
  const { host } = await f.start();
  await host.submit("Inspect mixed exposure modes.");
  const mixed = toolPrompt(f.requests[0], "mcp_tool_modes");
  assert.match(mixed, /direct: MCP tools/);
  assert.match(mixed, /deferred: These MCP tools are discovered on demand/);
  assert.doesNotMatch(mixed, /codemode: Access these MCP tools through codemode/);
  assert.ok(mixed.indexOf("direct:") < mixed.indexOf("deferred:"));
  await host.submit("/mcp disable fixture");
  await host.submit("Inspect disabled MCP.");
  assert.equal(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), "");
});

test("unchanged mode prompts reuse their persisted sections across runs", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const { host } = await f.start();
  await host.submit("First task.");
  await host.submit("Second task.");
  assert.equal(toolPrompt(f.requests[0], "builtin_tool_mode"), toolPrompt(f.requests[1], "builtin_tool_mode"));
  assert.equal(toolPrompt(f.requests[0], "mcp_tool_modes"), toolPrompt(f.requests[1], "mcp_tool_modes"));
  assert.equal(toolPrompt(f.requests[0], "mcp_tool_modes"), "");
  assert.equal(toolPrompt(f.requests[0], "skills"), "");
  assert.doesNotMatch(JSON.stringify(f.requests[0]?.messages), /<mcp_tool_modes>|<skills>|No MCP tools are exposed|No Skills are available/);
  const entries = SessionManager.open((await f.sessions())[0] ?? "").getBranch();
  assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "system"
    && entry.message.sections?.builtin_tool_mode !== undefined).length, 1);
  assert.ok(entries.every((entry) => entry.type !== "message" || entry.message.role !== "system"
    || !entry.message.sections?.mcp_tool_modes && !entry.message.sections?.skills));
});

test("first request applies the latest built-in and MCP choices, then stages further changes until a new session", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const { host } = await f.start();
  await host.submit("/tool-mode direct");
  await host.submit("/tool-mode codemode-only");
  await host.submit("/mcp exposure fixture direct");
  await host.submit("/mcp exposure fixture deferred");
  assert.equal(f.requests.length, 0);
  await host.submit("Use my latest choices.");
  assert.match(toolPrompt(f.requests[0], "builtin_tool_mode"), /^Built-in tool mode: codemode-only\./);
  assert.match(toolPrompt(f.requests[0], "mcp_tool_modes"), /deferred: These MCP tools/);
  assert.doesNotMatch(toolPrompt(f.requests[0], "mcp_tool_modes"), /codemode: Access these MCP tools|direct: MCP tools/);
  const names = f.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(names.includes("codemode") && names.includes("tool_search"));
  assert.ok(!names.some((name) => TOOL_NAMES.includes(name) || name.startsWith("mcp__")));
  await host.submit("/tool-mode direct");
  await host.submit("/mcp exposure fixture direct");
  await host.submit("/mcp reconnect fixture");
  await host.submit("Keep the established mode.");
  assert.deepEqual(f.requests[1]?.tools, f.requests[0]?.tools);
  assert.equal(toolPrompt(f.requests[1], "builtin_tool_mode"), toolPrompt(f.requests[0], "builtin_tool_mode"));
  assert.equal(toolPrompt(f.requests[1], "mcp_tool_modes"), toolPrompt(f.requests[0], "mcp_tool_modes"));
  await host.submit("/new");
  await host.submit("Use the new session defaults.");
  assert.match(toolPrompt(f.requests[2], "builtin_tool_mode"), /^Built-in tool mode: direct\./);
  assert.match(toolPrompt(f.requests[2], "mcp_tool_modes"), /direct: MCP tools/);
  assert.ok(TOOL_NAMES.every((name) => f.requests[2]?.tools?.some((tool) => tool.function.name === name)));
  assert.ok(f.requests[2]?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
});

test("an interrupted first request locks mode choices across resume", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (_request, index) => {
    if (index === 0) await gate;
    return { kind: "text", text: "Done." };
  });
  const { host } = await f.start();
  const run = host.submit("Start a request.");
  await until(() => f.requests.length === 1);
  await host.interrupt(); release(); await run;
  await host.submit("/tool-mode codemode-only");
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  await resumed.host.submit("Continue with the established mode.");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  const entries = SessionManager.open((await f.sessions())[0] ?? "").getBranch();
  assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === TOOL_REQUEST_STATE_ENTRY
    && JSON.stringify(entry.data).includes('"requested":true')));
  assert.ok(!JSON.stringify(f.requests.at(-1)?.messages).includes(TOOL_REQUEST_STATE_ENTRY));
});

test("strict direct built-ins cannot be called from MCP CodeMode", async (t) => {
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool", name: "codemode", arguments: {
    code: "text('write' in tools); text(await tools.mcp__fixture__echo({text:'allowed'}));",
  } } : { kind: "text", text: "Done." });
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: "direct" }));
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const { host } = await f.start();
  await host.submit("Use MCP CodeMode.");
  assert.ok(f.requests[0]?.tools?.some((tool) => tool.function.name === "codemode"));
  assert.match(JSON.stringify(f.requests[1]?.messages.find((message) => message.role === "tool")?.content), /false/);
  assert.equal(mcp.calls.length, 1);
});

test("MCP directory changes during a run do not expose unused discovery tools in direct mode", async (t) => {
  const mcp = await httpMcpFixture(t);
  const f = await fixture(t, async (_request, index) => {
    if (index === 0) {
      await until(() => mcp.streams > 0);
      mcp.setTools([{ ...echoMcpTool, name: "replacement" }]);
      await until(() => mcp.listed > 1);
      return { kind: "tool", name: "read", arguments: { path: "source.txt" } };
    }
    return { kind: "text", text: "Done." };
  });
  await writeFile(join(f.cwd, "source.txt"), "contents");
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: "direct" }));
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "direct" } } }));
  const { host } = await f.start();
  await host.submit("Read while the MCP directory changes.");
  assert.equal(host.outcome, "completed");
  for (const request of f.requests) assert.ok(!request.tools?.some((tool) => ["codemode", "tool_search"].includes(tool.function.name)));
  assert.ok(f.requests[1]?.tools?.some((tool) => tool.function.name === "mcp__fixture__replacement"));
});

test("CodeMode-only tool search cannot activate built-ins and executes them through scripts", async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "tool_search", arguments: { query: "Write Read file content" } }
    : index === 1 ? { kind: "tool", name: "codemode", arguments: { code: 'await tools.write({path:"script.txt",content:"saved"}); text(await tools.read({path:"script.txt"}));' } }
      : { kind: "text", text: "Done." });
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ ...loadConfig(f.home), toolMode: "codemode-only" }));
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "deferred" } } }));
  const { host } = await f.start();
  await host.submit("Search then run a script.");
  assert.equal(await readFile(join(f.cwd, "script.txt"), "utf8"), "saved");
  for (const request of f.requests) assert.ok(!request.tools?.some((tool) => TOOL_NAMES.includes(tool.function.name)));
});

test("pending tool modes survive resume and fork, then apply together with MCP at compact and new sessions", async (t) => {
  const f = await fixture(t, (_request, index) => ({ kind: "text", text: index === 0 ? "Earlier inspected evidence. ".repeat(5000) : "Done." }));
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const { host, ui } = await f.start();
  await host.submit("Start in hybrid mode.");
  const first = f.requests[0]?.tools;
  await host.submit("/tool-mode codemode-only");
  await host.submit("/mcp exposure fixture direct");
  await host.submit("Keep current declarations.");
  assert.deepEqual(f.requests[1]?.tools, first);
  assert.match(toolPrompt(f.requests[1], "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  assert.ok(ui.messages.every((message) => !/Current:|Pending:/.test(message.text)));
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  await resumed.host.submit("Resume with old mode.");
  assert.deepEqual(f.requests.at(-1)?.tools, first);
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  await resumed.host.submit("/fork");
  await resumed.host.submit("Fork with old mode.");
  assert.deepEqual(f.requests.at(-1)?.tools, first);
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  await resumed.host.submit("/compact");
  assert.equal(resumed.host.outcome, "completed", JSON.stringify(resumed.ui.messages.filter((message) => message.kind === "error")));
  await resumed.host.submit("Apply both pending modes.");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode-only\./);
  assert.match(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), /direct: MCP tools/);
  const after = f.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(after.includes("codemode"));
  assert.ok(after.includes("mcp__fixture__echo"));
  assert.ok(!after.some((name) => TOOL_NAMES.includes(name)));
  await resumed.host.submit("/tool-mode direct");
  await resumed.host.submit("/new");
  await resumed.host.submit("Use new defaults.");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: direct\./);
  const fresh = f.requests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!fresh.includes("codemode"));
  assert.ok(TOOL_NAMES.every((name) => fresh.includes(name)));
  assert.ok(fresh.includes("mcp__fixture__echo"));
});

test("automatic compact applies pending modes and prompts before the next request in the same run", async (t) => {
  let home = "";
  const mcp = await httpMcpFixture(t);
  const f = await fixture(t, async (_request, index) => {
    if (index === 0) {
      await writeFile(join(home, "settings.json"), JSON.stringify({ ...loadConfig(home), toolMode: "codemode-only" }));
      await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "direct" } } }));
      return { kind: "tool", name: "read", arguments: { path: "large.txt", offset: 1, limit: 2000 } };
    }
    if (index === 1) return { kind: "tool", name: "read", arguments: { path: "large.txt", offset: 2001, limit: 2000 } };
    return { kind: "text", text: "Summary or completed answer." };
  }, false, 53000);
  home = f.home;
  await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  await writeFile(join(f.cwd, "large.txt"), "Large inspected evidence.\n".repeat(5200));
  const { host, ui } = await f.start();
  await host.submit("Read enough to trigger compact.");
  assert.equal(host.outcome, "completed", JSON.stringify(ui.messages.filter((message) => message.kind === "error")));
  const after = f.requests.findLast((request) => request.messages.some((message) => JSON.stringify(message.content).includes(SUMMARY_PREFIX)));
  assert.ok(after);
  assert.ok(!after.tools?.some((tool) => TOOL_NAMES.includes(tool.function.name)));
  assert.ok(after.tools?.some((tool) => tool.function.name === "codemode"));
  assert.ok(after.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
  assert.match(toolPrompt(after, "builtin_tool_mode"), /^Built-in tool mode: codemode-only\./);
  assert.match(toolPrompt(after, "mcp_tool_modes"), /direct: MCP tools/);
  assert.doesNotMatch(toolPrompt(after, "mcp_tool_modes"), /codemode: Access these MCP tools through codemode/);
  const persisted = (await Promise.all((await f.sessions()).map((path) => readFile(path, "utf8")))).join("\n");
  assert.match(persisted, /Built-in tool mode: codemode-only/);
});

test("failed compact before the first request still allows initial mode selection", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const { host } = await f.start();
  await host.submit("/tool-mode codemode-only");
  await host.submit("/compact");
  assert.equal(host.outcome, "failed");
  await host.submit("Use the original mode.");
  assert.match(toolPrompt(f.requests[0], "builtin_tool_mode"), /^Built-in tool mode: codemode-only\./);
  assert.ok(!f.requests[0]?.tools?.some((tool) => TOOL_NAMES.includes(tool.function.name)));
});

test("cancelled compact preserves established built-in and MCP modes", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (_request, index) => {
    if (index === 1) await gate;
    return { kind: "text", text: index === 0 ? "Earlier inspected evidence. ".repeat(5000) : "Done." };
  });
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const { host, ui } = await f.start();
  await host.submit("Create compactable history.");
  await host.submit("/tool-mode codemode-only");
  await host.submit("/mcp exposure fixture direct");
  const compact = host.submit("/compact");
  await until(() => f.requests.length === 2);
  await host.interrupt(); release(); await compact;
  await host.submit("Keep the established policy after cancellation.");
  assert.equal(host.outcome, "completed", JSON.stringify(ui.messages.filter((message) => message.kind === "error")));
  assert.deepEqual(f.requests.at(-1)?.tools, f.requests[0]?.tools);
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  assert.match(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), /codemode: Access these MCP tools/);
  assert.doesNotMatch(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), /direct: MCP tools/);
});

test("tool-policy changes during compact reject the checkpoint and preserve prior history", async (t) => {
  let home = "";
  const f = await fixture(t, async (_request, index) => {
    if (index === 1) await writeFile(join(home, "settings.json"), JSON.stringify({ toolMode: "invalid" }));
    return { kind: "text", text: index === 0 ? "Earlier inspected evidence. ".repeat(5000) : "Saved summary." };
  });
  home = f.home;
  const { host, ui } = await f.start();
  await host.submit("Create compactable history.");
  await host.submit("/tool-mode codemode-only");
  await host.submit("/compact");
  assert.equal(host.outcome, "failed");
  const requests = f.requests.length;
  await host.submit("Do not send an inconsistent tool policy.");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, requests + 1);
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  assert.ok(ui.messages.some((message) => message.kind === "error" && message.text.includes("Cannot load ArkCode settings")));
  const entries = SessionManager.open((await f.sessions())[0] ?? "").getBranch();
  assert.ok(!entries.some((entry) => entry.type === "compaction"));
});

test("tool-mode submenu shows current and pending without adding messages or model context", async (t) => {
  const notices: string[] = [];
  class ModeUI extends RecordingUI {
    override async choose(title: string, _choices: Choice[], options?: ChoiceOptions): Promise<string | null> {
      assert.equal(title, "Tool mode");
      assert.equal(options?.transient, true);
      notices.push(options?.notice ?? "");
      return notices.length === 1 ? "codemode-only" : null;
    }
  }
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const { host, ui } = await f.start(new ModeUI());
  await host.submit("/tool-mode");
  assert.match(notices[0] ?? "", /Current: codemode/);
  assert.match(notices[1] ?? "", /Pending: codemode-only/);
  assert.match(notices[1] ?? "", /Changes apply before the first LLM request/);
  assert.equal(f.requests.length, 0);
  assert.equal(loadConfig(f.home).toolMode, "codemode-only");
  assert.ok(!ui.messages.some((message) => /Current:|Pending:/.test(message.text)));
  await host.submit("Save the conversation.");
  assert.match(toolPrompt(f.requests[0], "builtin_tool_mode"), /^Built-in tool mode: codemode-only\./);
  const entries = SessionManager.open((await f.sessions())[0] ?? "").getBranch();
  assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === TOOL_SETTINGS_ENTRY));
  assert.ok(!JSON.stringify(f.requests[0]?.messages).includes(TOOL_SETTINGS_ENTRY));
});

test("direct built-in shell calls execute concurrently through the real SDK scheduler", async (t) => {
  const scripts: Array<{ path: string; code: string }> = [];
  const calls = ["one", "two"].map((name, index): ToolReply => {
    const peer = index === 0 ? "two" : "one";
    const script = `const fs=require("node:fs");fs.writeFileSync("${name}.ready","");const timeout=setTimeout(()=>process.exit(3),5000);const check=setInterval(()=>{if(fs.existsSync("${peer}.ready")){clearInterval(check);clearTimeout(timeout);console.log("overlapped")}},20)`;
    scripts.push({ path: `${name}.cjs`, code: script });
    const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", usesPowerShell ? "''" : "'\\''")}'`;
    return { kind: "tool", name: "bash", arguments: { command: `${usesPowerShell ? "& " : ""}${quote(process.execPath)} ${quote(`${name}.cjs`)}` } };
  });
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tools", calls } : { kind: "text", text: "Done." });
  for (const script of scripts) await writeFile(join(f.cwd, script.path), script.code);
  const { host, ui } = await f.start();
  await host.submit("Run independent commands.");
  const shells = ui.tools.filter((tool) => tool.name === "bash" && tool.state === "done");
  assert.equal(shells.length, 2, JSON.stringify(ui.tools.filter((tool) => tool.name === "bash")));
  assert.ok(shells.every((tool) => tool.details?.exitCode === 0 && tool.text.includes("overlapped")));
});

test("cancelling concurrent approvals denies the entire queue and ignores a late session grant", async () => {
  let finish: (value: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => { finish = resolve; });
  const ui = new RecordingUI(() => decision);
  const broker = new ApprovalBroker(ui, () => "always-ask", () => {});
  const request: ApprovalRequest = { id: "one", tool: "write", description: "write one.txt", cwd: "/workspace" };
  const calls = [broker.authorize(request), broker.authorize({ ...request, id: "two" }), broker.authorize({ ...request, id: "three" })];
  assert.equal(ui.approvals.length, 1);
  broker.cancel();
  assert.deepEqual(await Promise.all(calls), [false, false, false]);
  finish("session");
  await Promise.resolve();
  assert.equal(ui.approvals.length, 1);
  assert.equal(await broker.authorize({ ...request, id: "fresh" }), true);
  assert.equal(ui.approvals.length, 2);
});

for (const incremental of [false, true]) {
  test(`MCP deferred loading uses ${incremental ? "anchored additions" : "complete request tools"} and restores loaded tools`, async (t) => {
    const f = await fixture(t, (_request, index) => index === 0
      ? { kind: "tool", name: "tool_search", arguments: { query: "echo" } } : { kind: "text", text: "Done." },
    false, 128000, { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: incremental });
    const mcp = await httpMcpFixture(t);
    await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "deferred" } } }));
    const { host } = await f.start();
    await host.submit("Discover echo.");
    assert.ok(!f.requests[0]?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
    const after = f.requests[1]; assert.ok(after);
    assert.equal(after.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"), !incremental);
    if (incremental) {
      assert.deepEqual(after.tools, f.requests[0]?.tools);
      assert.ok(after.messages.some((message) => message.role === "system" && "tools" in message
        && JSON.stringify(message.tools).includes("mcp__fixture__echo")));
    }
    await host.exit();
    const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
    await resumed.host.submit("Use the restored catalog.");
    assert.ok(JSON.stringify(f.requests.at(-1)).includes("mcp__fixture__echo"));
    await resumed.host.submit("/mcp disable fixture");
    await resumed.host.submit("Observe the unavailable tool.");
    const removed = f.requests.at(-1); assert.ok(removed);
    assert.ok(!removed.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
    assert.match(JSON.stringify(removed.messages), /no longer available.*mcp__fixture__echo/s);
    assert.ok(resumed.ui.messages.every((message) => !message.text.includes("no longer available")));
  });
}

for (const change of ["disable", "filter", "delete"]) {
  test(`external MCP ${change} during approval prevents actual dispatch`, async (t) => {
    const f = await fixture(t, (_request, index) => index === 0
      ? { kind: "tool", name: "mcp__fixture__echo", arguments: { text: "pending" } } : { kind: "text", text: "Done." });
    const mcp = await httpMcpFixture(t);
    const path = join(f.home, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "direct" } } }));
    let decide: (value: ApprovalDecision) => void = () => {};
    const ui = new RecordingUI(() => new Promise<ApprovalDecision>((resolve) => { decide = resolve; }));
    const { host } = await f.start(ui, ["--permissions", "always-ask"]);
    const run = host.submit("Call echo.");
    await until(() => ui.approvals.length === 1);
    if (change === "delete") await unlink(path);
    else await writeFile(path, JSON.stringify({ mcpServers: { fixture: { url: mcp.url, exposure: "direct",
      ...(change === "disable" ? { enabled: false } : { disabledTools: ["echo"] }),
    } } }));
    decide("once");
    await run;
    assert.deepEqual(mcp.calls, []);
    assert.ok(ui.tools.some((tool) => tool.name === "mcp__fixture__echo" && tool.state === "error"));
  });
}

test("/mcp status and interactive tools panel use connected servers without a model request", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  const titles: string[] = [];
  const selections: Array<string | null> = ["fixture", "tools", null, null];
  class McpUI extends RecordingUI {
    override async choose(title: string, choices: Choice[]): Promise<string | null> {
      titles.push(title);
      assert.ok(!choices.some(({ value }) => value === "login" || value === "logout"));
      return selections.shift() ?? null;
    }
  }
  const { host, ui } = await f.start(new McpUI());
  const before = [...ui.messages];
  const sessionsBefore = await f.sessions();
  await host.submit("/mcp");
  assert.deepEqual(titles, ["MCP servers", "MCP fixture", "MCP fixture", "MCP servers"]);
  assert.match(ui.inspections.at(-1)?.text ?? "", /enabled mcp__fixture__echo/);
  await host.submit("/mcp status");
  assert.match(ui.inspections.at(-1)?.text ?? "", /fixture: connected/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(ui.messages, before);
  assert.deepEqual(await f.sessions(), sessionsBefore);
  await host.exit();
  assert.equal(mcp.closed, 1);
});

test("MCP reconnect returns to its action menu and browsing preserves saved messages", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Saved conversation." }));
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const titles: string[] = [];
  const selections: Array<string | null> = ["fixture", "reconnect", "tools", null, null];
  class McpUI extends RecordingUI {
    override async choose(title: string, _choices: Choice[], options?: ChoiceOptions): Promise<string | null> {
      titles.push(title);
      if (titles.length === 3) assert.equal(options?.initialValue, "reconnect");
      return selections.shift() ?? null;
    }
  }
  const { host, ui } = await f.start(new McpUI());
  await host.submit("Create a saved conversation.");
  const sessionPath = (await f.sessions())[0];
  assert.ok(sessionPath);
  const savedBefore = await readFile(sessionPath, "utf8");
  const messagesBefore = [...ui.messages];
  await host.submit("/mcp");
  assert.deepEqual(titles, ["MCP servers", "MCP fixture", "MCP fixture", "MCP fixture", "MCP servers"]);
  assert.equal(mcp.initialized, 2);
  assert.equal(mcp.closed, 1);
  assert.deepEqual(ui.messages, messagesBefore);
  assert.equal(await readFile(sessionPath, "utf8"), savedBefore);
  assert.equal(f.requests.length, 1);
  assert.ok(ui.inspections.every(({ text }) => !text.includes("Configuration:") && !text.includes("Commands:")));
});

for (const permission of ["always-ask", "ask-when-needed", "never-ask"]) {
  test(`MCP ${permission} separates dynamic exposure from approval even for readOnlyHint`, async (t) => {
    const f = await fixture(t, (_request, index) => index === 0
      ? { kind: "tool", name: "mcp__fixture__echo", arguments: { text: "hello" } } : { kind: "text", text: "Done." });
    const mcp = await httpMcpFixture(t, { tools: [echoMcpTool, { ...echoMcpTool, name: "hidden" }] });
    await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url, disabledTools: ["hidden"] } } }));
    const { host, ui } = await f.start(new RecordingUI(async () => "deny"), ["--permissions", permission]);
    await host.submit("Use the MCP echo tool.");
    assert.deepEqual(f.requests[0]?.tools?.map(({ function: tool }) => tool.name), ["read", "write", "edit", "grep", "glob", "bash", "codemode", "mcp__fixture__echo"]);
    assert.equal(ui.approvals.length, permission === "never-ask" ? 0 : 1);
    assert.equal(mcp.calls.length, permission === "never-ask" ? 1 : 0);
    if (permission !== "never-ask") {
      assert.equal(ui.approvals[0]?.invocation?.kind, "mcp");
      assert.match(JSON.stringify(f.requests[1]?.messages), /MCP tool execution denied/);
    } else assert.match(JSON.stringify(f.requests[1]?.messages), /MCP echo: hello/);
    await host.exit();
  });
}

test("MCP user auto-approval applies only in Ask When Needed; destructive hints still ask", async (t) => {
  const replies: Reply[] = [
    { kind: "tool", name: "mcp__fixture__echo", arguments: { text: "auto" } },
    { kind: "tool", name: "mcp__fixture__danger", arguments: { text: "danger" } },
    { kind: "text", text: "Done." },
    { kind: "tool", name: "mcp__fixture__echo", arguments: { text: "auto" } },
    { kind: "text", text: "Done." },
    { kind: "text", text: "Done." },
  ];
  const f = await fixture(t, (_request, index) => { const reply = replies[index]; assert.ok(reply); return reply; });
  const mcp = await httpMcpFixture(t, { tools: [echoMcpTool, { ...echoMcpTool, name: "danger", annotations: { destructiveHint: true } }] });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url, autoApproveTools: ["*"] } } }));
  const { host, ui } = await f.start(new RecordingUI(async () => "deny"), ["--permissions", "ask-when-needed"]);
  await host.submit("Use both MCP tools.");
  assert.deepEqual(mcp.calls.map((call) => call.name), ["echo"]);
  assert.equal(ui.approvals.length, 1);
  await host.submit("/permissions always-ask");
  await host.submit("Echo again.");
  assert.equal(mcp.calls.length, 1);
  assert.equal(ui.approvals.length, 2);
  assert.deepEqual(f.requests[3]?.tools, f.requests[0]?.tools);
  await host.submit("/permissions never-ask");
  await host.submit("Inspect the schemas.");
  assert.deepEqual(f.requests[5]?.tools, f.requests[0]?.tools);
  await host.exit();
});

test("MCP enable/disable persists the defining source and new sessions retain independent connections until host shutdown", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const mcp = await httpMcpFixture(t);
  await mkdir(join(f.cwd, ".arkcode"), { recursive: true });
  const path = join(f.cwd, ".arkcode", "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  const { host, ui } = await f.start();
  assert.equal(mcp.initialized, 1);
  await host.submit("/mcp disable fixture");
  assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.fixture.enabled, false);
  assert.equal(mcp.closed, 1);
  await host.submit("No MCP tools.");
  assert.equal(f.requests[0]?.tools?.some((tool) => tool.function.name.startsWith("mcp__")), false);
  await host.submit("/mcp enable fixture");
  assert.equal(mcp.initialized, 2);
  await host.submit("MCP tools are back.");
  assert.equal(f.requests[1]?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"), true);
  await host.submit("/mcp reconnect fixture");
  assert.equal(mcp.closed, 2);
  assert.equal(mcp.initialized, 3);
  await host.submit("/new");
  assert.equal(mcp.closed, 2);
  assert.equal(mcp.initialized, 4);
  await host.submit("/mcp tools fixture");
  assert.match(ui.inspections.at(-1)?.text ?? "", /mcp__fixture__echo/);
  await host.exit();
  assert.equal(mcp.closed, 4);
});

test("MCP list_changed replaces the real model tool declarations and preserves structured/error results", async (t) => {
  const f = await fixture(t, (_request, index) => index === 1 || index === 3
    ? { kind: "tool", name: index === 1 ? "mcp__fixture__replacement" : "mcp__fixture__echo", arguments: { text: "data" } } : { kind: "text", text: "Done." });
  const mcp = await httpMcpFixture(t, { call: () => ({ content: [{ type: "text", text: "summary" }], structuredContent: { answer: 42 }, isError: true }) });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  const { host, ui } = await f.start();
  await host.submit("First directory.");
  await until(() => mcp.streams > 0);
  mcp.setTools([{ ...echoMcpTool, name: "replacement" }]);
  const deadline = Date.now() + 8000;
  do {
    await host.submit("/mcp tools fixture");
    if (ui.inspections.at(-1)?.text.includes("mcp__fixture__replacement")) break;
    assert.ok(Date.now() < deadline); await delay(10);
  } while (true);
  await host.submit("Use the new directory.");
  const names = f.requests[1]?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(names.includes("mcp__fixture__replacement"));
  assert.ok(!names.includes("mcp__fixture__echo"));
  assert.match(JSON.stringify(f.requests[1]?.messages), /no longer available.*Do not call them/s);
  assert.ok(!ui.messages.some((message) => /no longer available.*Do not call them/s.test(message.text)));
  assert.deepEqual(mcp.calls.map((call) => call.name), ["replacement"]);
  assert.match(JSON.stringify(f.requests[2]?.messages), /summary/);
  assert.ok(ui.tools.some((tool) => tool.name === "mcp__fixture__replacement" && tool.state === "error"));
  const saved = SessionManager.open((await f.sessions())[0] ?? "").getBranch();
  assert.ok(saved.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError));
  await host.submit("Try the removed tool name.");
  assert.deepEqual(mcp.calls.map((call) => call.name), ["replacement"]);
  await host.exit();
});

test("MCP schema changes invalidate a pending approved call and management cannot mutate a busy session", async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "mcp__fixture__echo", arguments: { text: "pending" } } : { kind: "text", text: "Done." });
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  let approve: (decision: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => { approve = resolve; });
  const { host, ui } = await f.start(new RecordingUI(() => decision), ["--permissions", "always-ask"]);
  const run = host.submit("Call MCP.");
  await until(() => ui.approvals.length === 1 && mcp.streams > 0);
  await host.submit("/mcp disable fixture");
  assert.match(ui.inspections.at(-1)?.text ?? "", /Wait until the current run finishes/);
  mcp.setTools([{ ...echoMcpTool, description: "Changed tool contract." }]);
  const deadline = Date.now() + 8000;
  do {
    await host.submit("/mcp tools fixture");
    if (ui.inspections.at(-1)?.text.includes("Changed tool contract.")) break;
    assert.ok(Date.now() < deadline); await delay(10);
  } while (true);
  approve("once");
  await run;
  assert.equal(mcp.calls.length, 0);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /no longer available|changed while awaiting/);
  await host.exit();
});

test("MCP interrupt while awaiting approval sends no external call and ignores a late grant", async (t) => {
  const f = await fixture(t, () => ({ kind: "tool", name: "mcp__fixture__echo", arguments: { text: "pending" } }));
  const mcp = await httpMcpFixture(t);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  let approve: (decision: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => { approve = resolve; });
  const { host, ui } = await f.start(new RecordingUI(() => decision), ["--permissions", "always-ask"]);
  const run = host.submit("Call MCP.");
  await until(() => ui.approvals.length === 1);
  await host.interrupt(); approve("session"); await run;
  assert.equal(host.outcome, "interrupted");
  assert.equal(mcp.calls.length, 0);
  await host.exit();
  assert.equal(mcp.closed, 1);
});

test("interrupt cancels a real in-flight MCP request without replaying it", async (t) => {
  const f = await fixture(t, () => ({ kind: "tool", name: "mcp__fixture__echo", arguments: { text: "slow" } }));
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const mcp = await httpMcpFixture(t, { call: async () => { await pending; return { content: [{ type: "text", text: "late result" }] }; } });
  t.after(() => release());
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  const { host } = await f.start();
  const run = host.submit("Call the slow MCP tool.");
  await until(() => mcp.calls.length === 1);
  await host.interrupt();
  await run;
  assert.equal(host.outcome, "interrupted");
  await until(() => mcp.notifications.includes("notifications/cancelled"));
  assert.equal(mcp.calls.length, 1);
  release();
  await host.exit();
});

test("MCP session grants bind exact arguments and connection identity, including tools named read", async () => {
  const ui = new RecordingUI(async () => "session");
  const broker = new ApprovalBroker(ui, () => "always-ask", () => {});
  const invocation = { kind: "mcp", server: "fixture", tool: "read", source: "/home/mcp.json", identity: "connection-one",
    arguments: { path: "file.txt" }, autoApprove: true, destructive: false,
  } satisfies NonNullable<ApprovalRequest["invocation"]>;
  const request: ApprovalRequest = { id: "one", tool: "read", cwd: "/workspace", description: "external read", invocation };
  assert.equal(await broker.authorize(request), true);
  assert.equal(ui.approvals.length, 1);
  assert.equal(await broker.authorize({ ...request, id: "two" }), true);
  assert.equal(ui.approvals.length, 1);
  assert.equal(await broker.authorize({ ...request, invocation: { ...invocation, arguments: { path: "other.txt" } } }), true);
  assert.equal(await broker.authorize({ ...request, invocation: { ...invocation, identity: "connection-two" } }), true);
  assert.equal(await broker.authorize({ ...request, invocation: { ...invocation, destructive: true } }), true);
  assert.equal(await broker.authorize({ ...request, invocation: { ...invocation, destructive: true } }), true);
  assert.equal(ui.approvals.length, 5);
});

test("MCP resolves user bearer-token environment references and isolates a failed server without exposing credentials", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  const token = "private-mcp-test-secret";
  const envName = "ARKCODE_MCP_TEST_TOKEN";
  const original = process.env[envName]; process.env[envName] = token;
  t.after(() => { if (original === undefined) delete process.env[envName]; else process.env[envName] = original; });
  const mcp = await httpMcpFixture(t, { authorization: `Bearer ${token}` });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { exposure: "direct", url: mcp.url, bearerTokenEnvVar: envName }, bad: { exposure: "direct", url: mcp.url },
  } }));
  const { host, ui } = await f.start();
  await host.submit("/mcp status");
  assert.match(ui.inspections.at(-1)?.text ?? "", /fixture: connected/);
  assert.match(ui.inspections.at(-1)?.text ?? "", /bad: needs-auth/);
  assert.doesNotMatch(JSON.stringify(ui.messages), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(ui.inspections), new RegExp(token));
  await host.submit("Use available tools.");
  assert.ok(f.requests[0]?.tools?.some((tool) => tool.function.name === "mcp__fixture__echo"));
  assert.ok(!f.requests[0]?.tools?.some((tool) => tool.function.name.startsWith("mcp__bad__")));
  await host.exit();
});

test("MCP startup timeout isolates an unresponsive server and still exposes healthy tools", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = await httpMcpFixture(t, { initialize: () => gate });
  const healthy = await httpMcpFixture(t);
  t.after(() => release());
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: {
    slow: { url: slow.url, startupTimeoutMs: 300 }, healthy: { exposure: "direct", url: healthy.url },
  } }));
  const { host, ui } = await f.start();
  await host.submit("/mcp status");
  assert.match(ui.inspections.at(-1)?.text ?? "", /slow: failed/);
  assert.match(ui.inspections.at(-1)?.text ?? "", /healthy: connected/);
  await host.submit("Use the healthy directory.");
  assert.ok(f.requests[0]?.tools?.some((tool) => tool.function.name === "mcp__healthy__echo"));
  assert.ok(!f.requests[0]?.tools?.some((tool) => tool.function.name.startsWith("mcp__slow__")));
  release();
  await host.exit();
});

test("startup blocks conversations until every enabled MCP has connected and discovered tools", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Ready." }));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = await httpMcpFixture(t, { initialize: () => gate });
  const healthy = await httpMcpFixture(t);
  t.after(() => release());
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: {
    slow: { url: slow.url, exposure: "direct" }, healthy: { url: healthy.url, exposure: "direct" },
    disabled: { url: "http://127.0.0.1:1/mcp", enabled: false },
  } }));
  const ui = new RecordingUI();
  const host = new ArkHost(parseCli(["--cwd", f.cwd, "--home", f.home, "--model", "fixture/test"]), ui);
  t.after(() => host.exit());
  const starting = host.start();
  await until(() => slow.initialized === 1 && healthy.listed === 1);
  assert.equal(ui.statuses.at(-1)?.initializing, true);
  await host.submit("Do not send this before startup finishes.");
  await host.browseSessions();
  assert.equal(ui.dismissed, false);
  assert.equal(f.requests.length, 0);
  assert.ok(ui.statuses.every(({ initializing }) => initializing));
  release();
  await starting;
  assert.equal(slow.listed, 1);
  assert.equal(ui.statuses.at(-1)?.initializing, false);
  await host.submit("All tools are ready.");
  assert.equal(f.requests.length, 1);
  const names = f.requests[0]?.tools?.map(({ function: tool }) => tool.name) ?? [];
  assert.ok(names.includes("mcp__slow__echo"));
  assert.ok(names.includes("mcp__healthy__echo"));
  assert.ok(!names.includes("mcp__disabled__echo"));
});

test("failed MCP startup waits for an explicit retry before enabling conversations", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Ready after retry." }));
  let release = () => {};
  let retry = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const decision = new Promise<void>((resolve) => { retry = resolve; });
  const slow = await httpMcpFixture(t, { initialize: () => gate });
  t.after(() => { release(); retry(); });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { slow: { url: slow.url, startupTimeoutMs: 100 } } }));
  let prompted = false;
  class StartupUI extends RecordingUI {
    override async choose(title: string): Promise<string | null> {
      assert.match(title, /MCP startup incomplete/);
      prompted = true;
      await decision;
      return "retry";
    }
  }
  const ui = new StartupUI();
  const starting = f.start(ui);
  await until(() => prompted);
  assert.equal(ui.statuses.at(-1)?.initializing, true);
  assert.equal(f.requests.length, 0);
  release(); retry();
  const { host } = await starting;
  assert.equal(ui.statuses.at(-1)?.initializing, false);
  await host.submit("Use tools after retry.");
  assert.equal(f.requests.length, 1);
});

test("cancelled session startup restores the previous runtime and releases its session ownership", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Original session continues." }));
  class CancelStartupUI extends RecordingUI {
    override async choose(title: string): Promise<string | null> {
      assert.match(title, /MCP startup incomplete/);
      return null;
    }
  }
  const { host, ui } = await f.start(new CancelStartupUI());
  await host.submit("Original session");
  const originalId = ui.statuses.at(-1)?.sessionId;
  assert.ok(originalId);
  const mcp = await httpMcpFixture(t, { authorization: "Bearer missing-token" });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  await host.submit("/new");
  assert.equal(ui.statuses.at(-1)?.sessionId, originalId);
  assert.equal(ui.statuses.at(-1)?.initializing, false);
  assert.ok(ui.messages.some((message) => message.text === "Session startup cancelled."));
  const cancelledId = ui.statuses.find((status) => status.sessionId && status.sessionId !== originalId)?.sessionId;
  assert.ok(cancelledId);
  const lease = await SessionLease.acquire(cancelledId);
  try { assert.equal(lease.viewer, false); } finally { await lease.release(); }
  await host.submit("Continue the original runtime");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 2);
  await assert.rejects(f.start(new CancelStartupUI()), /Session startup cancelled/);
  const viewer = await f.start(new CancelStartupUI(), ["resume", originalId]);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
  await host.exit();
  await viewer.host.submit(`/sessions ${originalId}`);
  assert.equal(viewer.ui.statuses.at(-1)?.sessionId, originalId);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
  assert.equal(viewer.ui.statuses.at(-1)?.initializing, false);
  await unlink(join(f.home, "mcp.json"));
  await viewer.host.submit(`/sessions ${originalId}`);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, false);
});

test("print mode reports unavailable MCP instead of sending an incomplete first request", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const mcp = await httpMcpFixture(t, { authorization: "Bearer missing-token" });
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  await assert.rejects(f.start(new RecordingUI(), ["--print"]), /MCP startup incomplete/);
  assert.equal(f.requests.length, 0);
});

test("exiting during MCP startup closes connections without enabling the composer", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mcp = await httpMcpFixture(t, { initialize: () => gate });
  t.after(() => release());
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const ui = new RecordingUI();
  const host = new ArkHost(parseCli(["--cwd", f.cwd, "--home", f.home, "--model", "fixture/test"]), ui);
  t.after(() => host.exit());
  const starting = host.start();
  await until(() => mcp.initialized === 1);
  await host.exit();
  await starting;
  assert.ok(ui.statuses.every(({ initializing }) => initializing));
  await host.submit("Do not send after shutdown.");
  assert.equal(f.requests.length, 0);
});

test("exiting before startup acquires its workspace does not leave a writer lease", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const ui = new RecordingUI();
  const host = new ArkHost(parseCli(["--cwd", f.cwd, "--home", f.home, "--model", "fixture/test"]), ui);
  t.after(() => host.exit());
  const starting = host.start();
  await host.exit();
  await starting;
  const lease = await SessionLease.acquire(ui.statuses.at(-1)?.sessionId ?? "unused");
  t.after(() => lease.release());
  assert.equal(lease.viewer, false);
  assert.equal(f.requests.length, 0);
});

test("untrusted project MCP, viewer and execution-unconfirmed sessions do not start connections", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
  const mcp = await httpMcpFixture(t);
  await mkdir(join(f.cwd, ".arkcode"), { recursive: true });
  await writeFile(join(f.cwd, ".arkcode", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  await writeFile(join(f.home, "settings.json"), JSON.stringify({ provider: "fixture", model: "test", thinking: "off", trustedWorkspaces: [] }));
  const untrusted = await f.start();
  await untrusted.host.submit("/mcp status");
  assert.match(untrusted.ui.inspections.at(-1)?.text ?? "", /skipped in untrusted workspace/);
  assert.equal(mcp.initialized, 0);
  await untrusted.host.exit();
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { exposure: "direct", url: mcp.url } } }));
  const owner = await f.start();
  assert.equal(mcp.initialized, 1);
  await owner.host.submit("Persist the owned session");
  const ownerId = owner.ui.statuses.at(-1)?.sessionId;
  assert.ok(ownerId);
  const viewer = await f.start(new RecordingUI(), ["resume", ownerId]);
  assert.equal(mcp.initialized, 1);
  await viewer.host.submit("/mcp status");
  assert.match(viewer.ui.inspections.at(-1)?.text ?? "", /fixture: blocked/);
  await viewer.host.submit("/mcp reconnect");
  assert.match(viewer.ui.inspections.at(-1)?.text ?? "", /Read-only viewer/);
  await viewer.host.exit(); await owner.host.exit();
  await writeRunMarker(f.home, ownerId, { status: "active", runId: "orphan-run", startedAt: Date.now(), pid: process.pid, cwd: f.cwd });
  const recovery = await f.start(new RecordingUI(), ["resume", ownerId]);
  await recovery.host.submit("/mcp status");
  assert.match(recovery.ui.inspections.at(-1)?.text ?? "", /fixture: blocked/);
  assert.equal(mcp.initialized, 1);
  await recovery.host.exit();
});

test("real stdio MCP stays alive across session switches and exits with all sessions on shutdown", async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "mcp__local__echo", arguments: { text: "stdio" } } : { kind: "text", text: "Done." });
  const log = join(f.cwd, "mcp-events.jsonl");
  const serverPath = join(f.cwd, "mcp-server.mjs");
  await writeFile(serverPath, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = (event) => appendFileSync(process.env.ARKCODE_MCP_TEST_LOG, JSON.stringify({event, pid:process.pid})+'\\n');
log('started');
const input = createInterface({input:process.stdin});
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}};
  if (message.method === 'tools/list') result = {tools:[${JSON.stringify(echoMcpTool)}]};
  if (message.method === 'tools/call') {log('called'); result={content:[{type:'text',text:'stdio receipt'}]};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});
input.on('close', () => {log('closed'); process.exit(0);});
`);
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { local: { exposure: "direct", command: process.execPath, args: [serverPath], env: { ARKCODE_MCP_TEST_LOG: log } } } }));
  const { host } = await f.start();
  await host.submit("Call local MCP.");
  assert.match(JSON.stringify(f.requests[1]?.messages), /stdio receipt/);
  await host.submit("/new");
  await host.exit();
  const events = (await readFile(log, "utf8")).trim().split("\n").map((line) => z.object({ event: z.string(), pid: z.number() }).parse(JSON.parse(line)));
  assert.deepEqual(events.map((event) => event.event), ["started", "called", "started", "closed", "closed"]);
  for (const pid of new Set(events.map((event) => event.pid))) assert.throws(() => process.kill(pid, 0));
});

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
  assert.equal(ui.draft(), "");
  assert.ok(ui.messages.some((item) => item.kind === "user" && item.text === "Sound history"));
  assert.equal(ui.statuses.at(-1)?.permission, "never-ask");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, false);
});

test("session center creates a separate session and draft in the selected project", { timeout: 30000 }, async (t) => {
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
  assert.equal(ui.draft(), "");
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
  const lease = await SessionLease.acquire(saved.getSessionId());
  try { assert.equal(lease.viewer, false); }
  finally { await lease.release(); }
});

test("removed commands are rejected without running the agent, while @ references still work", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "File reference received." }));
  const { host, ui } = await f.start();
  await host.submit("/help");
  assert.equal(ui.messages.at(-1)?.text.split("\n")[0], "/help /model /connect /permissions /tool-mode /web-search /mcp /skills /status /new /sessions /rename /fork /compact /copy /init /exit");
  for (const command of ["diff", "review", "ps", "theme", "statusline", "stop", "quit", "mention", "clear", "resume"]) {
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
  const shell = usesPowerShell ? "[Console]::Write('shell verified')" : "printf 'shell verified'";
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
  assert.deepEqual(ui.tools.filter((tool) => tool.state === "running" && tool.text === "" && tool.details?.target).map((tool) => tool.details?.target), ["input.txt", "result.txt", "result.txt", shell]);
  assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("source evidence")));
  assert.ok(ui.tools.some((tool) => tool.name === "bash" && tool.state === "done" && tool.text.includes("shell verified") && tool.details?.exitCode === 0));
  const lastRequest = f.requests.at(-1); assert.ok(lastRequest);
  assert.ok(lastRequest.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("Successfully replaced 1 block(s) in result.txt")));
  const saved = await f.sessions(); assert.equal(saved.length, 1);
  assert.ok((await readFile(saved[0] ?? "", "utf8")).includes("Verified all changes."));
  assert.match(ui.tools.findLast((tool) => tool.name === "write" && tool.state === "done")?.details?.diff ?? "", /\+1 before/);
  assert.match(ui.tools.findLast((tool) => tool.name === "edit" && tool.state === "done")?.details?.diff ?? "", /-1 before\n\+1 after/);
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.match(resumed.ui.tools.findLast((tool) => tool.name === "edit")?.details?.diff ?? "", /-1 before\n\+1 after/);
});

test("context status follows the active model window and carries token estimates", async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Done." }), false, 65536);
  const { host, ui } = await f.start();
  assert.equal(ui.statuses.at(-1)?.context?.contextWindow, 65536);
  await host.submit("Show usage.");
  const usage = ui.statuses.at(-1)?.context;
  assert.ok(usage && usage.tokens !== null && usage.tokens > 0);
  assert.equal(usage.percent, usage.tokens / 65536 * 100);
  await host.submit("/model fixture/alternate");
  assert.equal(ui.statuses.at(-1)?.context?.contextWindow, 128000);
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
    ? { kind: "tool", name: "bash", arguments: { command } }
    : { kind: "text", text: "The command failed with exit code 9." });
  const { host, ui } = await f.start();
  await host.submit("Run the diagnostic command.");
  const failed = ui.tools.findLast((tool) => tool.state === "error");
  assert.equal(failed?.details?.exitCode, 9);
  assert.match(failed?.text ?? "", /exited with code 9/);
  assert.ok(f.requests.at(-1)?.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("exited with code 9")));
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

test("an unrelated active run marker never blocks a new session in the same workspace", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Independent work" }));
  await writeRunMarker(f.home, "unpersisted-session", {
    status: "active", runId: "unconfirmed-first-run", startedAt: Date.now(), pid: process.pid, cwd: f.cwd,
  });
  const { host, ui } = await f.start();
  assert.equal(ui.statuses.at(-1)?.executionBlocked, false);
  await host.submit("Work independently");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 1);
  assert.equal(ui.messages.some((message) => message.text.includes("Execution unconfirmed")), false);
});

test("denied writes return a tool error and the agent can continue", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index === 0
    ? { kind: "tool", name: "write", arguments: { path: "denied.txt", content: "must not exist" } }
    : { kind: "text", text: "Write was denied." });
  const ui = new RecordingUI(async () => "deny");
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
  await host.submit("Write a file.");
  assert.equal(ui.approvals[0]?.tool, "write");
  assert.ok(ui.tools.some((tool) => tool.name === "write" && tool.state === "error" && tool.text.includes("denied")));
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  assert.equal(ui.answers.at(-1), "Write was denied.");
  assert.equal(host.outcome, "completed");
});

test("unconfirmed agents retain six tools but can only inspect files", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return { kind: "tool", name: "read", arguments: { path: "input.txt" } };
    if (index === 1) return { kind: "tool", name: "write", arguments: { path: "denied.txt", content: "must not exist" } };
    return { kind: "text", text: "Inspection complete. Writing unavailable." };
  });
  await writeFile(join(f.cwd, "input.txt"), "read-only evidence\n");
  const encoded = Buffer.from(process.platform === "win32" ? f.cwd.toLowerCase() : f.cwd).toString("base64url");
  const manager = SessionManager.create(f.cwd, join(f.home, "sessions", encoded));
  manager.appendMessage({ role: "user", content: "Before crash", timestamp: Date.now() });
  await writeRunMarker(f.home, manager.getSessionId(), { status: "active", runId: "unconfirmed", startedAt: Date.now(), pid: process.pid, cwd: f.cwd });
  const { host, ui } = await f.start(new RecordingUI(), ["resume", manager.getSessionId()]);
  await host.submit("Inspect the input");
  assert.equal(host.outcome, "completed");
  assert.ok(ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("read-only evidence")));
  assert.equal(ui.approvals.length, 0);
  assert.ok(ui.tools.some((tool) => tool.name === "write" && tool.state === "error"));
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  assert.equal(ui.answers.at(-1), "Inspection complete. Writing unavailable.");
  assert.deepEqual(f.requests[0]?.tools?.map((tool) => tool.function.name).sort(), ["bash", "codemode", "edit", "glob", "grep", "read", "write"]);
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

test("a viewer can create or fork an independent session without changing the owned history", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Owner answer." }));
  const owner = await f.start();
  await owner.host.submit("Owner prompt");
  const path = (await f.sessions())[0]; assert.ok(path);
  const saved = await readFile(path, "utf8");
  const id = owner.ui.statuses.at(-1)?.sessionId; assert.ok(id);
  const viewer = await f.start(new RecordingUI(), ["resume", id, "--model", "fixture/alternate", "--thinking", "high"]);
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, true);
  assert.equal(viewer.ui.statuses.at(-1)?.model, "fixture/alternate");
  assert.equal(viewer.ui.statuses.at(-1)?.thinking, "high");
  for (const input of ["Run another prompt", "/rename overwritten", "/permissions never-ask"]) await viewer.host.submit(input);
  assert.equal(viewer.ui.messages.filter((message) => message.kind === "error" && message.text.includes("viewer")).length, 3);
  assert.equal(f.requests.length, 1);
  assert.equal(await readFile(path, "utf8"), saved);
  await viewer.host.submit("/fork");
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, false);
  assert.notEqual(viewer.ui.statuses.at(-1)?.sessionId, id);
  await viewer.host.submit("Independent fork prompt");
  await viewer.host.submit("/new");
  assert.equal(viewer.ui.statuses.at(-1)?.viewer, false);
  assert.equal(await readFile(path, "utf8"), saved);
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
  const command = usesPowerShell
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
  const f = await fixture(t, () => ({ kind: "tool", name: "write", arguments: { path: "blocked.txt", content: "blocked mutation" } }));
  const ui = new RecordingUI(() => new Promise<ApprovalDecision>(() => {}));
  const { host } = await f.start(ui, ["--permissions", "always-ask"]);
  const run = host.submit("Wait for approval");
  await until(() => ui.statuses.at(-1)?.state.kind === "awaiting-approval");
  const command = usesPowerShell ? "Set-Content -Path queued.txt -Value 'must not execute'" : "printf 'must not execute' > queued.txt";
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

test("recovery restrictions stay with the interrupted session while new sessions can run", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Saved answer" }));
  const original = await f.start();
  await original.host.submit("Save before crash");
  const id = original.ui.statuses.at(-1)?.sessionId; assert.ok(id);
  await original.host.exit();
  await writeRunMarker(f.home, id, { status: "active", runId: "unconfirmed-run", startedAt: 123, pid: process.pid });
  const { host, ui } = await f.start(new RecordingUI(), ["resume", id]);
  assert.equal(host.outcome, "interrupted");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  await host.submit("/permissions never-ask");
  assert.match(ui.messages.at(-1)?.text ?? "", /Execution unconfirmed/);
  await host.submit("/new");
  assert.equal(ui.statuses.at(-1)?.executionBlocked, false);
  await host.submit("Independent work");
  assert.equal(host.outcome, "completed");
  await host.submit(`/sessions ${id}`);
  assert.equal(ui.statuses.at(-1)?.executionBlocked, true);
  assert.equal(f.requests.length, 2);
});

for (const command of ["/new", "/sessions --last", "/fork"]) {
  test(`${command} keeps the original busy session and its queued inputs`, { timeout: 30000 }, async (t) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(t, async (_request, index) => {
      if (index === 1) await gate;
      return { kind: "text", text: "Completed answer" };
    });
    t.after(() => release());
    const { host, ui } = await f.start();
    await host.submit("Save original history");
    const id = ui.statuses.at(-1)?.sessionId; assert.ok(id);
    const run = host.submit("Block this turn");
    await until(() => f.requests.length === 2);
    await host.submit("Pending follow-up", "follow-up");
    ui.setDraft("Original draft");
    await host.submit(command);
    if (command !== "/sessions --last") assert.notEqual(ui.statuses.at(-1)?.sessionId, id);
    await host.submit(`/sessions ${id}`);
    assert.equal(ui.statuses.at(-1)?.state.kind, "running");
    assert.equal(ui.draft(), "Original draft");
    assert.ok(ui.statuses.at(-1)?.queued.some((text) => text.includes("Pending follow-up")));
    release(); await run;
    assert.equal(host.outcome, "completed");
    assert.equal(f.requests.length, 3);
  });
}

test("session approval grants apply only to the same tool, cwd and exact operation", async () => {
  const ui: RecordingUI = new RecordingUI(async (): Promise<ApprovalDecision> => ui.approvals.length === 1 ? "session" : "deny");
  const broker = new ApprovalBroker(ui, () => "always-ask", () => {});
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
  const broker = new ApprovalBroker(ui, () => "always-ask", (request) => changes.push(request));
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

for (const permission of ["never-ask", "ask-when-needed", "always-ask"]) {
  test(`permission selection persists ${permission} across host restarts`, async (t) => {
    const f = await fixture(t, () => ({ kind: "text", text: "Unused." }));
    class PermissionsUI extends RecordingUI {
      override async choose(title: string): Promise<string | null> {
        return title === "Permissions" ? permission : null;
      }
    }
    const options = parseCli(["--cwd", f.cwd, "--home", f.home]);
    const ui = new PermissionsUI();
    const host = new ArkHost(options, ui);
    const override = permission === "always-ask" ? "never-ask" : "always-ask";
    try {
      await host.start();
      await host.submit(`/permissions ${override}`);
      assert.equal(loadConfig(f.home).permission, override);
      await host.submit("/permissions");
      assert.equal(ui.statuses.at(-1)?.permission, permission);
      assert.equal(loadConfig(f.home).permission, permission);
    } finally { await host.exit(); }

    const restoredUI = new RecordingUI();
    const restored = new ArkHost(parseCli(["--cwd", f.cwd, "--home", f.home]), restoredUI);
    try {
      await restored.start();
      assert.equal(restoredUI.statuses.at(-1)?.permission, permission);
    } finally { await restored.exit(); }

    const explicit = await f.start(new RecordingUI(), ["--permissions", override]);
    assert.equal(explicit.ui.statuses.at(-1)?.permission, override);
    assert.equal(loadConfig(f.home).permission, permission);
  });
}

test("permission changes invalidate pending approval decisions", async () => {
  let permission: Permission = "always-ask";
  let resolveDecision: (decision: ApprovalDecision) => void = () => {};
  const decision = new Promise<ApprovalDecision>((resolve) => { resolveDecision = resolve; });
  const ui: RecordingUI = new RecordingUI(async (): Promise<ApprovalDecision> => ui.approvals.length === 1 ? decision : "once");
  const broker = new ApprovalBroker(ui, () => permission, () => {});
  const request: ApprovalRequest = { id: "permission-change", tool: "write", cwd: "/workspace", description: "Write output.txt\ncontent" };
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
  assert.deepEqual(first.tools?.map((tool) => tool.function.name), ["read", "write", "edit", "grep", "glob", "bash", "codemode"]);
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
    { kind: "tool", name: "write", arguments: { path: "automatic.txt", content: "before" } },
    { kind: "tool", name: "edit", arguments: { path: "automatic.txt", oldText: "before", newText: "after" } },
    { kind: "tool", name: "bash", arguments: { command: "node --version" } },
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
  const request = (command: string): ApprovalRequest => ({ id: command, tool: "bash", cwd: "/workspace", description: command, invocation: { kind: "shell", command, shell: "/bin/sh" } });
  for (const tool of ["read", "grep", "glob"]) assert.equal(await broker.authorize({ id: tool, tool, cwd: "/workspace", description: "inspect" }), true);
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
  const pending = broker.authorize({ id: "stale", tool: "bash", cwd: "/workspace", description: "ls", invocation: { kind: "shell", command: "ls", shell: "/bin/sh" } });
  permission = "never-ask";
  broker.reset();
  assert.equal(await pending, false);
  assert.equal(ui.approvals.length, 0);
});

test("manual compact checkpoints the handoff and refreshes instructions from its preserved baseline", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => {
    if (index === 0) return { kind: "tool", name: "write", arguments: { path: "tracked.txt", content: "saved" } };
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
  assert.equal(compact.summary, "Summary or completed answer.");
  const checkpoint = parseCheckpoint(compact.details); assert.ok(checkpoint);
  assert.deepEqual(checkpoint.retainedUsers.map(renderUser), ["Create the tracked file", "Keep a recent turn"]);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /tracked.txt/);
  await writeFile(join(f.cwd, "AGENTS.md"), "Instructions after compact.");
  await host.submit("Continue after compact");
  const request = f.requests.at(-1); assert.ok(request);
  const context = request.messages.at(-1);
  assert.equal(context?.role, "user");
  assert.match(JSON.stringify(request.messages), /<cwd>/);
  assert.match(JSON.stringify(context?.content), /Instructions after compact/);
  assert.equal(ui.messages.some((message) => message.text.includes("<environment_context>")), false);
});

test("automatic compact during tool continuation reinjects current context before the next conversational request", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (_request, index) => index < 2
    ? { kind: "tool", name: "read", arguments: { path: "large.txt", offset: index * 2000 + 1, limit: 2000 } }
    : { kind: "text", text: "Compacted evidence or completed answer." }, false, 53000);
  await writeFile(join(f.cwd, "large.txt"), "Large inspected evidence.\n".repeat(5200));
  await writeFile(join(f.cwd, "AGENTS.md"), "Current automatic compact instructions.");
  const { host, ui } = await f.start();
  await host.submit("Inspect the large file");
  assert.equal(host.outcome, "completed");
  const paths = await f.sessions();
  const entries = SessionManager.open(paths[0] ?? "").getBranch();
  const compact = entries.findLast((entry) => entry.type === "compaction");
  assert.ok(compact?.type === "compaction");
  const after = f.requests.findLast((request) => request.messages.some((message) => JSON.stringify(message.content).includes(SUMMARY_PREFIX)));
  assert.ok(after);
  assert.equal(after.messages.at(-1)?.role, "user");
  assert.match(JSON.stringify(after.messages), /<environment_context>|Current automatic compact instructions/);
  assert.equal(ui.messages.some((message) => message.text.includes("<environment_context>")), false);
});

function isCompactRequest(request: ModelRequest): boolean {
  return JSON.stringify(request.messages.at(-1)?.content).includes("Create a context checkpoint for an LLM continuing the same task.");
}

test("ArkCode compact retains 20k of raw user text without restoring historical Skill bodies", { timeout: 30000 }, async (t) => {
  let readSkill = false;
  let skillPath = "";
  const f = await fixture(t, (request) => {
    if (isCompactRequest(request)) return { kind: "text", text: "Continue the user's task; the inspected evidence is complete." };
    if (readSkill) { readSkill = false; return { kind: "tool", name: "read", arguments: { path: skillPath } }; }
    return { kind: "text", text: "MODEL OUTPUT OMITTED AFTER COMPACT ".repeat(2500) };
  });
  const directory = join(f.cwd, ".agents", "skills", "review"); await mkdir(directory, { recursive: true });
  skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, "---\nname: review\ndescription: Inspect changes.\n---\nFULL ACTIVATED SKILL BODY.\n");
  const { host } = await f.start();
  const input = "@skill:review FIRST USER TEXT " + "用户😀".repeat(10000) + " LAST USER TEXT";
  await host.submit(input);
  await host.submit("/compact");
  assert.equal(host.outcome, "completed");
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  const entry = manager.getBranch().findLast((entry) => entry.type === "compaction"); assert.ok(entry?.type === "compaction");
  const checkpoint = parseCheckpoint(entry.details); assert.ok(checkpoint);
  const retained = checkpoint.retainedUsers.map(renderUser).join("\n");
  assert.ok(textTokens(retained) <= 20000);
  assert.match(retained, /^@skill:review FIRST USER TEXT /); assert.match(retained, / LAST USER TEXT$/);
  assert.doesNotMatch(retained, /FULL ACTIVATED SKILL BODY|environment_context|MODEL OUTPUT/);
  assert.doesNotMatch(JSON.stringify(checkpoint.replacementMessages), /FULL ACTIVATED SKILL BODY|arkcode-active-skills|<skill-loaded name=/);
  assert.match(JSON.stringify(f.requests.find(isCompactRequest)?.messages), /FULL ACTIVATED SKILL BODY/);
  assert.match(await readFile(manager.getSessionFile() ?? "", "utf8"), /FULL ACTIVATED SKILL BODY/);
  assert.ok(!checkpoint.replacementMessages.some((message) => ["assistant", "toolResult"].includes(message.role)));
  assert.match(JSON.stringify(checkpoint.replacementMessages.at(-1)), /Another language model started/);
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  await resumed.host.submit("Continue the existing task.");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /MODEL OUTPUT OMITTED AFTER COMPACT/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /FULL ACTIVATED SKILL BODY|<skill-loaded name=/);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /@skill:review/);
  assert.match(toolPrompt(f.requests.at(-1), "skills"), /review|Inspect changes/);
  const requests = f.requests.length;
  readSkill = true;
  await resumed.host.submit("Read the review Skill if it is needed to continue.");
  assert.doesNotMatch(JSON.stringify(f.requests[requests]?.messages), /FULL ACTIVATED SKILL BODY/);
  assert.ok(resumed.ui.tools.some((tool) => tool.name === "read" && tool.state === "done" && tool.text.includes("FULL ACTIVATED SKILL BODY")));
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /FULL ACTIVATED SKILL BODY/);
});

test("compact refresh removes a historical Skill snapshot from an otherwise unchanged checkpoint", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Continue the verified task." : "Prior inspected output. ".repeat(3000) }));
  const { host } = await f.start();
  await host.submit("Create history."); await host.submit("/compact"); await host.exit();
  const file = (await f.sessions())[0] ?? "";
  const manager = SessionManager.open(file);
  const entry = manager.getBranch().findLast((entry) => entry.type === "compaction"); assert.ok(entry?.type === "compaction");
  const checkpoint = parseCheckpoint(entry.details); assert.ok(checkpoint);
  checkpoint.id = "legacy-skills-checkpoint";
  checkpoint.cutoff = manager.getLeafId();
  checkpoint.replacementMessages.splice(checkpoint.replacementMessages.length - 1, 0, {
    role: "custom", customType: "arkcode-active-skills", content: "HISTORICAL SKILL SNAPSHOT BODY", display: false, timestamp: Date.now(),
  });
  manager.appendCompaction(checkpoint.summary, null, checkpoint.tokensBefore, { arkcode: checkpoint }, true);
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  const requests = f.requests.length;
  await resumed.host.submit("/compact");
  assert.equal(resumed.host.outcome, "completed"); assert.equal(f.requests.length, requests);
  const refreshed = SessionManager.open(file).getBranch().findLast((entry) => entry.type === "compaction"); assert.ok(refreshed?.type === "compaction");
  const updated = parseCheckpoint(refreshed.details); assert.ok(updated);
  assert.equal(updated.kind, "refresh"); assert.notEqual(updated.id, checkpoint.id);
  assert.deepEqual(updated.retainedUsers, checkpoint.retainedUsers);
  assert.doesNotMatch(JSON.stringify(updated.replacementMessages), /HISTORICAL SKILL SNAPSHOT BODY|arkcode-active-skills/);
  assert.match(await readFile(file, "utf8"), /HISTORICAL SKILL SNAPSHOT BODY/);
  await resumed.host.submit("/compact");
  assert.equal(SessionManager.open(file).getBranch().findLast((entry) => entry.type === "compaction")?.id, refreshed.id);
  await resumed.host.submit("Continue after refresh.");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /HISTORICAL SKILL SNAPSHOT BODY/);
});

test("pre-query compact preserves a newly selected Skill only in the pending input", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request, index) => ({ kind: "text", text: isCompactRequest(request) ? "Prior task progress and verified next actions." : index === 0 ? "EARLIER EVIDENCE ".repeat(21000) : "Continued." }), false, 103000);
  const directory = join(f.cwd, ".agents", "skills", "review"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: review\ndescription: Inspect changes.\n---\nNEW PENDING SKILL BODY.\n");
  const { host } = await f.start();
  await host.submit("The earlier task.");
  await host.submit("@skill:review inspect the pending task.");
  assert.equal(host.outcome, "completed");
  const summary = f.requests.find(isCompactRequest); assert.ok(summary);
  assert.doesNotMatch(JSON.stringify(summary.messages), /NEW PENDING SKILL BODY|inspect the pending task/);
  const normal = JSON.stringify(f.requests.at(-1)?.messages);
  assert.equal(normal.split("NEW PENDING SKILL BODY").length - 1, 1);
  assert.equal(normal.split("@skill:review inspect the pending task.").length - 1, 1);
  const entry = SessionManager.open((await f.sessions())[0] ?? "").getBranch().findLast((entry) => entry.type === "compaction"); assert.ok(entry?.type === "compaction");
  const checkpoint = parseCheckpoint(entry.details); assert.ok(checkpoint);
  assert.doesNotMatch(JSON.stringify(checkpoint.replacementMessages), /NEW PENDING SKILL BODY|arkcode-active-skills/);
});

test("pre-query automatic compact preserves the pending query once and excludes it from the summary", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request, index) => ({ kind: "text", text: isCompactRequest(request) ? "Prior task progress and verified next actions." : index === 0 ? "EARLIER EVIDENCE ".repeat(21000) : "Continued." }), false, 103000);
  const { host } = await f.start();
  await host.submit("The earlier task.");
  await host.submit("PENDING QUERY MUST APPEAR EXACTLY ONCE");
  assert.equal(host.outcome, "completed");
  const summaryRequest = f.requests.find(isCompactRequest); assert.ok(summaryRequest);
  assert.doesNotMatch(JSON.stringify(summaryRequest.messages), /PENDING QUERY MUST APPEAR EXACTLY ONCE/);
  const normal = f.requests.at(-1); assert.ok(normal);
  assert.equal(JSON.stringify(normal.messages).split("PENDING QUERY MUST APPEAR EXACTLY ONCE").length - 1, 1);
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  const entry = manager.getBranch().findLast((entry) => entry.type === "compaction"); assert.ok(entry?.type === "compaction");
  const checkpoint = parseCheckpoint(entry.details); assert.ok(checkpoint);
  assert.deepEqual(checkpoint.retainedUsers.map(renderUser), ["The earlier task."]);
  assert.equal(checkpoint.pendingEntryIds.length, 1);
  assert.equal(JSON.stringify(manager.buildSessionProjection().messages).split("PENDING QUERY MUST APPEAR EXACTLY ONCE").length - 1, 1);
});

test("compact retries overflow with pruned tool text and preserves the full durable result", { timeout: 30000 }, async (t) => {
  let summaries = 0;
  const f = await fixture(t, (request, index) => {
    if (isCompactRequest(request)) {
      summaries++;
      return summaries === 1 ? { kind: "error", status: 400, message: "maximum context length exceeded" } : { kind: "text", text: "Tool output was pruned; middle evidence is unavailable. Continue from the verified result." };
    }
    return index === 0 ? { kind: "tool", name: "read", arguments: { path: "pruning.txt", limit: 2000 } } : { kind: "text", text: "Verified inspected output. ".repeat(3000) };
  });
  await writeFile(join(f.cwd, "pruning.txt"), "BEGIN\n" + "MIDDLE ORIGINAL TOOL EVIDENCE\n".repeat(1500) + "END\n");
  const { host } = await f.start();
  await host.submit("Inspect pruning.txt."); await host.submit("/compact");
  assert.equal(host.outcome, "completed");
  const requests = f.requests.filter(isCompactRequest); assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /tool result middle pruned/);
  assert.match(JSON.stringify(requests[1]?.messages), /tool result middle pruned/);
  const source = await readFile((await f.sessions())[0] ?? "", "utf8");
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  const original = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.ok(original?.type === "message" && original.message.role === "toolResult");
  assert.match(JSON.stringify(original.message.content), /MIDDLE ORIGINAL TOOL EVIDENCE/);
  assert.doesNotMatch(JSON.stringify(original.message.content), /tool result middle pruned/);
  assert.match(source, /prunedResults":1/);
  assert.equal(TOOL_PRUNING_MARKER.includes("tool result middle pruned"), true);
});

test("compact network retries are bounded without nested provider retries and the old conversation can continue", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => isCompactRequest(request) ? { kind: "error", status: 503, message: "503 temporarily unavailable" } : { kind: "text", text: "Original verified evidence. ".repeat(3000) });
  const { host, ui } = await f.start();
  await host.submit("Create history."); await host.submit("/compact");
  assert.equal(host.outcome, "failed");
  assert.equal(f.requests.filter(isCompactRequest).length, 3);
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  assert.ok(!manager.getEntries().some((entry) => entry.type === "compaction"));
  await host.submit("Continue using the existing context.");
  assert.equal(host.outcome, "completed", JSON.stringify(ui.messages.filter((message) => message.kind === "error")));
});

test("empty and truncated summaries are retried once and never installed", { timeout: 30000 }, async (t) => {
  let attempts = 0;
  const f = await fixture(t, (request) => isCompactRequest(request)
    ? ++attempts === 1 ? { kind: "text", text: "" } : { kind: "text", text: "Incomplete summary", finish: "length" }
    : { kind: "text", text: "Complete original evidence. ".repeat(3000) });
  const { host } = await f.start();
  await host.submit("Create history."); await host.submit("/tool-mode direct"); await host.submit("/compact");
  assert.equal(host.outcome, "failed"); assert.equal(attempts, 2);
  assert.ok(!SessionManager.open((await f.sessions())[0] ?? "").getEntries().some((entry) => entry.type === "compaction"));
  await host.submit("Continue with the previous tools.");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
});

test("an unchanged checkpoint is a no-op and pending tool configuration can refresh without another summary", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Continue the verified task." : "Prior inspected output. ".repeat(3000) }));
  const { host } = await f.start();
  await host.submit("Create history."); await host.submit("/compact");
  const requests = f.requests.length;
  await host.submit("/compact"); assert.equal(f.requests.length, requests);
  await host.submit("/tool-mode direct"); await host.submit("/compact");
  assert.equal(host.outcome, "completed"); assert.equal(f.requests.length, requests);
  const entry = SessionManager.open((await f.sessions())[0] ?? "").getBranch().findLast((entry) => entry.type === "compaction");
  assert.ok(entry?.type === "compaction");
  assert.equal(parseCheckpoint(entry.details)?.kind, "refresh");
  assert.equal(parseCheckpoint(entry.details)?.toolSettings.toolMode, "direct");
  await host.submit("Continue after refresh.");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: direct\./);
});

test("actual overflow recovery compacts once and pauses if the retried request also overflows", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request, index) => isCompactRequest(request)
    ? { kind: "text", text: "Verified earlier work and remaining actions." }
    : index === 0 ? { kind: "text", text: "Original execution evidence. ".repeat(4000) } : { kind: "error", status: 400, message: "maximum context length exceeded" });
  const { host, ui } = await f.start();
  await host.submit("Initial task."); await host.submit("Continue the task.");
  assert.equal(host.outcome, "failed");
  assert.equal(f.requests.filter(isCompactRequest).length, 1);
  assert.equal(f.requests.length, 4);
  assert.ok(ui.messages.some((message) => /overflow persists.*paused/.test(message.text)));
  assert.ok(SessionManager.open((await f.sessions())[0] ?? "").getEntries().some((entry) => entry.type === "compaction"));
  await host.submit("A new query cannot bypass the unresolved overflow.");
  assert.equal(f.requests.length, 4);
});

test("queries queued during manual compact run once in submission order after the checkpoint", { timeout: 30000 }, async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (request) => {
    if (isCompactRequest(request)) { await gate; return { kind: "text", text: "Verified earlier progress. Continue the pending task." }; }
    return { kind: "text", text: "Verified history. ".repeat(2500) };
  });
  const { host } = await f.start();
  await host.submit("Earlier query.");
  const compact = host.submit("/compact");
  await until(() => f.requests.some(isCompactRequest));
  await host.submit("FIRST QUEUED QUERY", "steer");
  await host.submit("SECOND QUEUED QUERY", "follow-up");
  release(); await compact;
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 3);
  const sent = JSON.stringify(f.requests.at(-1)?.messages);
  for (const query of ["FIRST QUEUED QUERY", "SECOND QUEUED QUERY"]) assert.equal(sent.split(query).length - 1, 1);
  assert.ok(sent.indexOf("FIRST QUEUED QUERY") < sent.indexOf("SECOND QUEUED QUERY"));
  assert.doesNotMatch(JSON.stringify(f.requests.find(isCompactRequest)?.messages), /QUEUED QUERY/);
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "arkcode-input"
    && JSON.stringify(entry.data).includes('"kind":"input"')).length, 3);
});

test("cancelling manual compact withdraws queued input and does not resurrect it on resume", { timeout: 30000 }, async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (request) => {
    if (isCompactRequest(request)) await gate;
    return { kind: "text", text: "Verified history. ".repeat(2500) };
  });
  const { host, ui } = await f.start();
  await host.submit("Earlier query.");
  const compact = host.submit("/compact");
  await until(() => f.requests.some(isCompactRequest));
  await host.submit("WITHDRAWN QUEUED QUERY", "follow-up");
  await host.interrupt(); release(); await compact;
  assert.match(ui.draft(), /WITHDRAWN QUEUED QUERY/);
  assert.equal(f.requests.length, 2);
  await host.exit();
  const resumed = await f.start(new RecordingUI(), ["resume", "--last"]);
  assert.equal(f.requests.length, 2);
  await resumed.host.submit("Continue explicitly.");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /WITHDRAWN QUEUED QUERY/);
});

test("automatic compact failure warns and continues when the original request still fits", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => isCompactRequest(request)
    ? { kind: "error", status: 400, message: "Summary generation rejected by fixture" }
    : { kind: "text", text: "Evidence before failed compact. ".repeat(4500) }, false, 53000);
  const { host, ui } = await f.start();
  await host.submit("Earlier task."); await host.submit("Continue within the hard limit.");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.filter(isCompactRequest).length, 1);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /Continue within the hard limit/);
  assert.ok(ui.messages.some((message) => /Automatic compact failed.*Continuing/.test(message.text)));
  assert.ok(!SessionManager.open((await f.sessions())[0] ?? "").getBranch().some((entry) => entry.type === "compaction"));
});

test("a budget pause preserves pending input and resumes in the same session after selecting a larger model", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, () => ({ kind: "text", text: "Resumed safely." }), false, 28000);
  const { host, ui } = await f.start();
  const id = ui.statuses.at(-1)?.sessionId;
  await host.submit("PENDING ORIGINAL TASK");
  assert.equal(host.outcome, "failed"); assert.equal(f.requests.length, 0);
  assert.ok(ui.messages.some((message) => /25k input reserve/.test(message.text)));
  await host.submit("/model fixture/alternate"); await host.submit("Continue the pending task.");
  assert.equal(host.outcome, "completed");
  assert.equal(ui.statuses.at(-1)?.sessionId, id);
  assert.equal(f.requests.at(-1)?.model, "alternate");
  assert.equal(JSON.stringify(f.requests.at(-1)?.messages).split("PENDING ORIGINAL TASK").length - 1, 1);
});

test("actual overflow recovery retries the request without rerunning completed tools", { timeout: 30000 }, async (t) => {
  let normals = 0;
  const f = await fixture(t, (request) => {
    if (isCompactRequest(request)) return { kind: "text", text: "The file was written successfully. Continue without repeating the write." };
    normals++;
    if (normals === 1) return { kind: "tool", name: "write", arguments: { path: "once.txt", content: "Verified file evidence. ".repeat(1000) } };
    if (normals === 2) return { kind: "error", status: 400, message: "maximum context length exceeded" };
    return { kind: "text", text: "Recovered without repeating the write." };
  });
  const { host, ui } = await f.start();
  await host.submit("Write once, then continue.");
  assert.equal(host.outcome, "completed");
  assert.equal(normals, 3); assert.equal(f.requests.filter(isCompactRequest).length, 1);
  assert.equal(ui.tools.filter((tool) => tool.name === "write" && tool.state === "done").length, 1);
  assert.equal(await readFile(join(f.cwd, "once.txt"), "utf8"), "Verified file evidence. ".repeat(1000));
});

test("committed checkpoint activation failure blocks requests until explicit recovery", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Verified work and next steps." : "Original execution evidence. ".repeat(3000) }));
  const { host, ui } = await f.start();
  await host.submit("Original task."); await host.submit("/tool-mode direct");
  const activate = AgentSession.prototype.activateHostCheckpoint;
  let failed = false;
  t.mock.method(AgentSession.prototype, "activateHostCheckpoint", function(this: AgentSession) {
    if (!failed) { failed = true; throw new Error("Injected activation failure"); }
    return activate.call(this);
  });
  await host.submit("/compact"); assert.equal(host.outcome, "failed");
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  const count = f.requests.length;
  await host.submit("Pending during recovery."); assert.equal(f.requests.length, count);
  assert.ok(ui.messages.some((message) => /must be recovered/.test(message.text)));
  await host.submit("/compact");
  assert.equal(host.outcome, "completed"); assert.equal(f.requests.length, count);
  await host.submit("Continue after recovery.");
  assert.equal(host.outcome, "completed");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: direct\./);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /Verified work and next steps/);
});

test("unknown ArkCode checkpoint versions are rejected before a resumed request", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Verified work." : "Original execution evidence. ".repeat(3000) }));
  const { host } = await f.start();
  await host.submit("Original task."); await host.submit("/compact"); await host.exit();
  const file = (await f.sessions())[0]; assert.ok(file);
  const original = await readFile(file, "utf8");
  const altered = original.replace('"arkcode":{"version":1,', '"arkcode":{"version":99,');
  assert.notEqual(altered, original); await writeFile(file, altered);
  const before = f.requests.length;
  await assert.rejects(f.start(new RecordingUI(), ["resume", "--last"]));
  assert.equal(f.requests.length, before);
});

test("failed MCP preparation rejects the checkpoint and restores the previous callable tools", { timeout: 30000 }, async (t) => {
  let failuresRemaining = 0;
  const mcp = await httpMcpFixture(t, { initialize: async () => {
    if (failuresRemaining > 0) { failuresRemaining--; throw new Error("Injected MCP initialization failure"); }
  } });
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Verified work." : "Original execution evidence. ".repeat(3000) }));
  await writeFile(join(f.home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: mcp.url } } }));
  const { host } = await f.start();
  await host.submit("Original task."); await host.submit("/tool-mode direct"); await host.submit("/mcp exposure fixture direct");
  failuresRemaining = 3;
  await host.submit("/compact"); assert.equal(host.outcome, "failed");
  assert.ok(!SessionManager.open((await f.sessions())[0] ?? "").getBranch().some((entry) => entry.type === "compaction"));
  await host.submit("Continue with the established policy.");
  assert.equal(host.outcome, "completed");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  assert.match(toolPrompt(f.requests.at(-1), "mcp_tool_modes"), /codemode: Access these MCP tools/);
});

test("automatic compact waits for every tool result in a parallel batch and does not rerun tools", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request, index) => {
    if (isCompactRequest(request)) {
      assert.equal(request.messages.filter((message) => message.role === "tool").length, 2);
      return { kind: "text", text: "Both files were read. Continue from the verified evidence." };
    }
    return index === 0 ? { kind: "tools", calls: ["first.txt", "second.txt"].map((path) => ({ kind: "tool", name: "read", arguments: { path } })) }
      : { kind: "text", text: "Both reads are complete." };
  }, false, 53000);
  for (const file of ["first.txt", "second.txt"]) await writeFile(join(f.cwd, file), ("Parallel batch evidence. ".repeat(2) + "\n").repeat(950));
  const { host, ui } = await f.start();
  await host.submit("Read both files and finish.");
  assert.equal(host.outcome, "completed");
  assert.equal(f.requests.length, 3); assert.equal(f.requests.filter(isCompactRequest).length, 1);
  assert.equal(ui.tools.filter((tool) => tool.name === "read" && tool.state === "done").length, 2);
});

test("an unchanged checkpoint cannot bypass the hard limit for an oversized pending query", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Verified earlier progress." : "Original execution evidence. ".repeat(3000) }));
  const { host, ui } = await f.start();
  await host.submit("Original task."); await host.submit("/compact");
  const count = f.requests.length;
  await host.submit("OVERSIZED PENDING QUERY " + "x".repeat(520000));
  assert.equal(host.outcome, "failed"); assert.equal(f.requests.length, count);
  assert.ok(ui.messages.some((message) => /task is paused.*no longer fits/.test(message.text)));
  await host.submit("/compact"); assert.equal(host.outcome, "failed"); assert.equal(f.requests.length, count);
  const manager = SessionManager.open((await f.sessions())[0] ?? "");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  assert.match(JSON.stringify(manager.buildSessionProjection().messages), /OVERSIZED PENDING QUERY/);
});

test("local shell progress after a checkpoint is summarized before a tool-policy refresh", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Verified work and shell progress." : "Original execution evidence. ".repeat(3000) }));
  const { host } = await f.start();
  await host.submit("Original task."); await host.submit("/compact");
  await host.submit('!node -e "process.stdout.write(\'SHELL_PROGRESS_AFTER_CHECKPOINT\')"');
  await host.submit("/tool-mode direct"); await host.submit("/compact");
  assert.equal(host.outcome, "completed");
  const summaries = f.requests.filter(isCompactRequest);
  assert.equal(summaries.length, 2);
  assert.match(JSON.stringify(summaries.at(-1)?.messages), /SHELL_PROGRESS_AFTER_CHECKPOINT/);
  const entry = SessionManager.open((await f.sessions())[0] ?? "").getBranch().findLast((entry) => entry.type === "compaction");
  assert.ok(entry?.type === "compaction"); assert.equal(parseCheckpoint(entry.details)?.kind, "summary");
});

test("a checkpoint write failure preserves the original history and the effective tool policy", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, (request) => ({ kind: "text", text: isCompactRequest(request) ? "Verified handoff." : "ORIGINAL HISTORY EVIDENCE ".repeat(3000) }));
  const { host } = await f.start();
  await host.submit("Original task."); await host.submit("/tool-mode direct");
  t.mock.method(SessionManager.prototype, "appendCompaction", () => { throw new Error("Injected checkpoint write failure"); });
  await host.submit("/compact"); assert.equal(host.outcome, "failed");
  assert.ok(!SessionManager.open((await f.sessions())[0] ?? "").getBranch().some((entry) => entry.type === "compaction"));
  await host.submit("Continue the original task.");
  assert.equal(host.outcome, "completed");
  assert.match(toolPrompt(f.requests.at(-1), "builtin_tool_mode"), /^Built-in tool mode: codemode\./);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /ORIGINAL HISTORY EVIDENCE/);
});
