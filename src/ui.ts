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
  InputMode,
  SessionBrowserResult,
  SessionDetails,
  SessionItem,
  SessionState,
  Status,
  ToolDetails,
  UiActions,
  UserInterface,
} from "./domain.js";
import { slashCommands } from "./commands.js";
import { mentionPrefix, WorkspaceAutocompleteProvider } from "./autocomplete.js";

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
  | { kind: "tool"; id: string; name: string; target: string; exitCode?: number; text: string; state: ToolState };
type Panel =
  | { kind: "choice"; component: Container; cancel: () => void; select: (index: number) => void }
  | { kind: "input"; component: Container; cancel: () => void };
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
const userText = fg(209, 201, 181);
const pathText = fg(168, 170, 180);
const commandText = fg(214, 215, 218);
const neutral = fg(195, 196, 205);
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
  private visibleStart = 0;
  private pasting = false;
  private lastKey: { data: string; at: number } | null = null;
  private lastEscape = 0;
  private started = false;
  private externalEditor = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly actions: UiActions, private readonly terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiMainScreen(terminal, true);
    this.editor = this.createEditor();
    this.tui.addInputListener((data) => this.handleKeys(data));
    this.rebuild();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tui.start();
    this.timer = setInterval(() => {
      if (this.currentStatus?.state.kind !== "idle") this.tui.requestRender();
    }, 1000);
    this.timer.unref();
  }

  status(value: Status): void {
    const oldCwd = this.currentStatus?.cwd;
    this.currentStatus = value;
    if (value.state.kind === "idle") {
      for (const entry of this.entries) if (entry.kind === "reasoning") entry.active = false;
    }
    if (oldCwd !== value.cwd) this.editor.setAutocompleteProvider(new WorkspaceAutocompleteProvider(value.cwd));
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
      entry = { kind: "tool", id, name, target: "", text, state };
      this.tools.set(id, entry);
      this.entries.push(entry);
    }
    entry.name = sanitizeTerminalText(name);
    entry.text = sanitizeTerminalText(text);
    entry.state = state;
    if (details?.target !== undefined) entry.target = sanitizeTerminalText(details.target);
    if (details?.exitCode !== undefined) entry.exitCode = details.exitCode;
    this.render();
  }

  choose(title: string, choices: Choice[]): Promise<string | null> {
    this.dismiss();
    if (!choices.length) {
      this.message("info", `${title}\nNo choices available.`);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const list = new SelectList(choices.map((choice) => ({
        value: choice.value,
        label: sanitizeTerminalText(choice.label),
        ...(choice.description ? { description: sanitizeTerminalText(choice.description) } : {}),
      })), 8, this.theme.select);
      const component = new Container();
      component.addChild(new Text(bold(sanitizeTerminalText(title)), 2, 1));
      component.addChild(list);
      component.addChild(new Text(dim("↑/↓ select · Enter confirm · Esc cancel"), 2, 1));
      const finish = (value: string | null): void => {
        this.closePanel();
        resolve(value);
      };
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
      this.panel = {
        kind: "choice",
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
        { value: "session", label: "2. Yes, and don't ask again for this command in this session" },
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
    this.render();
  }

  copy(text: string): Promise<boolean> { return copyText(text); }

  stop(): void {
    this.dismiss();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.started) this.tui.stop();
    this.started = false;
  }

  private createEditor(): Editor {
    const editor = new ArkEditor(this.tui, this.theme.editor, { paddingX: 4, autocompleteMaxVisible: 6 });
    editor.setAutocompleteProvider(new WorkspaceAutocompleteProvider(this.currentStatus?.cwd ?? process.cwd()));
    editor.onSubmit = (value) => this.submit(value, this.busy() ? "steer" : "prompt");
    return editor;
  }

  private messageComponent(kind: MessageKind, text: string): Markdown | Text {
    if (kind === "assistant") return new Markdown(text, 0, 1, this.theme.markdown);
    return new Text(text, 0, kind === "user" ? 0 : 1);
  }

  private toolLines(entry: Extract<TranscriptEntry, { kind: "tool" }>, width: number): string[] {
    const action = this.toolAction(entry.name, entry.state);
    const shell = entry.name === "bash" || entry.name === "shell";
    const marker = entry.state === "error" ? red("•") : entry.state === "done" && shell ? green("•") : dim("•");
    const target = (shell ? commandText : pathText)(entry.target || entry.name);
    const result = entry.exitCode === undefined ? "" : `  ${entry.exitCode === 0 ? dim(`exit ${entry.exitCode}`) : red(`exit ${entry.exitCode}`)}`;
    const heading = wrapTextWithAnsi(`${neutral(action)} ${target}${result}`, Math.max(1, width - 4));
    const rows = heading.map((line, index) => `  ${index === 0 ? marker : " "} ${line}`);
    const output = entry.text;
    const wrapped = output ? output.split("\n").flatMap((line) => wrapTextWithAnsi(this.formatToolLine(line), Math.max(1, width - 6))) : [];
    const preview = this.expanded ? wrapped : wrapped.slice(0, 3);
    rows.push(...preview.map((line, index) => `    ${index === 0 ? dim("└") : " "} ${line}`));
    if (!this.expanded && wrapped.length > 3) rows.push(...wrapTextWithAnsi(dim(`+${wrapped.length - 3} lines · Ctrl+T for details`), Math.max(1, width - 4)).map((line) => `    ${line}`));
    return [...rows, ""];
  }

  private toolAction(name: string, state: ToolState): string {
    if (state === "error") return "Failed";
    if (name === "read" || name === "find" || name === "grep" || name === "ls") return state === "running" ? "Exploring" : "Explored";
    if (name === "edit" || name === "write") return state === "running" ? "Editing" : "Edited";
    if (name === "bash" || name === "shell") return state === "running" ? "Running" : "Ran";
    return state === "running" ? "Working" : "Worked";
  }

  private formatToolLine(line: string): string {
    if (line.startsWith("+") && !line.startsWith("+++")) return green(line);
    if (line.startsWith("-") && !line.startsWith("---")) return red(line);
    if (line.startsWith("@@")) return dim(line);
    if (/^\s*(PASS|ok|✓)/.test(line)) return green(line);
    if (/^\s*(FAIL|Error|AssertionError)/.test(line)) return red(line);
    return dim(line);
  }

  private rebuild(): void {
    this.tui.clear();
    if (this.browser) {
      this.tui.addChild(new RenderComponent((width) => this.browserLines(width)));
      return;
    }
    this.tui.addChild(new RenderComponent((width) => this.headerLines(width)));
    this.tui.addChild(new RenderComponent((width) => {
      const lines: string[] = [];
      const entries = this.entries.slice(this.visibleStart);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.kind === "tool") {
          const group = [entry];
          if (!this.expanded && this.exploration(entry)) {
            let next = entries[index + 1];
            while (next?.kind === "tool" && this.exploration(next)) {
              group.push(next);
              index++;
              next = entries[index + 1];
            }
          }
          if (group.length > 1) {
            lines.push(`  ${dim("•")} ${neutral("Explored")}`);
            const output = group.flatMap((tool) => wrapTextWithAnsi(`${tool.name === "read" ? "Read" : tool.name} ${tool.target || tool.name}`, Math.max(1, width - 6)));
            lines.push(...output.slice(0, 3).map((line, offset) => `    ${offset === 0 ? dim("└") : " "} ${dim(line)}`));
            if (output.length > 3) lines.push(...wrapTextWithAnsi(dim(`+${output.length - 3} lines · Ctrl+T for details`), Math.max(1, width - 4)).map((line) => `    ${line}`));
            lines.push("");
          } else lines.push(...this.toolLines(entry, width));
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
          if (!stripTerminalSequences(line).trim()) { lines.push(""); continue; }
          const color = entry.kind === "reasoning" ? (value: string) => italic(dim(value)) : entry.role === "error" ? red : entry.role === "info" ? dim : neutral;
          lines.push(`  ${first ? dim("•") : " "} ${color(line)}`);
          first = false;
        }
      }
      return lines;
    }));
    this.tui.addChild(new RenderComponent((width) => this.activity(width)));
    this.tui.addChild(this.panel?.component ?? this.editor);
    this.tui.addChild(new RenderComponent((width) => this.statusLines(width)));
    if (!this.panel) this.tui.setFocus(this.editor);
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

  private exploration(entry: Extract<TranscriptEntry, { kind: "tool" }>): boolean {
    return entry.state === "done" && ["read", "find", "grep", "ls"].includes(entry.name);
  }

  private activity(width: number): string[] {
    const status = this.currentStatus;
    if (!status) return [];
    const rows: string[] = [];
    if (status.state.kind !== "idle") {
      const elapsed = Math.floor((Date.now() - status.state.startedAt) / 1000);
      const currentTool = [...this.tools.values()].findLast((tool) => tool.state === "running");
      const thinking = this.entries.some((entry) => entry.kind === "reasoning" && entry.active);
      const label = status.state.kind === "awaiting-approval" ? "Approval needed" :
        status.state.kind === "stopping" ? "Stopping" : currentTool ? `${this.toolAction(currentTool.name, "running")} ${currentTool.target || currentTool.name}` : this.activeAssistant ? "Writing response" : thinking ? "Thinking" : "Working";
      rows.push(`${dim("•")} ${label}  ${dim(`(${elapsed}s)`)}`);
    } else if (status.state.outcome === "interrupted") rows.push("Interrupted");
    else if (status.state.outcome === "failed") rows.push("Failed");
    else rows.push(status.state.outcome === "completed" ? "Completed" : "Ready");
    if (status.queued.length) rows.push(...status.queued.map((item) => `Queued · ${sanitizeTerminalText(item)}`));
    return rows.flatMap((row) => wrapTextWithAnsi(dim(row), Math.max(1, width - 4)).map((line) => `  ${line}`));
  }

  private statusLines(width: number): string[] {
    const status = this.currentStatus;
    if (!status) return [];
    const permission = status.permission === "read-only" ? "Read only" : status.permission === "ask" ? "Ask for approval" : "Full access";
    const fields = [
      accent(sanitizeTerminalText(status.model)),
      reasoningText(sanitizeTerminalText(status.thinking)),
      directoryText(sanitizeTerminalText(status.cwd)),
      permissionText(permission),
      branchText(sanitizeTerminalText(status.branch || "No Git")),
      yellow(sanitizeTerminalText(status.context.replace("Context unknown", "Context unavailable"))),
    ];
    const joined = fields.join("  ");
    return wrapTextWithAnsi(joined, Math.max(1, width - 4)).map((row) => `  ${row}`);
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
    if (!value.trim()) return;
    this.editor.addToHistory(value);
    this.promptHistory.push(value);
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
    if (isKeyRelease(data)) return { consume: true };
    if (this.pasting || data.includes("\x1b[200~")) {
      this.pasting = !data.includes("\x1b[201~");
      return this.browser || this.panel?.kind === "choice" || (!this.panel && this.currentStatus?.state.kind === "stopping") ? { consume: true } : undefined;
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
      if (/^[1-9]$/.test(data) && this.panel.kind === "choice") {
        this.panel.select(Number(data) - 1);
        return { consume: true };
      }
      return undefined;
    }
    if (this.currentStatus?.state.kind === "stopping" && !matchesKey(data, "ctrl+c") && !matchesKey(data, "ctrl+t") && !matchesKey(data, "ctrl+o")) return { consume: true };
    if (matchesKey(data, "ctrl+c")) {
      this.run(() => this.busy() ? this.actions.interrupt() : this.actions.exit());
    } else if (matchesKey(data, "ctrl+d") && !this.draft()) {
      this.run(() => this.actions.exit());
    } else if (matchesKey(data, "escape")) {
      if (this.editor.isShowingAutocomplete()) return undefined;
      if (this.expanded) {
        this.expanded = false;
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
      if (this.expanded) this.visibleStart = 0;
      this.render();
    } else if (matchesKey(data, "ctrl+o")) {
      this.run(() => this.actions.submit("/copy", "prompt"));
    } else if (matchesKey(data, "ctrl+l")) {
      this.visibleStart = this.entries.length;
      this.tui.terminal.clearScreen();
      this.tui.requestRender(true);
    } else if (matchesKey(data, "ctrl+r")) {
      this.run(() => this.searchHistory());
    } else if (matchesKey(data, "ctrl+g")) {
      this.run(() => this.editExternally());
    } else if (data === "?" && !this.draft()) {
      this.message("info", "Enter send / steer    Tab queue follow-up    Left sessions    Ctrl+C interrupt / exit\nCtrl+T tool details    Ctrl+O copy    Ctrl+R history    Ctrl+G editor\nCtrl+L clear view    Shift+Enter newline    Esc cancel    /help commands");
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
        this.tui.start();
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
