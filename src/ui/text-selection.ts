import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

interface Point { row: number; column: number }
interface Selection {
  anchor: Point;
  focus: Point;
  lines: string[];
  width: number;
  dragging: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class TranscriptSelection {
  private selection: Selection | null = null;

  get dragging(): boolean { return this.selection?.dragging ?? false; }
  get active(): boolean { return this.text().length > 0; }

  reset(): void { this.selection = null; }

  begin(lines: string[], width: number, row: number, column: number): void {
    this.reset();
    if (!lines.length || row < 0 || row >= lines.length) return;
    const anchor = this.point(lines, row, column);
    this.selection = { anchor, focus: anchor, lines, width, dragging: true };
  }

  move(row: number, column: number): void {
    if (this.selection?.dragging) this.selection.focus = this.point(this.selection.lines, row, column);
  }

  release(row: number, column: number): string {
    this.move(row, column);
    if (this.selection) this.selection.dragging = false;
    return this.text();
  }

  render(lines: string[], width: number): string[] {
    const selection = this.selection;
    if (!selection) return lines;
    const [start, end] = this.bounds(selection);
    if (width !== selection.width || (!selection.dragging && selection.lines.slice(start.row, end.row + 1).some((line, index) => line !== lines[start.row + index]))) {
      this.reset();
      return lines;
    }
    const source = selection.dragging ? selection.lines : lines;
    return source.map((line, row) => {
      if (row < start.row || row > end.row) return line;
      const from = row === start.row ? start.column : 0;
      const to = row === end.row ? end.column : visibleWidth(line);
      if (to <= from) return line;
      const selected = sliceByColumn(stripTerminalSequences(line), from, to - from);
      return `${sliceByColumn(line, 0, from)}\x1b[0m\x1b[48;2;65;80;110m\x1b[38;2;255;255;255m${selected}\x1b[0m${sliceByColumn(line, to, width)}`;
    });
  }

  text(): string {
    const selection = this.selection;
    if (!selection) return "";
    const [start, end] = this.bounds(selection);
    return selection.lines.slice(start.row, end.row + 1).map((line, index) => {
      const row = start.row + index;
      const from = row === start.row ? start.column : 0;
      const to = row === end.row ? end.column : visibleWidth(line);
      return sliceByColumn(stripTerminalSequences(line), from, Math.max(0, to - from)).trimEnd();
    }).join("\n");
  }

  private bounds(selection: Selection): [Point, Point] {
    const { anchor, focus } = selection;
    return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column) ? [anchor, focus] : [focus, anchor];
  }

  private point(lines: string[], row: number, column: number): Point {
    const clampedRow = Math.max(0, Math.min(lines.length - 1, row));
    const line = stripTerminalSequences(lines[clampedRow] ?? "");
    const target = row < 0 ? 0 : row >= lines.length ? visibleWidth(line) : Math.max(0, column);
    let offset = 0;
    for (const { segment } of graphemes.segment(line)) {
      const next = offset + visibleWidth(segment);
      if (next > target) break;
      offset = next;
    }
    return { row: clampedRow, column: offset };
  }
}
