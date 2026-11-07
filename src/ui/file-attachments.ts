import type { DraftFile } from "../app/types.js";

export interface FileSelection extends DraftFile { text: string }

export class DraftFileAttachments {
  private text = "";
  private selections: Array<{ path: string; start: number; end: number; mention: string }> = [];

  reset(text: string): void { this.text = text; this.selections = []; }

  restore(text: string, files: readonly DraftFile[]): void {
    this.reset(text);
    for (const file of files) this.select({ ...file, text });
  }

  update(text: string): void {
    if (text === this.text) return;
    let start = 0;
    while (start < this.text.length && start < text.length && this.text[start] === text[start]) start++;
    let oldEnd = this.text.length, newEnd = text.length;
    while (oldEnd > start && newEnd > start && this.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
    const shift = newEnd - oldEnd;
    this.selections = this.selections.flatMap((selection) => {
      if (selection.end <= start) return [selection];
      if (selection.start >= oldEnd) return [{ ...selection, start: selection.start + shift, end: selection.end + shift }];
      return [];
    }).filter((selection) => text.slice(selection.start, selection.end) === selection.mention
      && (selection.end === text.length || /\s/u.test(text[selection.end] ?? "")));
    this.text = text;
  }

  select(selection: FileSelection): void {
    this.update(selection.text);
    this.selections.push({ path: selection.path, start: selection.start, end: selection.end,
      mention: selection.text.slice(selection.start, selection.end) });
  }

  paths(): string[] { return [...new Set(this.selections.map((selection) => selection.path))]; }
  snapshot(): DraftFile[] { return this.selections.map(({ path, start, end }) => ({ path, start, end })); }
}
