import assert from "node:assert/strict";
import test from "node:test";
import type { Status, UiActions } from "../src/app/types.js";
import { TerminalUI } from "../src/ui/terminal.js";
import { ScreenTerminal } from "./terminal-fixture.js";
import { browseToolMode } from "../src/ui/tool-mode.js";
import type { ToolMode } from "../src/tools/mode.js";

const idle: Status = {
  model: "fixture/model", thinking: "medium", cwd: "D:/workspace", permission: "always-ask", branch: "main",
  context: { tokens: 32000, contextWindow: 128000, percent: 25 }, state: { kind: "idle", outcome: null }, queued: [], viewer: false,
};
const actions: UiActions = {
  async submit() {}, async interrupt() {}, async exit() {}, async editPrevious() {}, async browseSessions() {},
};

test("tool-mode menu updates pending and closes without leaving transcript content", async (t) => {
  const terminal = new ScreenTerminal(100);
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.message("user", "Keep this conversation visible.");
  ui.start();
  let pending: ToolMode = "codemode";
  const menu = browseToolMode({ ui, current: () => "codemode", pending: () => pending,
    save: (mode) => { pending = mode; }, active: () => true,
  });
  await terminal.flush();
  assert.match(terminal.text(), /Current: codemode/);
  assert.doesNotMatch(terminal.text(), /Pending:/);
  terminal.press("\x1b[B");
  terminal.press("\r");
  await terminal.flush();
  assert.equal(pending, "codemode-only");
  assert.match(terminal.text(), /Pending: codemode-only/);
  terminal.press("\x1b");
  await menu;
  await terminal.flush();
  assert.match(terminal.text(), /Keep this conversation visible/);
  assert.doesNotMatch(terminal.text(), /Current:|Pending:|Tool mode/);
});

test("footer hides provider names and right-aligns context at each terminal width", async (t) => {
  for (const width of [40, 80, 120]) {
    const terminal = new ScreenTerminal(width);
    const ui = new TerminalUI(actions, terminal);
    t.after(() => ui.stop());
    ui.status({ ...idle, model: "provider/team/model" });
    ui.start();
    await terminal.flush();
    assert.match(terminal.text(), /team\/model/);
    assert.doesNotMatch(terminal.text(), /provider\/|Context|left/);
    const { row } = terminal.find("25.0% used");
    assert.equal(terminal.lines()[row]?.length, width - 2, `Context must end two cells from the edge at ${width} columns`);
    terminal.click("32k / 128k");
    await terminal.flush();
    assert.match(terminal.text(), /Estimated used: 32,000 tokens/);
    terminal.press("\x1b");
    ui.status({ ...idle, model: "deepseek-flash" });
    await terminal.flush();
    assert.match(terminal.text(), /deepseek-flash/);
    ui.stop();
  }
});

test("activity and messages use the same full-size dot as tools", async (t) => {
  const terminal = new ScreenTerminal();
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, state: { kind: "running", id: "run", startedAt: Date.now() } });
  ui.message("info", "Preparing the command.");
  ui.tool("command", "Bash", "", "running", { target: "git status" });
  ui.start();
  await terminal.flush();
  const dots = terminal.lines().filter((line) => line.trimStart().startsWith("●"));
  assert.equal(dots.length, 3);
  assert.ok(dots.every((line) => line.indexOf("●") === 2));
  assert.doesNotMatch(terminal.text(), /•/);
});

test("terminal cells distinguish messages, commands, flags, paths and gray output", async (t) => {
  const terminal = new ScreenTerminal();
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.message("info", "Checking the current changes.");
  ui.message("assistant", "I will inspect the source.");
  ui.tool("shell", "Bash", "+ ordinary output\nPASS is still output", "running", { target: 'git diff --stat "src/main.ts"' });
  ui.start();
  await terminal.flush();
  assert.equal(terminal.foreground("● Running"), 0x44d374);
  assert.match(terminal.text(), /● Checking the current changes\./);
  assert.match(terminal.text(), /● I will inspect the source\./);
  assert.doesNotMatch(terminal.text(), /•/);
  assert.equal(terminal.foreground("Checking the current changes."), 0xe5e7eb);
  assert.equal(terminal.foreground("I will inspect the source."), 0xe5e7eb);
  assert.equal(terminal.foreground("git"), 0x8fbeff);
  assert.equal(terminal.foreground("--stat"), 0xe1a0cc);
  assert.equal(terminal.foreground('"src/main.ts"'), 0xc9be8b);
  assert.equal(terminal.foreground("+ ordinary output"), 0x91929a);
  assert.equal(terminal.foreground("PASS is still output"), 0x91929a);
});

test("mouse expands and collapses one receipt while Ctrl+T controls all receipts", async (t) => {
  const terminal = new ScreenTerminal();
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.setDraft("Keep this draft");
  ui.tool("first", "Bash", "one\ntwo\nthree\nfirst hidden\nfirst last", "done", { target: "git status --short" });
  ui.tool("second", "Read", "alpha\nbeta\ngamma\nsecond hidden", "done", { target: "src/中文.ts" });
  ui.start();
  await terminal.flush();
  assert.doesNotMatch(terminal.text(), /first hidden|second hidden/);
  terminal.click("32k / 128k");
  await terminal.flush();
  assert.match(terminal.text(), /Context window: 128,000 tokens/);
  terminal.press("\x1b");
  await terminal.flush();
  terminal.click("+2 lines");
  await terminal.flush();
  assert.match(terminal.text(), /first hidden\n\s+first last/);
  assert.doesNotMatch(terminal.text(), /second hidden/);
  terminal.click("Show less");
  await terminal.flush();
  assert.doesNotMatch(terminal.text(), /first hidden|second hidden|Show less/);
  terminal.press("\x14");
  await terminal.flush();
  assert.match(terminal.text(), /first hidden/);
  assert.match(terminal.text(), /second hidden/);
  assert.equal(ui.draft(), "Keep this draft");
  terminal.press("\x1b");
  await terminal.flush();
  assert.doesNotMatch(terminal.text(), /first hidden|second hidden/);
});

test("receipt clicks track wrapping, resizes and the terminal viewport", async (t) => {
  const terminal = new ScreenTerminal(100, 26);
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.message("assistant", Array.from({ length: 50 }, (_, index) => `Earlier message ${index}`).join("\n"));
  ui.tool("long", "Bash", "first\nsecond\nthird\nlast visible after click", "done", { target: "git status --short" });
  ui.start();
  await terminal.flush();
  terminal.resize(40, 26);
  await terminal.flush();
  terminal.click("+1 lines");
  await terminal.flush();
  assert.match(terminal.text(), /last visible after click/);
  terminal.click("Show less");
  await terminal.flush();
  assert.doesNotMatch(terminal.text(), /last visible after click/);
  assert.equal(ui.draft(), "");
});

test("mouse events do not leak into drafts or bypass approval", async (t) => {
  const terminal = new ScreenTerminal();
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.setDraft("Retained");
  ui.tool("tool", "Bash", "1\n2\n3\nsecret fourth line", "done");
  ui.start();
  await terminal.flush();
  const { row, column } = terminal.find("+1 lines");
  terminal.press(`\x1b[<0;${column + 1};${row + 1}M`);
  terminal.press(`\x1b[<0;${column + 2};${row + 1}m`);
  terminal.press(`\x1b[<2;${column + 1};${row + 1}M`);
  terminal.press(`\x1b[<2;${column + 1};${row + 1}m`);
  await terminal.flush();
  assert.doesNotMatch(terminal.text(), /secret fourth line/);
  const approval = ui.approve({ id: "approve", tool: "Write", description: "Write a file", cwd: idle.cwd });
  await terminal.flush();
  terminal.press("\x1b[<0;10;10M");
  terminal.press("\x1b[<0;10;10m");
  terminal.press("\x1b[<not-a-mouse-event");
  terminal.press("\x1b");
  assert.equal(await approval, "deny");
  assert.equal(ui.draft(), "Retained");
});

test("wheel and page keys browse earlier output and End returns to the latest receipt", async (t) => {
  const terminal = new ScreenTerminal(100, 26);
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.message("assistant", Array.from({ length: 80 }, (_, index) => `History ${index}`).join("\n"));
  ui.tool("last", "Bash", "latest result", "done", { target: "git status" });
  ui.start();
  await terminal.flush();
  assert.match(terminal.text(), /latest result/);
  terminal.press("\x1b[<64;10;10M");
  await terminal.flush();
  assert.match(terminal.text(), /History · 3 lines below/);
  terminal.press("\x1b[5~");
  await terminal.flush();
  assert.doesNotMatch(terminal.text(), /latest result/);
  terminal.press("\x1b[F");
  await terminal.flush();
  assert.match(terminal.text(), /latest result/);
  assert.doesNotMatch(terminal.text(), /lines below/);
});

test("edits render real numbered changes and statistics, and wrap CJK within terminal cells", async (t) => {
  for (const width of [20, 40, 100]) {
    const terminal = new ScreenTerminal(width, 40);
    const ui = new TerminalUI(actions, terminal);
    t.after(() => ui.stop());
    ui.status(idle);
    ui.tool("edit", "Edit", "Successfully edited file", "done", { target: "src/中文.ts", diff: " 1 header\n-2 oldValue\n+2 newValue\n+3 中文内容需要正确换行且保留行号" });
    ui.start();
    await terminal.flush();
    assert.match(terminal.text(), /\+2 -1/);
    assert.equal(terminal.foreground("-2 oldValue"), 0xf28b91);
    assert.equal(terminal.foreground("+2 newValue"), 0x44d374);
    assert.doesNotMatch(terminal.text(), /Successfully edited file/);
    assert.match(terminal.text(), /\+3/);
  }
});

test("context uses model capacity, exposes exact tokens on click, and retains unknown usage", async (t) => {
  const terminal = new ScreenTerminal();
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status(idle);
  ui.setDraft("Still here");
  ui.start();
  await terminal.flush();
  assert.match(terminal.text(), /32k \/ 128k tokens · 25.0% used/);
  assert.doesNotMatch(terminal.text(), /Context|left/);
  terminal.click("32k / 128k");
  await terminal.flush();
  assert.match(terminal.text(), /Estimated used: 32,000 tokens/);
  assert.match(terminal.text(), /Context window: 128,000 tokens/);
  terminal.press("\x1b");
  await terminal.flush();
  ui.status({ ...idle, model: "fixture/small", context: { tokens: 32000, contextWindow: 64000, percent: 50 } });
  await terminal.flush();
  assert.match(terminal.text(), /32k \/ 64k tokens · 50.0% used/);
  ui.status({ ...idle, context: { tokens: null, contextWindow: 128000, percent: null } });
  await terminal.flush();
  assert.match(terminal.text(), /\? \/ 128k tokens · waiting for usage/);
  assert.doesNotMatch(terminal.text(), /0.0% used/);
  assert.equal(ui.draft(), "Still here");
});

test("context warns at high use and keeps the actual percentage when over capacity", async (t) => {
  const terminal = new ScreenTerminal();
  const ui = new TerminalUI(actions, terminal);
  t.after(() => ui.stop());
  ui.status({ ...idle, context: { tokens: 96000, contextWindow: 128000, percent: 75 } });
  ui.start();
  await terminal.flush();
  assert.equal(terminal.foreground("96k / 128k"), 0xc7b7a4);
  ui.status({ ...idle, context: { tokens: 130000, contextWindow: 128000, percent: 101.5625 } });
  await terminal.flush();
  assert.match(terminal.text(), /101.6% used/);
  assert.doesNotMatch(terminal.text(), /left/);
  assert.equal(terminal.foreground("130k / 128k"), 0xf28b91);
  ui.stop();
  assert.ok(terminal.output.endsWith("\x1b[?25h"));
  assert.ok(terminal.output.includes("\x1b[?1000l\x1b[?1006l"));
});
