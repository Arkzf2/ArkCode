import { spawn } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Container,
  CURSOR_MARKER,
  Editor,
  getNativeClipboard,
  Input,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  TuiMainScreen,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type Terminal,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Choice,
  ChoiceOptions,
  InputMode,
  SessionBrowserResult,
  SessionDetails,
  SessionItem,
  SessionState,
  Status,
  ToolDetails,
  UiActions,
  UserInterface,
} from "../app/types.js";
import { slashCommands } from "./commands.js";
import { permissionLabels } from "../permissions/policy.js";
import { mentionPrefix, WorkspaceAutocompleteProvider } from "./autocomplete.js";
import { diffStats, highlightCommand, renderDiff, toolColors } from "./tool-rendering.js";
import { contextDetails, contextReadout } from "./context-usage.js";

class SecretInput extends Input {
  override render(width: number): string[] {
    const rendered = super.render(width)[0] ?? "";
    const marker = rendered.indexOf(CURSOR_MARKER);
    const column = marker < 0 ? width : visibleWidth(rendered.slice(0, marker));
    const visible = "*".repeat(Math.min([...this.getValue()].length, Math.max(0, width - 1)));
    const cursor = Math.min(column, visible.length);
    const char = visible[cursor] ?? " ";
    const line = visible.slice(0, cursor) + (this.focused ? CURSOR_MARKER : "") + `\x1b[7m${char}\x1b[27m` + visible.slice(cursor + (cursor < visible.length ? 1 : 0));
    return [line + " ".repeat(Math.max(0, width - visible.length - (cursor === visible.length ? 1 : 0)))];
  }
}

type MessageKind = Parameters<UserInterface["message"]>[0];
type ToolState = Parameters<UserInterface["tool"]>[3];
type TranscriptEntry =
  | { kind: "message"; role: MessageKind; text: string; component: Markdown | Text }
  | { kind: "reasoning"; id: string; text: string; active: boolean; component: Text }
  | { kind: "tool"; id: string; name: string; target: string; exitCode?: number; diff?: string; text: string; state: ToolState; expanded: boolean | null };
type Panel = { transient?: boolean } & (
  | { kind: "choice"; component: Container; cancel: () => void; select: (index: number) => void }
  | { kind: "input"; component: Container; cancel: () => void }
  | { kind: "inspection"; component: Container; cancel: () => void; scroll: (delta: number) => void });
type BrowserFilter = "all" | "needs-you" | "working" | "ready" | "inactive";
interface BrowserState {
  items: SessionItem[];
  filter: BrowserFilter;
  grouping: "project" | "status";
  selectedId: string | null;
  scroll: number;
  query: string;
  searching: boolean;
  help: boolean;
  details: Map<string, SessionDetails>;
  loading: Set<string>;
  loadDetails?: (item: SessionItem) => Promise<SessionDetails>;
  resolve: (result: SessionBrowserResult | null) => void;
}
const browserFilters: BrowserFilter[] = ["all", "needs-you", "working", "ready", "inactive"];
const stateLabel: Record<SessionState, string> = {
  "needs-you": "Needs you", working: "Working", ready: "Ready", inactive: "Inactive", unconfirmed: "Unconfirmed",
};

export function sanitizeTerminalText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

const ansi = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const fg = (red: number, green: number, blue: number) => (text: string): string => `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
const bold = ansi(1);
const accent = fg(184, 178, 213);
const green = fg(146, 189, 160);
const yellow = fg(199, 183, 164);
const red = fg(219, 160, 160);
const dim = fg(145, 146, 154);
const faint = fg(105, 106, 114);
const userText = fg(209, 201, 181);
const neutral = fg(229, 231, 235);
const reasoningText = fg(180, 173, 191);
const directoryText = fg(167, 188, 192);
const permissionText = fg(203, 189, 152);
const branchText = fg(170, 192, 172);
const italic = ansi(3);

function themes(): { editor: EditorTheme; markdown: MarkdownTheme; select: SelectListTheme } {
  const muted = dim;
  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: bold,
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  };
  return {
    select,
    editor: { borderColor: accent, selectList: select },
    markdown: {
      heading: (text) => bold(neutral(text)),
      link: neutral,
      linkUrl: muted,
      code: neutral,
      codeBlock: neutral,
      codeBlockBorder: muted,
      quote: italic,
      quoteBorder: muted,
      hr: muted,
      listBullet: neutral,
      bold,
      italic,
      strikethrough: ansi(9),
      underline: ansi(4),
    },
  };
}

class ArkEditor extends Editor {
  private bottomBorder = "";
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width < 2) return accent("─".repeat(width));
    const edge = hiddenLineCount > 0 ? "↑" : "╭";
    return accent(`${edge}${"─".repeat(Math.max(0, width - 2))}╮`);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    const edge = hiddenLineCount > 0 ? "↓" : "╰";
    this.bottomBorder = accent(width < 2 ? "─".repeat(width) : `${edge}${"─".repeat(Math.max(0, width - 2))}╯`);
    return this.bottomBorder;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const bottom = lines.indexOf(this.bottomBorder);
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    if (bottom > 1 && padding > 0) {
      const prompt = padding >= 3 ? `│ ›${" ".repeat(padding - 3)}` : padding === 2 ? "│›" : "│";
      const continuation = `│${" ".repeat(padding - 1)}`;
      for (let index = 1; index < bottom; index++) {
        const line = lines[index];
        if (line !== undefined) lines[index] = `${accent(index === 1 ? prompt : continuation)}${line.slice(padding, -1)}${accent("│")}`;
      }
      if (!this.getText()) {
        const available = Math.max(1, width - padding - 1);
        const placeholder = truncateToWidth("Ask ArkCode to do anything", available, "");
        lines[1] = `${accent(prompt)}${this.focused ? CURSOR_MARKER : ""}${dim(placeholder)}${" ".repeat(Math.max(0, available - visibleWidth(placeholder)))}${accent("│")}`;
      }
    }
    return lines;
  }
}

class RenderComponent implements Component {
  constructor(private readonly draw: (width: number) => string[]) {}
  render(width: number): string[] { return this.draw(width); }
  invalidate(): void {}
}

async function clipboardCommand(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => resolve(false));
    child.stdin.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = getNativeClipboard();
    if (clipboard?.setText) {
      await clipboard.setText(text);
      return true;
    }
  } catch {}
  if (process.platform === "win32") {
    return clipboardCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::InputEncoding = [Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())"], text);
  }
  if (process.platform === "darwin") return clipboardCommand("pbcopy", [], text);
  if (await clipboardCommand("wl-copy", [], text)) return true;
  return clipboardCommand("xclip", ["-selection", "clipboard"], text);
}

export class TerminalUI implements UserInterface {
  private readonly tui: TuiMainScreen;
  private readonly theme = themes();
  private editor: Editor;
  private readonly entries: TranscriptEntry[] = [];
  private readonly tools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
  private readonly promptHistory: string[] = [];
  private activeAssistant: Extract<TranscriptEntry, { kind: "message" }> | null = null;
  private currentStatus: Status | null = null;
  private panel: Panel | null = null;
  private browser: BrowserState | null = null;
  private expanded = false;
  private readonly toolHitRows = new Map<number, { id: string; end: number }>();
  private mouseDown: { id: string; row: number; column: number } | null = null;
  private scrollOffset = 0;
  private transcriptRows = 0;
  private contextRows = 0;
  private visibleStart = 0;
  private pasting = false;
  private lastKey: { data: string; at: number } | null = null;
  private lastEscape = 0;
  private started = false;
  private externalEditor = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly actions: UiActions, private readonly terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiMainScreen(terminal, true);
    this.tui.setClearOnShrink(true);
    this.editor = this.createEditor();
    this.tui.addInputListener((data) => this.handleKeys(data));
    this.rebuild();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.terminal.clearScreen();
    this.tui.start();
    this.mouseReporting(true);
    let ticks = 0;
    this.timer = setInterval(() => {
      ticks++;
      if (!this.currentStatus || this.currentStatus.initializing || (ticks % 10 === 0 && this.currentStatus.state.kind !== "idle")) this.tui.requestRender();
    }, 100);
    this.timer.unref();
  }

  status(value: Status): void {
    const oldCwd = this.currentStatus?.cwd;
    const wasInitializing = !this.currentStatus || this.currentStatus.initializing === true;
    this.currentStatus = value;
    if (value.state.kind === "idle") {
      for (const entry of this.entries) if (entry.kind === "reasoning") entry.active = false;
    }
    if (oldCwd !== value.cwd) this.editor.setAutocompleteProvider(new WorkspaceAutocompleteProvider(value.cwd, () => this.currentStatus?.mcpServers ?? []));
    if (wasInitializing !== (value.initializing === true)) this.rebuild();
    this.render();
  }

  message(kind: MessageKind, text: string): void {
    const cleaned = sanitizeTerminalText(text);
    this.entries.push({ kind: "message", role: kind, text: cleaned, component: this.messageComponent(kind, cleaned) });
    this.render();
  }

  assistantDelta(text: string): void {
    for (const entry of this.entries) if (entry.kind === "reasoning") entry.active = false;
    if (!this.activeAssistant) {
      this.activeAssistant = { kind: "message", role: "assistant", text: "", component: this.messageComponent("assistant", "") };
      this.entries.push(this.activeAssistant);
    }
    this.activeAssistant.text += text;
    this.activeAssistant.component.setText(sanitizeTerminalText(this.activeAssistant.text));
    this.render();
  }

  assistantEnd(text: string): void {
    if (this.activeAssistant) {
      this.activeAssistant.text = text;
      this.activeAssistant.component.setText(sanitizeTerminalText(text));
      this.activeAssistant = null;
      this.render();
    } else if (text) this.message("assistant", text);
  }

  reasoning(id: string, text: string, active: boolean): void {
    const existing = this.entries.find((entry) => entry.kind === "reasoning" && entry.id === id);
    if (existing?.kind === "reasoning") {
      existing.text = sanitizeTerminalText(text);
      existing.active = active;
      existing.component.setText(existing.text);
    } else {
      const cleaned = sanitizeTerminalText(text);
      this.entries.push({ kind: "reasoning", id, text: cleaned, active, component: new Text(cleaned, 0, 1) });
    }
    this.render();
  }

  tool(id: string, name: string, text: string, state: ToolState, details?: ToolDetails): void {
    let entry = this.tools.get(id);
    if (!entry) {
      entry = { kind: "tool", id, name, target: "", text, state, expanded: null };
      this.tools.set(id, entry);
      this.entries.push(entry);
    }
    entry.name = sanitizeTerminalText(name);
    entry.text = sanitizeTerminalText(text);
    entry.state = state;
    if (details?.target !== undefined) entry.target = sanitizeTerminalText(details.target);
    if (details?.exitCode !== undefined) entry.exitCode = details.exitCode;
    if (details?.diff !== undefined) entry.diff = sanitizeTerminalText(details.diff);
    this.render();
  }

  choose(title: string, choices: Choice[], options: ChoiceOptions = {}): Promise<string | null> {
    this.dismiss();
    if (!choices.length) {
      this.message("info", `${title}\nNo choices available.`);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const list = new SelectList(choices.map((choice) => ({
        value: choice.value,
        label: sanitizeTerminalText(choice.label),
        ...(choice.description || choice.status ? { description: [
          ...(choice.status ? [(choice.status.tone === "positive" ? green : choice.status.tone === "muted" ? faint : dim)(sanitizeTerminalText(choice.status.text))] : []),
          ...(choice.description ? [dim(sanitizeTerminalText(choice.description))] : []),
        ].join(dim(" | ")) } : {}),
      })), 8, this.theme.select);
      const selected = choices.findIndex((choice) => choice.value === options.initialValue);
      if (selected >= 0) list.setSelectedIndex(selected);
      const component = new Container();
      component.addChild(new Text(bold(sanitizeTerminalText(title)), 2, 1));
      if (options.notice) component.addChild(new Text(dim(sanitizeTerminalText(options.notice)), 2, 0));
      component.addChild(list);
      component.addChild(new Text(dim(options.hint ?? "↑/↓ select · Enter confirm · Esc cancel"), 2, 1));
      const finish = (value: string | null): void => {
        this.closePanel();
        resolve(value);
      };
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
      this.panel = {
        kind: "choice",
        transient: options.transient,
        component,
        cancel: () => finish(null),
        select: (index) => {
          const choice = choices[index];
          if (choice) finish(choice.value);
        },
      };
      this.rebuild();
      this.tui.setFocus(list);
      this.render();
    });
  }

  inspect(title: string, text: string): Promise<void> {
    this.dismiss();
    return new Promise((resolve) => {
      let offset = 0;
      const component = new Container();
      component.addChild(new RenderComponent((width) => {
        const inner = Math.max(1, width - 4);
        const lines = wrapTextWithAnsi(sanitizeTerminalText(text), inner);
        const page = Math.max(1, this.terminal.rows - 9);
        offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - page)));
        return ["", ...wrapTextWithAnsi(bold(sanitizeTerminalText(title)), inner), "",
          ...lines.slice(offset, offset + page), "",
          dim(`↑/↓ scroll · PgUp/PgDn page · Esc/Ctrl+C back${lines.length > page ? ` · ${offset + 1}-${Math.min(offset + page, lines.length)}/${lines.length}` : ""}`),
        ].flatMap((line) => wrapTextWithAnsi(line, inner).map((row) => `  ${row}`));
      }));
      this.panel = { kind: "inspection", transient: true, component,
        cancel: () => { this.closePanel(); resolve(); },
        scroll: (delta) => { offset += delta; this.render(); },
      };
      this.rebuild();
      this.render();
    });
  }

  browseSessions(items: SessionItem[], loadDetails?: (item: SessionItem) => Promise<SessionDetails>): Promise<SessionBrowserResult | null> {
    if (this.browser) this.finishBrowser(null);
    return new Promise((resolve) => {
      this.browser = {
        items, filter: "all", grouping: "project", selectedId: items.find((item) => item.current)?.id ?? items[0]?.id ?? null,
        scroll: 0, query: "", searching: false, help: false, details: new Map(), loading: new Set(), loadDetails, resolve,
      };
      this.rebuild();
      this.render();
    });
  }

  input(title: string, initial = ""): Promise<string | null> {
    this.dismiss();
    return new Promise((resolve) => {
      const input = new Input();
      input.setValue(initial);
      const component = new Container();
      component.addChild(new Text(bold(sanitizeTerminalText(title)), 2, 1));
      component.addChild(input);
      component.addChild(new Text(dim("Enter confirm · Esc cancel"), 2, 1));
      const finish = (value: string | null): void => {
        this.closePanel();
        resolve(value);
      };
      input.onSubmit = (value) => finish(value);
      input.onEscape = () => finish(null);
      this.panel = { kind: "input", component, cancel: () => finish(null) };
      this.rebuild();
      this.tui.setFocus(input);
      this.render();
    });
  }

  secret(title: string): Promise<string | null> {
    this.dismiss();
    return new Promise((resolve) => {
      const input = new SecretInput();
      const component = new Container();
      component.addChild(new Text(bold(sanitizeTerminalText(title)), 2, 1));
      component.addChild(input);
      component.addChild(new Text(dim("Enter confirm · Esc cancel"), 2, 1));
      const finish = (value: string | null): void => { this.closePanel(); resolve(value); };
      input.onSubmit = (value) => finish(value);
      input.onEscape = () => finish(null);
      this.panel = { kind: "input", component, cancel: () => finish(null) };
      this.rebuild();
      this.tui.setFocus(input);
      this.render();
    });
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const result = await this.choose(
      `Allow this tool request?\nTool: ${request.tool}\nRequest: ${request.description}\nDirectory: ${request.cwd}`,
      [
        { value: "once", label: "1. Yes, proceed" },
        { value: "session", label: request.invocation?.kind === "mcp" && request.invocation.destructive
          ? "2. Yes, proceed; this tool still requires approval next time"
          : "2. Yes, and don't ask again for this exact request in this session" },
        { value: "deny", label: "3. No, continue without running it" },
      ],
    );
    if (result === "once" || result === "session") return result;
    return "deny";
  }

  dismiss(): void { this.panel?.cancel(); if (this.browser) this.finishBrowser(null); }
  draft(): string { return this.editor.getExpandedText(); }
  setDraft(text: string): void {
    this.lastKey = null;
    this.editor.setText(sanitizeTerminalText(text));
    this.render();
  }

  clear(): void {
    this.dismiss();
    this.entries.length = 0;
    this.tools.clear();
    this.activeAssistant = null;
    this.visibleStart = 0;
    this.scrollOffset = 0;
    this.transcriptRows = 0;
    this.toolHitRows.clear();
    this.mouseDown = null;
    this.render();
  }

  copy(text: string): Promise<boolean> { return copyText(text); }

  stop(): void {
    this.dismiss();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.started) { this.mouseReporting(false); this.tui.stop(); }
    this.started = false;
  }

  private createEditor(): Editor {
    const editor = new ArkEditor(this.tui, this.theme.editor, { paddingX: 4, autocompleteMaxVisible: 6 });
    editor.setAutocompleteProvider(new WorkspaceAutocompleteProvider(this.currentStatus?.cwd ?? process.cwd(), () => this.currentStatus?.mcpServers ?? []));
    editor.onSubmit = (value) => this.submit(value, this.busy() ? "steer" : "prompt");
    return editor;
  }

  private messageComponent(kind: MessageKind, text: string): Markdown | Text {
    if (kind === "assistant") return new Markdown(text, 0, 1, this.theme.markdown);
    return new Text(text, 0, kind === "user" ? 0 : 1);
  }

  private toolLines(entry: Extract<TranscriptEntry, { kind: "tool" }>, width: number, startRow: number): string[] {
    const action = this.toolAction(entry.name, entry.state);
    const shell = entry.name.toLowerCase() === "bash" || entry.name === "shell";
    const marker = entry.state === "error" ? toolColors.error("●") : toolColors.success("●");
    const target = (shell ? highlightCommand : toolColors.path)(entry.target || entry.name);
    const result = entry.exitCode === undefined ? "" : `  ${entry.exitCode === 0 ? dim(`exit ${entry.exitCode}`) : red(`exit ${entry.exitCode}`)}`;
    const diff = entry.state === "error" ? undefined : entry.diff;
    const counts = diff ? diffStats(diff) : null;
    const changes = counts ? `  ${toolColors.success(`+${counts.added}`)} ${toolColors.error(`-${counts.removed}`)}` : "";
    const heading = wrapTextWithAnsi(`${neutral(action)} ${target}${changes}${result}`, Math.max(1, width - 4));
    const rows = heading.map((line, index) => `  ${index === 0 ? marker : " "} ${line}`);
    const outputWidth = Math.max(1, width - 6);
    const output = entry.text.replace(/\n$/, "");
    const wrapped = diff ? renderDiff(diff, outputWidth) : output ? output.split("\n").flatMap((line) => wrapTextWithAnsi(toolColors.output(line), outputWidth)) : [];
    const limit = diff ? 8 : 3;
    const expanded = entry.expanded ?? this.expanded;
    const preview = expanded ? wrapped : wrapped.slice(0, limit);
    rows.push(...preview.map((line, index) => `    ${index === 0 ? dim("└") : " "} ${line}`));
    if (wrapped.length > limit) {
      const label = expanded ? "Show less (click to collapse)" : `+${wrapped.length - limit} lines (click / Ctrl+T to expand)`;
      for (const line of wrapTextWithAnsi(dim(label), Math.max(1, width - 4))) {
        this.toolHitRows.set(startRow + rows.length, { id: entry.id, end: 4 + visibleWidth(line) });
        rows.push(`    ${line}`);
      }
      if (expanded) this.toolHitRows.set(startRow, { id: entry.id, end: width });
    }
    return [...rows, ""];
  }

  private toolAction(name: string, state: ToolState): string {
    name = name.toLowerCase();
    if (state === "error") return "Failed";
    if (["read", "glob", "find", "grep", "ls"].includes(name)) return state === "running" ? "Exploring" : "Explored";
    if (name === "edit") return state === "running" ? "Editing" : "Edited";
    if (name === "write") return state === "running" ? "Writing" : "Wrote";
    if (name === "bash" || name === "shell") return state === "running" ? "Running" : "Ran";
    if (name.startsWith("mcp__")) return state === "running" ? "Calling MCP" : "Called MCP";
    return state === "running" ? "Working" : "Worked";
  }

  private rebuild(): void {
    this.tui.clear();
    if (this.browser) {
      this.tui.addChild(new RenderComponent((width) => this.browserLines(width)));
      return;
    }
    if (!this.panel && (!this.currentStatus || this.currentStatus.initializing)) {
      this.tui.addChild(new RenderComponent((width) => {
        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        const frame = frames[Math.floor(Date.now() / 100) % frames.length];
        return [truncateToWidth(dim(`  ${frame} Initializing...`), width, "")];
      }));
      return;
    }
    if (this.panel?.transient) {
      this.tui.addChild(new RenderComponent((width) => this.headerLines(width)));
      this.tui.addChild(this.panel.component);
      return;
    }
    this.tui.addChild(new RenderComponent((width) => this.headerLines(width)));
    this.tui.addChild(new RenderComponent((width) => {
      const lines: string[] = [];
      this.toolHitRows.clear();
      const entries = this.entries.slice(this.visibleStart);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.kind === "tool") {
          lines.push(...this.toolLines(entry, width, this.headerLines(width).length + lines.length));
          continue;
        }
        if (entry.kind === "reasoning" && !this.expanded) continue;
        const user = entry.kind === "message" && entry.role === "user";
        const rendered = entry.component.render(Math.max(1, width - (user ? 6 : 4)));
        if (entry.kind === "message" && entry.role === "user") {
          lines.push("", ...rendered.map((line, offset) => {
            const body = truncateToWidth(line, Math.max(1, width - 6), "");
            return `  \x1b[48;2;8;8;10m${bold(userText(`▎ ${offset === 0 ? "›" : " "} ${body}${" ".repeat(Math.max(0, width - 6 - visibleWidth(body)))}`))}\x1b[0m`;
          }), "");
          continue;
        }
        let first = true;
        for (const line of rendered) {
          if (!stripTerminalSequences(line).trim()) {
            if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
            continue;
          }
          const color = entry.kind === "reasoning" ? (value: string) => italic(dim(value)) : entry.role === "error" ? red : neutral;
          lines.push(`  ${first ? dim("●") : " "} ${color(line)}`);
          first = false;
        }
      }
      if (this.scrollOffset > 0) this.scrollOffset += Math.max(0, lines.length - this.transcriptRows);
      this.transcriptRows = lines.length;
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, lines.length - 1));
      const end = lines.length - this.scrollOffset;
      const headerHeight = this.headerLines(width).length;
      for (const row of this.toolHitRows.keys()) if (row >= headerHeight + end) this.toolHitRows.delete(row);
      return lines.slice(0, end);
    }));
    this.tui.addChild(new RenderComponent((width) => this.activity(width)));
    if (this.panel) this.tui.addChild(this.panel.component);
    else this.tui.addChild(this.editor);
    this.tui.addChild(new RenderComponent((width) => this.statusLines(width)));
    if (!this.panel && this.currentStatus && !this.currentStatus.initializing) this.tui.setFocus(this.editor);
  }

  private browserItems(): SessionItem[] {
    const browser = this.browser;
    if (!browser) return [];
    const query = browser.query.trim().toLocaleLowerCase();
    return browser.items.filter((item) =>
      (browser.filter === "all" || (browser.filter === "inactive" ? item.state === "inactive" || item.state === "unconfirmed" : item.state === browser.filter)) &&
      (!query || `${item.title} ${item.cwd} ${item.preview}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        const groupA = browser.grouping === "project" ? a.cwd : stateLabel[a.state];
        const groupB = browser.grouping === "project" ? b.cwd : stateLabel[b.state];
        return groupA.localeCompare(groupB) || b.modified - a.modified;
      });
  }

  private browserLines(width: number): string[] {
    const browser = this.browser;
    if (!browser) return [];
    const columns = Math.max(1, width);
    const inner = Math.max(1, columns - 4);
    const fit = (value: string, size: number) => {
      const text = truncateToWidth(sanitizeTerminalText(value).replace(/\n/g, " "), Math.max(1, size), "…");
      return text + " ".repeat(Math.max(0, size - visibleWidth(text)));
    };
    const flow = (parts: string[], size: number): string[] => {
      const lines: string[] = [];
      let line = "";
      for (const part of parts) {
        const candidate = line ? `${line}  ${part}` : part;
        if (line && visibleWidth(candidate) > size) { lines.push(line); line = part; }
        else line = candidate;
      }
      if (line) lines.push(line);
      return lines;
    };
    const content = this.browserItems();
    if (!content.some((item) => item.id === browser.selectedId)) browser.selectedId = content[0]?.id ?? null;
    const selected = content.find((item) => item.id === browser.selectedId);
    if (selected) this.loadBrowserDetails(selected);
    const counts = browserFilters.map((filter) => {
      const count = filter === "all" ? browser.items.length : browser.items.filter((item) => filter === "inactive" ? item.state === "inactive" || item.state === "unconfirmed" : item.state === filter).length;
      const label = `${filter === "all" ? "All" : stateLabel[filter]} ${count}`;
      return browser.filter === filter ? bold(neutral(`[${label}]`)) : dim(label);
    });
    const narrow = columns < 60;
    const title = `${narrow ? "Sessions" : "Session command center"}  ${dim(`Group: ${browser.grouping === "project" ? "Project" : "Status"}  g`)}`;
    const rows = [
      `  ${truncateToWidth(title, inner, "")}`,
      ...flow(counts, inner).map((line) => `  ${line}`),
      `  ${dim("─".repeat(inner))}`,
    ];
    const wide = columns >= 90;
    const detailsWidth = wide ? Math.min(40, Math.max(30, Math.floor(columns * 0.34))) : 0;
    const listWidth = wide ? columns - detailsWidth - 3 : columns;
    const footer = browser.searching
      ? [`  /${browser.query}${CURSOR_MARKER}`]
      : browser.query ? [`  ${dim(`Search: ${browser.query}`)}`]
        : flow(["? help", "Esc back", "↑/↓ move", "Enter open", "n new", "/ search"].map((part) => dim(part)), inner).map((line) => `  ${line}`);
    const bodyHeight = Math.max(1, this.terminal.rows - rows.length - footer.length);
    const listRows: string[] = [];
    let selectedRow = -1;
    if (browser.help) {
      listRows.push("  Navigate", "  ↑/↓ move   PgUp/PgDn page   Enter open   Esc back", "", "  Sessions", "  n new in selected project", "", "  View", "  Tab/Shift+Tab filter   g group   / search   ? help");
    } else {
      listRows.push(narrow ? `  ${dim("Sessions")}` : `  ${dim(fit("Sessions", Math.max(1, listWidth - 20)))}${dim("Status     Updated")}`);
      let previousGroup = "";
      for (const item of content) {
        const group = browser.grouping === "project" ? item.cwd : stateLabel[item.state];
        if (group !== previousGroup) { listRows.push(`  ${dim(fit(group, listWidth - 4))}`); previousGroup = group; }
        const status = stateLabel[item.state];
        const age = item.current ? "now" : this.sessionAge(item.modified);
        const labelWidth = Math.max(4, listWidth - (narrow ? 5 : 25));
        const line = narrow
          ? `  ${item.current ? accent("●") : dim("○")} ${fit(item.title, labelWidth)}`
          : `  ${item.current ? accent("●") : dim("○")} ${fit(item.title, labelWidth)} ${fit(status, 11)} ${fit(age, 7)}`;
        if (item.id === browser.selectedId) selectedRow = listRows.length;
        listRows.push(item.id === browser.selectedId ? `\x1b[1;38;2;231;228;237;48;2;78;65;108m${stripTerminalSequences(line)}\x1b[0m` : line);
      }
      if (!content.length) listRows.push(`  ${dim(browser.query ? "No matching sessions" : "No sessions in this filter")}`);
    }
    if (selectedRow >= 0) browser.scroll = Math.max(0, Math.min(browser.scroll, selectedRow));
    if (selectedRow >= browser.scroll + bodyHeight) browser.scroll = selectedRow - bodyHeight + 1;
    const visible = listRows.slice(browser.scroll, browser.scroll + bodyHeight);
    const details: string[] = [];
    if (wide) {
      details.push(bold(neutral("Session details")), "");
      if (selected) {
        const detail = browser.details.get(selected.id);
        details.push(...wrapTextWithAnsi(neutral(selected.title), detailsWidth - 3).slice(0, 3));
        details.push(accent(stateLabel[selected.state]), "", dim("Last message"));
        const latest = detail?.lastMessage ?? (browser.loading.has(selected.id) ? "Loading..." : browser.loadDetails ? "No message preview" : selected.preview);
        details.push(...wrapTextWithAnsi(neutral(sanitizeTerminalText(latest)), detailsWidth - 3).slice(0, 7));
        details.push("", dim("Project"));
        details.push(...wrapTextWithAnsi(directoryText(selected.cwd), detailsWidth - 3).slice(0, 3));
        if (detail?.model || selected.model) details.push("", dim("Model"), neutral(detail?.model ?? selected.model ?? ""));
        if (detail?.prompt) details.push("", dim("Prompt"), ...wrapTextWithAnsi(neutral(sanitizeTerminalText(detail.prompt)), detailsWidth - 3).slice(0, 4));
        if (selected.state === "unconfirmed") details.push("", red("Previous run is unconfirmed"));
      }
    }
    for (let index = 0; index < bodyHeight; index++) {
      const left = visible[index] ?? "";
      if (!wide) rows.push(truncateToWidth(left, columns, ""));
      else rows.push(`${left}${" ".repeat(Math.max(0, listWidth - 1 - visibleWidth(left)))} ${dim("│")} ${truncateToWidth(details[index] ?? "", detailsWidth - 2, "")}`);
    }
    rows.push(...footer);
    return rows.map((row) => truncateToWidth(row, columns, ""));
  }

  private loadBrowserDetails(item: SessionItem): void {
    const browser = this.browser;
    if (!browser || !browser.loadDetails || browser.loading.has(item.id) || browser.details.has(item.id)) return;
    browser.loading.add(item.id);
    void browser.loadDetails(item).then((details) => { if (this.browser === browser) browser.details.set(item.id, details); })
      .catch(() => { if (this.browser === browser) browser.details.set(item.id, {}); })
      .finally(() => { if (this.browser === browser) { browser.loading.delete(item.id); this.render(); } });
  }

  private sessionAge(modified: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - modified) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  private finishBrowser(value: SessionBrowserResult | null): void {
    const browser = this.browser;
    if (!browser) return;
    this.browser = null;
    this.rebuild();
    this.render();
    browser.resolve(value);
  }

  private browserKey(data: string): TuiInputListenerResult {
    const browser = this.browser;
    if (!browser) return { consume: true };
    if (browser.searching) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) browser.searching = false;
      else if (matchesKey(data, "backspace")) browser.query = browser.query.slice(0, -1);
      else if (data.length === 1 && data >= " ") browser.query += data;
      browser.scroll = 0;
      this.render();
      return { consume: true };
    }
    if (browser.help) {
      browser.help = false;
      this.render();
      return { consume: true };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.finishBrowser(null);
    else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const delta = matchesKey(data, "tab") ? 1 : -1;
      browser.filter = browserFilters[(browserFilters.indexOf(browser.filter) + delta + browserFilters.length) % browserFilters.length]!;
      browser.scroll = 0;
    } else if (data === "g") { browser.grouping = browser.grouping === "project" ? "status" : "project"; browser.scroll = 0; }
    else if (data === "/") { browser.searching = true; browser.query = ""; browser.scroll = 0; }
    else if (data === "?") browser.help = true;
    else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const items = this.browserItems();
      const index = items.findIndex((item) => item.id === browser.selectedId);
      const page = Math.max(1, this.terminal.rows - 8);
      const delta = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : matchesKey(data, "pageUp") ? -page : page;
      browser.selectedId = items[Math.max(0, Math.min(items.length - 1, index + delta))]?.id ?? null;
    } else if (matchesKey(data, "enter")) {
      const items = this.browserItems();
      const item = items.find((candidate) => candidate.id === browser.selectedId) ?? items[0];
      if (item) this.finishBrowser({ kind: "open", item });
    } else if (data === "n") {
      const items = this.browserItems();
      const cwd = (items.find((item) => item.id === browser.selectedId) ?? items[0])?.cwd ?? this.currentStatus?.cwd;
      if (cwd) this.finishBrowser({ kind: "new", cwd });
    }
    this.render();
    return { consume: true };
  }

  private activity(width: number): string[] {
    const status = this.currentStatus;
    if (!status || status.initializing) return [];
    const rows: string[] = [];
    if (this.scrollOffset > 0) rows.push(`↑ History · ${this.scrollOffset} lines below · PgDn or End to return`);
    if (status.state.kind !== "idle") {
      const elapsed = Math.floor((Date.now() - status.state.startedAt) / 1000);
      const currentTool = [...this.tools.values()].findLast((tool) => tool.state === "running");
      const thinking = this.entries.some((entry) => entry.kind === "reasoning" && entry.active);
      const label = status.state.kind === "awaiting-approval" ? "Approval needed" :
        status.state.kind === "stopping" ? "Stopping" : currentTool ? `${this.toolAction(currentTool.name, "running")} ${currentTool.target || currentTool.name}` : this.activeAssistant ? "Writing response" : thinking ? "Thinking" : "Working";
      rows.push(`${dim("●")} ${label}  ${dim(`(${elapsed}s)`)}`);
    } else if (status.state.outcome === "interrupted") rows.push("Interrupted");
    else if (status.state.outcome === "failed") rows.push("Failed");
    else rows.push(status.state.outcome === "completed" ? "Completed" : "Ready");
    if (status.queued.length) rows.push(...status.queued.map((item) => `Queued · ${sanitizeTerminalText(item)}`));
    return rows.flatMap((row) => wrapTextWithAnsi(dim(row), Math.max(1, width - 4)).map((line) => `  ${line}`));
  }

  private statusLines(width: number): string[] {
    const status = this.currentStatus;
    if (!status || status.initializing) return [];
    const permission = permissionLabels[status.permission] + (status.executionBlocked ? " · Execution blocked" : "");
    const fields = [
      accent(sanitizeTerminalText(status.model.slice(status.model.indexOf("/") + 1))),
      reasoningText(sanitizeTerminalText(status.thinking)),
      directoryText(sanitizeTerminalText(status.cwd)),
      permissionText(permission),
      branchText(sanitizeTerminalText(status.branch || "No Git")),
    ];
    const joined = fields.join("  ");
    const contentWidth = Math.max(1, width - 4);
    const context = contextReadout(status.context, contentWidth);
    const paint = context.tone === "critical" ? toolColors.error : context.tone === "warning" ? yellow : dim;
    const contextLines = wrapTextWithAnsi(paint(context.text), contentWidth);
    this.contextRows = contextLines.length;
    return [
      ...wrapTextWithAnsi(joined, contentWidth).map((row) => `  ${row}`),
      ...contextLines.map((row) => `  ${" ".repeat(Math.max(0, contentWidth - visibleWidth(row)))}${row}`),
    ];
  }

  private headerLines(width: number): string[] {
    const status = this.currentStatus;
    const title = `${bold(neutral(">_ ArkCode"))}${status?.viewer ? ` ${dim("Saved session")}` : ""}`;
    return [`  ${truncateToWidth(title, Math.max(1, width - 4), "")}`, `  ${fg(25, 25, 30)("─".repeat(Math.max(1, width - 4)))}`, ""];
  }

  private closePanel(): void {
    this.panel = null;
    this.rebuild();
    this.render();
  }

  private busy(): boolean {
    return this.currentStatus !== null && this.currentStatus.state.kind !== "idle";
  }

  private completingMention(): boolean {
    const { line, col } = this.editor.getCursor();
    return mentionPrefix((this.editor.getLines()[line] ?? "").slice(0, col)) !== null;
  }

  private submit(value: string, mode: InputMode): void {
    if (!value.trim() || !this.currentStatus || this.currentStatus.initializing) return;
    if (!/^\/(?:mcp|tool-mode|web-search)(?:\s|$)/i.test(value.trim())) {
      this.editor.addToHistory(value);
      this.promptHistory.push(value);
    }
    this.editor.setText("");
    this.run(async () => {
      try { await this.actions.submit(value, mode); }
      catch (error) { if (!this.draft()) this.setDraft(value); throw error; }
    });
  }

  private run(action: () => Promise<void>): void {
    void action().catch((error: unknown) => this.message("error", error instanceof Error ? error.message : String(error)));
  }

  private handleKeys(data: string): TuiInputListenerResult {
    if (!this.pasting && !data.includes("\x1b[200~")) {
      if (data.startsWith("\x1b[<")) return this.handleMouse(data);
      if (data.startsWith("\x1b[M")) return { consume: true };
    }
    if (isKeyRelease(data)) return { consume: true };
    if (!this.panel && !this.browser && (!this.currentStatus || this.currentStatus.initializing)) {
      if (matchesKey(data, "ctrl+c")) this.run(() => this.actions.exit());
      return { consume: true };
    }
    if (this.pasting || data.includes("\x1b[200~")) {
      this.pasting = !data.includes("\x1b[201~");
      return this.browser || this.panel?.kind === "choice" || this.panel?.kind === "inspection" || (!this.panel && this.currentStatus?.state.kind === "stopping") ? { consume: true } : undefined;
    }
    if (this.browser) return this.browserKey(data);
    const now = Date.now();
    if (!matchesKey(data, "escape")) this.lastEscape = 0;
    const repeated = isKeyRepeat(data) || (this.lastKey?.data === data && now - this.lastKey.at < 300);
    this.lastKey = { data, at: now };
    const decisionKey = matchesKey(data, "enter") || /^[1-9]$/.test(data);
    if (repeated && (matchesKey(data, "enter") || (this.panel?.kind === "choice" && decisionKey))) return { consume: true };
    if (this.panel) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.dismiss();
        return { consume: true };
      }
      if (this.panel.kind === "inspection") {
        if (matchesKey(data, "up")) this.panel.scroll(-1);
        else if (matchesKey(data, "down")) this.panel.scroll(1);
        else if (matchesKey(data, "pageUp")) this.panel.scroll(-Math.max(1, this.terminal.rows - 9));
        else if (matchesKey(data, "pageDown")) this.panel.scroll(Math.max(1, this.terminal.rows - 9));
        else if (matchesKey(data, "enter")) this.dismiss();
        return { consume: true };
      }
      if (/^[1-9]$/.test(data) && this.panel.kind === "choice") {
        this.panel.select(Number(data) - 1);
        return { consume: true };
      }
      return undefined;
    }
    if (this.currentStatus?.state.kind === "stopping" && !matchesKey(data, "ctrl+c") && !matchesKey(data, "ctrl+t") && !matchesKey(data, "ctrl+o") && !matchesKey(data, "pageUp") && !matchesKey(data, "pageDown") && !matchesKey(data, "end")) return { consume: true };
    if (matchesKey(data, "ctrl+c")) {
      this.run(() => this.busy() ? this.actions.interrupt() : this.actions.exit());
    } else if (matchesKey(data, "ctrl+d") && !this.draft()) {
      this.run(() => this.actions.exit());
    } else if (matchesKey(data, "escape")) {
      if (this.editor.isShowingAutocomplete()) return undefined;
      if (this.expanded || [...this.tools.values()].some((entry) => entry.expanded)) {
        this.expanded = false;
        for (const entry of this.tools.values()) entry.expanded = null;
        this.render();
      } else if (this.busy()) this.run(() => this.actions.interrupt());
      else if (!this.draft()) {
        if (now - this.lastEscape < 500) { this.lastEscape = 0; this.run(() => this.actions.editPrevious()); }
        else this.lastEscape = now;
      }
    } else if (matchesKey(data, "tab") && this.busy() && this.draft().trim() && !this.editor.isShowingAutocomplete() && !this.completingMention()) {
      this.submit(this.draft(), "follow-up");
    } else if (matchesKey(data, "shift+left")) {
      this.run(() => this.actions.editPrevious());
    } else if (matchesKey(data, "left") && this.currentStatus?.state.kind === "idle" && this.editor.focused && !this.draft() && !this.editor.isShowingAutocomplete()) {
      this.run(() => this.actions.browseSessions());
    } else if (matchesKey(data, "ctrl+t")) {
      this.expanded = !this.expanded;
      for (const entry of this.tools.values()) entry.expanded = null;
      if (this.expanded) this.visibleStart = 0;
      this.render();
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.scrollTranscript((matchesKey(data, "pageUp") ? 1 : -1) * Math.max(1, this.terminal.rows - 10));
    } else if (matchesKey(data, "end") && this.scrollOffset > 0) {
      this.scrollOffset = 0;
      this.render();
    } else if (matchesKey(data, "ctrl+o")) {
      this.run(() => this.actions.submit("/copy", "prompt"));
    } else if (matchesKey(data, "ctrl+l")) {
      this.visibleStart = this.entries.length;
      this.scrollOffset = 0;
      this.tui.terminal.clearScreen();
      this.tui.requestRender(true);
    } else if (matchesKey(data, "ctrl+r")) {
      this.run(() => this.searchHistory());
    } else if (matchesKey(data, "ctrl+g")) {
      this.run(() => this.editExternally());
    } else if (data === "?" && !this.draft()) {
      this.message("info", "Enter send / steer    Tab queue follow-up    Left sessions    Ctrl+C interrupt / exit\nClick +N lines to expand / Show less to collapse    Ctrl+T all details\nWheel / PgUp / PgDn scroll    End latest    Shift+drag select text\nClick context for token details    Ctrl+O copy    Ctrl+R history    Ctrl+G editor\nCtrl+L clear view    Shift+Enter newline    Esc cancel    /help commands");
    } else return undefined;
    return { consume: true };
  }

  private async searchHistory(): Promise<void> {
    const query = await this.input("Search prompt history");
    if (query === null) return;
    const matches = [...new Set(this.promptHistory)].reverse().filter((prompt) => prompt.toLowerCase().includes(query.toLowerCase()));
    const result = await this.choose("Prompt history", matches.map((prompt) => ({ value: prompt, label: prompt.replace(/\n/g, " ") })));
    if (result !== null) this.setDraft(result);
  }

  private async editExternally(): Promise<void> {
    if (this.externalEditor) return;
    this.externalEditor = true;
    const draft = this.draft();
    let directory: string | null = null;
    try {
      directory = await mkdtemp(join(tmpdir(), "arkcode-editor-"));
      const file = join(directory, "prompt.md");
      await writeFile(file, draft, "utf8");
      const command = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad.exe" : "vi");
      this.mouseReporting(false);
      this.tui.stop();
      this.started = false;
      const code = await new Promise<number | null>((resolve, reject) => {
        const quoted = process.platform === "win32" ? `"${file}"` : `'${file.replace(/'/g, "'\\''")}'`;
        const child = spawn(`${command} ${quoted}`, { shell: true, stdio: "inherit" });
        child.on("error", reject);
        child.on("close", resolve);
      });
      const edited = await readFile(file, "utf8");
      this.setDraft(edited);
      if (code !== 0) this.message("error", `External editor exited with ${code ?? "no exit code"}. Draft retained.`);
    } finally {
      if (!this.started) {
        this.started = true;
        this.terminal.clearScreen();
        this.tui.start();
        this.tui.requestRender(true);
        this.mouseReporting(true);
        this.tui.setFocus(this.editor);
      }
      this.externalEditor = false;
      if (directory) {
        await unlink(join(directory, "prompt.md")).catch(() => {});
        await rmdir(directory).catch(() => {});
      }
      this.render();
    }
  }

  private render(): void {
    if (this.started && !this.externalEditor) this.tui.requestRender();
  }

  private mouseReporting(enabled: boolean): void {
    this.terminal.write(enabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
    this.mouseDown = null;
  }

  private scrollTranscript(delta: number): void {
    this.scrollOffset = Math.max(0, Math.min(Math.max(0, this.transcriptRows - 1), this.scrollOffset + delta));
    this.mouseDown = null;
    this.render();
  }

  private handleMouse(data: string): TuiInputListenerResult {
    const status = this.currentStatus;
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!match || this.pasting || this.externalEditor || this.browser || !status || status.initializing) return { consume: true };
    const button = Number(match[1]);
    const column = Number(match[2]) - 1;
    const screenRow = Number(match[3]) - 1;
    if ((button & 28) !== 0 || column < 0 || column >= this.terminal.columns || screenRow < 0 || screenRow >= this.terminal.rows) return { consume: true };
    if ((button & 64) !== 0) {
      if ((button & 3) <= 1) {
        const delta = (button & 1) === 0 ? -3 : 3;
        if (this.panel?.kind === "inspection") this.panel.scroll(delta);
        else if (!this.panel) this.scrollTranscript(-delta);
      }
      return { consume: true };
    }
    if (this.panel || (button & 35) !== 0) return { consume: true };
    const state = this.tui.captureRenderState();
    if (state.previousWidth !== this.terminal.columns || state.previousHeight !== this.terminal.rows) return { consume: true };
    const row = state.previousViewportTop + screenRow;
    const tool = this.toolHitRows.get(row);
    const contextStart = state.previousLines.length - this.contextRows;
    const isContext = row >= contextStart && row < state.previousLines.length;
    const id = tool && column >= 4 && column < tool.end ? tool.id : isContext && column >= 2 ? "context" : null;
    if (match[4] === "M") this.mouseDown = id ? { id, row, column } : null;
    else {
      const press = this.mouseDown;
      this.mouseDown = null;
      if (id && press?.id === id && press.row === row && press.column === column) {
        if (isContext) this.run(() => this.inspect("Context usage", contextDetails(status)));
        else {
          const entry = this.tools.get(id);
          if (entry) { entry.expanded = !(entry.expanded ?? this.expanded); this.render(); }
        }
      }
    }
    return { consume: true };
  }
}

export class PlainUI implements UserInterface {
  private draftText = "";
  private streamedText = "";
  constructor(private readonly options: { json: boolean; approve: boolean }) {}
  status(value: Status): void { this.event("status", value); }
  message(kind: MessageKind, text: string): void {
    if (this.options.json) this.event("message", { role: kind, text });
    else if (kind === "assistant") process.stdout.write(`${sanitizeTerminalText(text)}\n`);
    else if (kind === "info" || kind === "error") process.stderr.write(`${sanitizeTerminalText(text)}\n`);
  }
  assistantDelta(text: string): void {
    if (this.options.json) this.event("assistant_delta", { text });
    else {
      this.streamedText += text;
      process.stdout.write(sanitizeTerminalText(text));
    }
  }
  assistantEnd(text: string): void {
    if (this.options.json) this.event("assistant_end", { text });
    else {
      const remaining = text.startsWith(this.streamedText) ? text.slice(this.streamedText.length) : "";
      if (text || this.streamedText) process.stdout.write(`${sanitizeTerminalText(remaining)}\n`);
      this.streamedText = "";
    }
  }
  reasoning(id: string, text: string, active: boolean): void { this.event("reasoning", { id, text, active }); }
  tool(id: string, name: string, text: string, state: ToolState, details?: ToolDetails): void {
    this.event("tool", { id, name, text, state, ...details });
  }
  choose(_title: string, _choices: Choice[]): Promise<string | null> { return Promise.resolve(null); }
  inspect(title: string, text: string): Promise<void> { this.message("info", `${title}\n${text}`); return Promise.resolve(); }
  input(_title: string, _initial?: string): Promise<string | null> { return Promise.resolve(null); }
  secret(_title: string): Promise<string | null> { return Promise.resolve(null); }
  approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = this.options.approve ? "once" : "deny";
    this.event("approval", { request, decision });
    if (!this.options.json && decision === "deny") process.stderr.write(`Approval denied for ${sanitizeTerminalText(request.tool)}.\n`);
    return Promise.resolve(decision);
  }
  dismiss(): void {}
  draft(): string { return this.draftText; }
  setDraft(text: string): void { this.draftText = text; }
  clear(): void { this.draftText = ""; this.streamedText = ""; }
  copy(text: string): Promise<boolean> { return copyText(text); }
  stop(): void {}
  private event(type: string, data: object): void {
    if (this.options.json) process.stdout.write(`${JSON.stringify({ type, ...data })}\n`);
  }
}
