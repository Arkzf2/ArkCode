import xterm from "@xterm/headless";
import { setTimeout } from "node:timers/promises";
import type { Terminal } from "@earendil-works/pi-tui";

export class ScreenTerminal implements Terminal {
  readonly screen: xterm.Terminal;
  readonly kittyProtocolActive = false;
  output = "";
  private input: ((data: string) => void) | null = null;
  private resized: (() => void) | null = null;

  constructor(columns = 100, rows = 35) {
    this.screen = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 2000 });
  }
  get columns(): number { return this.screen.cols; }
  get rows(): number { return this.screen.rows; }
  start(input: (data: string) => void, resized: () => void): void { this.input = input; this.resized = resized; }
  stop(): void { this.input = null; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; this.screen.write(data); }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  press(data: string): void { this.input?.(data); }
  resize(columns: number, rows: number): void { this.screen.resize(columns, rows); this.resized?.(); }
  async flush(): Promise<void> {
    await setTimeout(45);
    await new Promise<void>((resolve) => this.screen.write("", resolve));
  }
  lines(): string[] {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: this.rows }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "");
  }
  text(): string { return this.lines().join("\n"); }
  find(text: string): { row: number; column: number } {
    const row = this.lines().findIndex((line) => line.includes(text));
    if (row < 0) throw new Error(`Missing ${JSON.stringify(text)} in screen:\n${this.text()}`);
    return { row, column: (this.lines()[row] ?? "").indexOf(text) };
  }
  foreground(text: string): number | undefined {
    const { row, column } = this.find(text);
    const buffer = this.screen.buffer.active;
    return buffer.getLine(buffer.baseY + row)?.getCell(column)?.getFgColor();
  }
  click(text: string): void {
    const { row, column } = this.find(text);
    this.press(`\x1b[<0;${column + 1};${row + 1}M`);
    this.press(`\x1b[<0;${column + 1};${row + 1}m`);
  }
}
