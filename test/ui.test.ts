import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { Status, UiActions } from "../src/domain.js";
import { sanitizeTerminalText, TerminalUI } from "../src/ui.js";

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
  permission: "ask",
  branch: "main",
  context: "1,024 / 128,000",
  state: { kind: "idle", outcome: null },
  queued: [],
  viewer: false,
};
const inertActions: UiActions = {
  async submit() {}, async interrupt() {}, async exit() {}, async editPrevious() {},
};

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
    for (const label of ["Model", "Thinking", "Directory", "Permissions", "Branch", "Context"]) {
      assert.ok(text.includes(label), `${label} is missing at ${width} columns`);
    }
    assert.match(text, /const answer = 42/);
    for (const line of text.split(/\r?\n/)) assert.ok(visibleWidth(line) <= width, `Line exceeds ${width} columns`);
    ui.stop();
  }
});

test("tool output cannot inject terminal control sequences", () => {
  assert.equal(sanitizeTerminalText("ok\x1b]52;c;payload\x07\x1b[31mred\x1b[0m\x03"), "okred");
});

test("plain output streams deltas without duplicating its final answer", async () => {
  const source = new URL("../src/ui.ts", import.meta.url).href;
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
