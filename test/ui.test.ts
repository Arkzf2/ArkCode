import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { SessionBrowserResult, SessionItem, Status, UiActions } from "../src/app/types.js";
import { sanitizeTerminalText, TerminalUI } from "../src/ui/terminal.js";

class MemoryTerminal implements Terminal {
  output = "";
  readonly rows = 30;
  readonly kittyProtocolActive = false;
  private onInput: ((data: string) => void) | null = null;
  constructor(readonly columns = 80) {}
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void { this.onInput = null; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void { this.output = ""; }
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  press(data: string): void { this.onInput?.(data); }
  text(): string { return stripTerminalSequences(this.output); }
}

const idle: Status = {
  model: "deepseek/deepseek-chat",
  thinking: "medium",
  cwd: "D:/ArkCode/a-long-directory-name",
  permission: "always-ask",
  branch: "main",
  context: { tokens: 1024, contextWindow: 128000, percent: 0.8 },
  state: { kind: "idle", outcome: null },
  queued: [],
  viewer: false,
};
const inertActions: UiActions = {
  async submit() {}, async interrupt() {}, async exit() {}, async editPrevious() {}, async browseSessions() {},
};

const browserItems: SessionItem[] = [
  { id: "current", path: null, cwd: "D:/ArkCode", title: "Current task", preview: "No messages yet", modified: Date.now(), state: "ready", current: true },
  { id: "other", path: "E:/Other/session.jsonl", cwd: "E:/Other", title: "Other project task", preview: "Review a function", modified: Date.now() - 3_600_000, state: "inactive", current: false },
];

test("startup hides the composer and blocks typing, paste and submit until MCP is ready", async (t) => {
  const terminal = new MemoryTerminal(120);
  const submitted: string[] = [];
  const ui = new TerminalUI({ ...inertActions, async submit(text) { submitted.push(text); } }, terminal);
  t.after(() => ui.stop());
  ui.start();
  await setTimeout(30);
  assert.match(terminal.text(), /Initializing\.\.\./);
  assert.doesNotMatch(terminal.text(), /Ask ArkCode to do anything/);
  terminal.press("early input");
  terminal.press("\r");
  ui.status({ ...idle, initializing: true });
  terminal.output = "";
  await setTimeout(230);
  assert.match(terminal.text(), /Initializing\.\.\./);
  assert.ok(new Set(terminal.text().match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g)).size >= 2);
  assert.doesNotMatch(terminal.text(), /ArkCode|MCP|Ctrl\+C|deepseek|medium|Always Ask|main|used/);
  ui.setDraft("Retained startup prompt");
  terminal.press("\x1b[200~early paste\r\x1b[201~");
  terminal.press("\r");
  assert.deepEqual(submitted, []);
  assert.equal(ui.draft(), "Retained startup prompt");
  const trust = ui.choose("Trust workspace?", [{ value: "trust", label: "Trust this workspace" }]);
  terminal.press("1");
  assert.equal(await trust, "trust");
  terminal.output = "";
  ui.status({ ...idle, initializing: false });
  await setTimeout(30);
  assert.doesNotMatch(terminal.text(), /Initializing\.\.\./);
  assert.match(terminal.text(), /Retained startup prompt/);
  assert.match(terminal.text(), /deepseek-chat/);
  assert.doesNotMatch(terminal.text(), /deepseek\/deepseek-chat/);
  terminal.press("\r");
  await setTimeout(10);
  assert.deepEqual(submitted, ["Retained startup prompt"]);
});

test("Ctrl+C exits while startup is waiting for MCP", async (t) => {
  const terminal = new MemoryTerminal();
  let exits = 0;
  const ui = new TerminalUI({ ...inertActions, async exit() { exits++; } }, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, initializing: true });
  ui.start();
  terminal.press("\x03");
  assert.equal(exits, 1);
});

test("temporary MCP pages scroll and leave no transcript entries after Esc or Ctrl+C", async (t) => {
  const terminal = new MemoryTerminal(100);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.message("assistant", "Existing conversation.");
  ui.setDraft("Retained draft");
  ui.start();
  for (const key of ["\x1b", "\x03"]) {
    const page = ui.inspect("MCP fixture tools", Array.from({ length: 60 }, (_, index) => `Tool detail ${index + 1}`).join("\n"));
    await setTimeout(30);
    assert.match(terminal.text(), /MCP fixture tools/);
    assert.match(terminal.text(), /Tool detail 1/);
    terminal.output = "";
    terminal.press("\x1b[6~");
    await setTimeout(30);
    assert.match(terminal.text(), /Tool detail 22/);
    terminal.output = "";
    terminal.press(key);
    await page;
    await setTimeout(30);
    assert.match(terminal.text(), /Existing conversation/);
    assert.doesNotMatch(terminal.text(), /MCP fixture tools|Tool detail/);
    assert.equal(ui.draft(), "Retained draft");
    terminal.output = "";
  }
});

test("MCP choices color connection status and restore the selected action", async (t) => {
  const terminal = new MemoryTerminal(120);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.start();
  const choice = ui.choose("MCP servers", [
    { value: "live", label: "Playwright", description: "user | stdio", status: { text: "connected", tone: "positive" } },
    { value: "offline", label: "Bing Search", description: "user | stdio", status: { text: "disconnected", tone: "muted" } },
  ], { transient: true, initialValue: "offline", hint: "Esc/Ctrl+C back · Help for commands" });
  await setTimeout(30);
  assert.ok(terminal.output.includes("\x1b[38;2;146;189;160mconnected"));
  assert.ok(terminal.output.includes("\x1b[38;2;105;106;114mdisconnected"));
  assert.doesNotMatch(terminal.text(), /Configuration:|Commands:/);
  terminal.press("\r");
  assert.equal(await choice, "offline");
});

test("MCP inspection commands do not enter prompt history", async (t) => {
  const terminal = new MemoryTerminal();
  let ui: TerminalUI;
  ui = new TerminalUI({ ...inertActions, async submit(text) {
    if (text === "/mcp") await ui.inspect("MCP servers", "No MCP servers configured.");
  } }, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.start();
  ui.setDraft("Previous prompt");
  terminal.press("\r");
  await setTimeout(310);
  ui.setDraft("/mcp");
  terminal.press("\r");
  await setTimeout(30);
  terminal.press("\x1b");
  await setTimeout(30);
  terminal.press("\x1b[A");
  assert.equal(ui.draft(), "Previous prompt");
});

test("@ discovers workspace files and directories and Tab completes a file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-mention-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "unique-target.ts"), "export {};");
  await writeFile(join(cwd, "notes with space.md"), "Notes");
  const terminal = new MemoryTerminal(100);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, cwd });
  ui.start();
  terminal.press("@");
  await setTimeout(100);
  assert.match(terminal.text(), /src\//);
  terminal.press("s");
  await setTimeout(100);
  terminal.press("\t");
  await setTimeout(100);
  assert.equal(ui.draft(), "@src/");
  ui.setDraft("");
  terminal.press("@");
  for (const key of "unique-target") terminal.press(key);
  await setTimeout(100);
  assert.match(terminal.text(), /unique-target\.ts/);
  terminal.press("\t");
  await setTimeout(100);
  assert.equal(ui.draft(), "@src/unique-target.ts ");
  ui.setDraft("");
  for (const key of "@notes") terminal.press(key);
  await setTimeout(100);
  terminal.press("\t");
  await setTimeout(100);
  assert.equal(ui.draft(), '@"notes with space.md" ');
});

test("Tab keeps a busy @ draft in the editor while file discovery is pending", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arkcode-busy-mention-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "target.ts"), "export {};");
  const submitted: string[] = [];
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI({ ...inertActions, async submit(text) { submitted.push(text); } }, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, cwd, state: { kind: "running", id: "run", startedAt: Date.now() } });
  ui.start();
  terminal.press("@");
  terminal.press("\t");
  await setTimeout(100);
  assert.deepEqual(submitted, []);
  assert.equal(ui.draft(), "@target.ts ");
  assert.match(terminal.text(), /target\.ts/);
});

test("empty focused composer opens the session center, while draft Left remains an editor key", async (t) => {
  const terminal = new MemoryTerminal(120);
  const selected: Array<SessionBrowserResult | null> = [];
  let ui: TerminalUI;
  ui = new TerminalUI({ ...inertActions, async browseSessions() { selected.push(await ui.browseSessions(browserItems)); } }, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.start();
  ui.setDraft("keep this draft");
  terminal.press("\x1b[D");
  await setTimeout(20);
  assert.doesNotMatch(terminal.text(), /Session command center/);
  ui.setDraft("");
  ui.status({ ...idle, state: { kind: "running", id: "run", startedAt: Date.now() } });
  terminal.press("\x1b[D");
  await setTimeout(20);
  assert.doesNotMatch(terminal.text(), /Session command center/);
  ui.status(idle);
  terminal.press("\x1b[D");
  await setTimeout(40);
  assert.match(terminal.text(), /Session command center/);
  assert.match(terminal.text(), /Session details/);
  terminal.press("\x1b[200~n\r\x1b[201~");
  assert.deepEqual(selected, []);
  terminal.press("\t");
  await setTimeout(20);
  assert.match(terminal.text(), /Inactive 1/);
  terminal.press("\x1b");
  await setTimeout(20);
  assert.deepEqual(selected, [null]);
  assert.equal(ui.draft(), "");
});

test("Left cannot browse before host startup has published an idle status", async (t) => {
  const terminal = new MemoryTerminal();
  let opens = 0;
  const ui = new TerminalUI({ ...inertActions, async browseSessions() { opens++; } }, terminal);
  t.after(() => ui.stop());
  ui.start();
  terminal.press("\x1b[D");
  await setTimeout(20);
  assert.equal(opens, 0);
  ui.status(idle);
  terminal.press("\x1b[D");
  await setTimeout(20);
  assert.equal(opens, 1);
});

test("session center searches, groups, and creates in the selected project", async (t) => {
  const terminal = new MemoryTerminal(72);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle); ui.start();
  const selection = ui.browseSessions(browserItems);
  terminal.press("/");
  for (const key of "Other") terminal.press(key);
  terminal.press("\r");
  terminal.press("g");
  await setTimeout(30);
  assert.match(terminal.text(), /Group: Status/);
  assert.match(terminal.text(), /Other project task/);
  terminal.press("n");
  assert.deepEqual(await selection, { kind: "new", cwd: "E:/Other" });
  assert.equal(ui.draft(), "");
});

test("wide session details load the selected saved history lazily", async (t) => {
  const terminal = new MemoryTerminal(120);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle); ui.start();
  const loaded: string[] = [];
  const selection = ui.browseSessions(browserItems, async (item) => {
    loaded.push(item.id);
    return { lastMessage: `Last answer for ${item.id}`, prompt: "Initial prompt", model: "fixture/test" };
  });
  await setTimeout(25);
  assert.deepEqual(loaded, ["current"]);
  terminal.press("\x1b[B");
  await setTimeout(100);
  assert.deepEqual(loaded, ["current", "other"]);
  assert.match(terminal.text(), /Last answer for other/);
  assert.match(terminal.text(), /fixture\/test/);
  assert.match(terminal.text(), /Initial prompt/);
  terminal.press("\x1b");
  assert.equal(await selection, null);
});

test("narrow session center keeps complete titles, filters, and commands visible", async (t) => {
  const terminal = new MemoryTerminal(40);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle); ui.start();
  const selection = ui.browseSessions(browserItems);
  await setTimeout(50);
  const frame = terminal.text();
  assert.match(frame, /Current task/);
  assert.match(frame, /Other project task/);
  assert.match(frame, /Inactive 1/);
  assert.match(frame, /n new/);
  const currentRow = frame.split(/\r?\n/).find((line) => line.includes("Current task"));
  assert.ok(currentRow);
  assert.doesNotMatch(currentRow, /Ready|now/);
  terminal.press("\x1b");
  assert.equal(await selection, null);
});

test("editor submits idle prompts, busy steering and queued follow-ups", (t) => {
  const delivered: { text: string; mode: string }[] = [];
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI({ ...inertActions, async submit(text, mode) { delivered.push({ text, mode }); } }, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.start();
  ui.setDraft("first task");
  terminal.press("\r");
  ui.status({ ...idle, state: { kind: "running", id: "run1", startedAt: Date.now() } });
  ui.setDraft("change approach");
  terminal.press("\r");
  ui.setDraft("then write tests");
  terminal.press("\t");
  assert.deepEqual(delivered, [
    { text: "first task", mode: "prompt" },
    { text: "change approach", mode: "steer" },
    { text: "then write tests", mode: "follow-up" },
  ]);
});

test("Ctrl+C interrupts a busy agent and exits when idle", (t) => {
  const terminal = new MemoryTerminal();
  const actions: string[] = [];
  const ui = new TerminalUI({ ...inertActions,
    async interrupt() { actions.push("interrupt"); },
    async exit() { actions.push("exit"); },
  }, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, state: { kind: "running", id: "run1", startedAt: Date.now() } });
  ui.start();
  terminal.press("\x03");
  ui.status(idle);
  terminal.press("\x03");
  assert.deepEqual(actions, ["interrupt", "exit"]);
});

test("double Escape edits the previous prompt and Ctrl+O uses the completed-answer command", (t) => {
  const terminal = new MemoryTerminal();
  let edits = 0;
  const commands: string[] = [];
  const ui = new TerminalUI({ ...inertActions, async editPrevious() { edits++; }, async submit(text) { commands.push(text); } }, terminal);
  t.after(() => ui.stop());
  ui.status(idle); ui.start();
  terminal.press("\x1b"); terminal.press("\x1b");
  terminal.press("\x0f");
  assert.equal(edits, 1);
  assert.deepEqual(commands, ["/copy"]);
});

test("approval paste cannot select a decision; explicit selection allows once", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.start();
  let settled = false;
  const result = ui.approve({ id: "a1", tool: "bash", description: "npm test", cwd: "D:/ArkCode" })
    .then((decision) => { settled = true; return decision; });
  terminal.press("\x1b[200~");
  terminal.press("2\r\x03");
  terminal.press("\x1b[201~");
  await setTimeout(20);
  assert.equal(settled, false);
  terminal.press("1");
  assert.equal(await result, "once");
  settled = false;
  const second = ui.approve({ id: "a2", tool: "bash", description: "npm run build", cwd: "D:/ArkCode" })
    .then((decision) => { settled = true; return decision; });
  terminal.press("1");
  await setTimeout(20);
  assert.equal(settled, false);
  terminal.press("\x1b");
  assert.equal(await second, "deny");
});

test("picker cancellation restores draft and input panels accept atomic paste", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.setDraft("keep this task");
  const choice = ui.choose("Models", [{ value: "a", label: "Model A" }]);
  terminal.press("\x1b");
  assert.equal(await choice, null);
  assert.equal(ui.draft(), "keep this task");
  const input = ui.input("Provider environment variable");
  terminal.press("\x1b[200~DEEPSEEK_API_KEY\x1b[201~");
  terminal.press("\r");
  assert.equal(await input, "DEEPSEEK_API_KEY");
  assert.equal(ui.draft(), "keep this task");
});

test("API key input masks terminal output while returning the entered value", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.start();
  const secret = ui.secret("API key");
  terminal.press("private-test-key");
  terminal.press("\x1b[D");
  terminal.press("X");
  assert.equal(terminal.output.includes("private-test-key"), false);
  terminal.press("\r");
  assert.equal(await secret, "private-test-keXy");
});

test("multiline paste inserts draft without sending", (t) => {
  const delivered: string[] = [];
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI({ ...inertActions, async submit(text) { delivered.push(text); } }, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.start();
  terminal.press("\x1b[200~pasted\ntext\t2\x1b[201~");
  assert.match(ui.draft(), /pasted\ntext/);
  assert.deepEqual(delivered, []);
  terminal.press("\r");
  assert.deepEqual(delivered, ["pasted\ntext    2"]);
});

test("Ctrl+T displays full tool receipts", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.tool("tool1", "bash", "line1\nline2\nline3\nline4", "done");
  ui.start();
  await setTimeout(50);
  assert.match(terminal.text(), /line1/);
  assert.doesNotMatch(terminal.text(), /line4/);
  terminal.press("\x14");
  await setTimeout(50);
  assert.match(terminal.text(), /line4/);
});

test("/mcp completes in the terminal and MCP receipts retain the server/tool identity", async (t) => {
  const terminal = new MemoryTerminal(100);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, mcpServers: ["github"] });
  ui.start();
  for (const key of "/mc") terminal.press(key);
  await setTimeout(100);
  terminal.press("\t");
  await setTimeout(100);
  assert.equal(ui.draft(), "/mcp ");
  ui.setDraft("");
  ui.tool("mcp-call", "mcp__github__get_issue", "Issue receipt", "done", { target: "mcp__github__get_issue" });
  await setTimeout(50);
  assert.match(terminal.text(), /Called MCP mcp__github__get_issue/);
  assert.match(terminal.text(), /Issue receipt/);
});

test("status and Markdown fit narrow and wide terminal cells", async (t) => {
  for (const width of [40, 80, 120]) {
    const terminal = new MemoryTerminal(width);
    const ui = new TerminalUI(inertActions, terminal);
    t.after(() => ui.stop());
    ui.status(idle);
    ui.message("assistant", "## Result\n\n\u4e2d\u6587\u6d88\u606f\n\n```ts\nconst answer = 42;\n```");
    ui.start();
    await setTimeout(50);
    const text = terminal.text();
    for (const value of ["deepseek-chat", idle.thinking, idle.cwd, "Always Ask", idle.branch, "1k / 128k", "0.8% used"]) {
      assert.ok(text.replace(/\s+/g, "").includes(value.replace(/\s+/g, "")), `${value} is missing at ${width} columns`);
    }
    assert.doesNotMatch(text, /Model deepseek|Thinking medium|Permissions ask|Branch main/);
    assert.match(text, /const answer = 42/);
    for (const line of text.split(/\r?\n/)) assert.ok(visibleWidth(line) <= width, `Line exceeds ${width} columns`);
    ui.stop();
  }
});

test("tool output cannot inject terminal control sequences", () => {
  assert.equal(sanitizeTerminalText("ok\x1b]52;c;payload\x07\x1b[31mred\x1b[0m\x03"), "okred");
});

test("Prism composer has complete borders and a placeholder without becoming a draft", async (t) => {
  const terminal = new MemoryTerminal(80);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.start();
  await setTimeout(50);
  const rows = terminal.text().split(/\r?\n/);
  assert.ok(rows.some((line) => line.includes("╭") && line.includes("╮")));
  assert.ok(rows.some((line) => line.includes("│ › Ask ArkCode to do anything") && line.trimEnd().endsWith("│")));
  assert.ok(rows.some((line) => line.includes("╰") && line.includes("╯")));
  assert.equal(ui.draft(), "");
  ui.setDraft("Keep the ╯ glyph and 中文 text");
  terminal.output = "";
  await setTimeout(50);
  assert.match(terminal.text(), /Keep the ╯ glyph and 中文 text/);
  assert.equal(ui.draft(), "Keep the ╯ glyph and 中文 text");
});

test("approval replaces the composer while retaining footer metadata and the original draft", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.setDraft("Continue after this decision");
  const approval = ui.approve({ id: "request", tool: "write", description: "Write result.txt", cwd: idle.cwd });
  ui.start();
  await setTimeout(50);
  const frame = terminal.text();
  assert.match(frame, /Allow this tool request/);
  assert.doesNotMatch(frame, /Continue after this decision|Ask ArkCode to do anything|╭/);
  assert.match(frame, /deepseek-chat/);
  assert.equal(ui.draft(), "Continue after this decision");
  terminal.press("\x1b");
  assert.equal(await approval, "deny");
  assert.equal(ui.draft(), "Continue after this decision");
});

test("compact transcript hides reasoning and Ctrl+T shows its final content only once", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.reasoning("thought-1", "Inspect the source", true);
  ui.reasoning("thought-1", "Inspect the source and confirm the retry path.", false);
  ui.start();
  await setTimeout(50);
  assert.doesNotMatch(terminal.text(), /Inspect the source/);
  terminal.output = "";
  terminal.press("\x14");
  await setTimeout(50);
  assert.equal(terminal.text().split("Inspect the source and confirm the retry path.").length - 1, 1);
});

test("streaming answer text replaces the active reasoning indicator", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, state: { kind: "running", id: "run", startedAt: Date.now() } });
  ui.reasoning("thought-1", "Inspect the existing handler.", true);
  ui.start();
  await setTimeout(50);
  assert.match(terminal.text(), /Thinking/);
  terminal.output = "";
  ui.assistantDelta("The handler is ready.");
  await setTimeout(50);
  assert.match(terminal.text(), /Writing response/);
  assert.doesNotMatch(terminal.text(), /Thinking/);
});

test("failed tool summaries keep exit codes visible when receipts are collapsed", async (t) => {
  const terminal = new MemoryTerminal(80);
  const ui = new TerminalUI(inertActions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.tool("shell1", "bash", "", "running", { target: "npm test" });
  ui.tool("shell1", "bash", "first\nsecond\nthird\nlast-error", "error", { exitCode: 9 });
  ui.start();
  await setTimeout(50);
  assert.match(terminal.text(), /Failed npm test\s+exit 9/);
  assert.doesNotMatch(terminal.text(), /last-error/);
  terminal.press("\x14");
  await setTimeout(50);
  assert.match(terminal.text(), /last-error/);
});

test("stopping preserves the draft and prevents keys and paste from sending or editing it", (t) => {
  const terminal = new MemoryTerminal();
  const submitted: string[] = [];
  const ui = new TerminalUI({ ...inertActions, async submit(text) { submitted.push(text); } }, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, state: { kind: "stopping", id: "run", startedAt: Date.now() } });
  ui.setDraft("Recover this draft");
  ui.start();
  terminal.press("x");
  terminal.press("\x1b[200~pasted\ntext\x1b[201~");
  terminal.press("\r");
  assert.equal(ui.draft(), "Recover this draft");
  assert.deepEqual(submitted, []);
});

test("plain output streams deltas without duplicating its final answer", async () => {
  const source = new URL("../src/ui/terminal.ts", import.meta.url).href;
  const code = `import { PlainUI } from ${JSON.stringify(source)};
    const ui = new PlainUI({ json: false, approve: false });
    ui.assistantDelta('Hello ');
    ui.assistantDelta('world');
    ui.assistantEnd('Hello world');
    ui.assistantDelta('Second');
    ui.assistantEnd('Second answer');`;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]);
  assert.equal(result.stdout, "Hello world\nSecond answer\n");
});
