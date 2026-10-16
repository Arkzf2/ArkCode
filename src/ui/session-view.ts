import type { ApprovalRequest, Choice, ChoiceOptions, SessionDetails, SessionItem, Status, ToolDetails, UserInterface } from "../app/types.js";

type ViewEntry =
  | { kind: "message"; args: Parameters<UserInterface["message"]> }
  | { kind: "assistant"; text: string; active: boolean }
  | { kind: "reasoning"; id: string; text: string; active: boolean }
  | { kind: "tool"; id: string; name: string; text: string; state: "running" | "done" | "error"; details?: ToolDetails };

export class SessionView implements UserInterface {
  private entries: ViewEntry[] = [];
  private assistant: Extract<ViewEntry, { kind: "assistant" }> | null = null;
  private focused = false;
  private disposed = false;
  private draftText = "";
  private generation = 0;
  private waiters = new Set<() => void>();
  currentStatus: Status | null = null;

  constructor(private ui: UserInterface, private changed: () => void) {}
  get active(): boolean { return this.focused; }

  activate(): void {
    this.focused = true;
    this.ui.clear();
    for (const entry of this.entries) {
      switch (entry.kind) {
        case "message": this.ui.message(...entry.args); break;
        case "assistant":
          if (entry.active) this.ui.assistantDelta(entry.text);
          else this.ui.assistantEnd(entry.text);
          break;
        case "reasoning": this.ui.reasoning(entry.id, entry.text, entry.active); break;
        case "tool": this.ui.tool(entry.id, entry.name, entry.text, entry.state, entry.details); break;
      }
    }
    this.ui.setDraft(this.draftText);
    this.changed();
    this.wake();
  }
  deactivate(): void {
    if (!this.focused) return;
    this.draftText = this.ui.draft();
    this.focused = false;
    this.ui.dismiss();
  }
  status(value: Status): void { this.currentStatus = value; this.changed(); }
  message(...args: Parameters<UserInterface["message"]>): void {
    this.entries.push({ kind: "message", args });
    if (this.focused) this.ui.message(...args);
  }
  assistantDelta(text: string): void {
    for (const entry of this.entries) if (entry.kind === "reasoning") entry.active = false;
    if (!this.assistant) {
      this.assistant = { kind: "assistant", text: "", active: true };
      this.entries.push(this.assistant);
    }
    this.assistant.text += text;
    if (this.focused) this.ui.assistantDelta(text);
  }
  assistantEnd(text: string): void {
    if (this.assistant) { this.assistant.text = text; this.assistant.active = false; this.assistant = null; }
    else if (text) this.entries.push({ kind: "assistant", text, active: false });
    if (this.focused) this.ui.assistantEnd(text);
  }
  reasoning(id: string, text: string, active: boolean): void {
    const previous = this.entries.find((entry) => entry.kind === "reasoning" && entry.id === id);
    if (previous?.kind === "reasoning") { previous.text = text; previous.active = active; }
    else this.entries.push({ kind: "reasoning", id, text, active });
    if (this.focused) this.ui.reasoning(id, text, active);
  }
  tool(id: string, name: string, text: string, state: "running" | "done" | "error", details?: ToolDetails): void {
    const previous = this.entries.find((entry) => entry.kind === "tool" && entry.id === id);
    if (previous?.kind === "tool") {
      previous.name = name; previous.text = text; previous.state = state;
      previous.details = { ...previous.details, ...details };
    } else this.entries.push({ kind: "tool", id, name, text, state, details });
    if (this.focused) this.ui.tool(id, name, text, state, details);
  }
  private wake(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private async interact<T>(action: () => Promise<T>, cancelled: T): Promise<T> {
    const generation = this.generation;
    while (!this.disposed && generation === this.generation) {
      if (!this.focused) { await new Promise<void>((resolve) => this.waiters.add(resolve)); continue; }
      const result = await action();
      if (this.disposed || generation !== this.generation) return cancelled;
      if (this.focused) return result;
    }
    return cancelled;
  }
  choose(title: string, choices: Choice[], options?: ChoiceOptions): Promise<string | null> { return this.interact(() => this.ui.choose(title, choices, options), null); }
  inspect(title: string, text: string): Promise<void> { return this.interact(() => this.ui.inspect(title, text), undefined); }
  input(title: string, initial?: string): Promise<string | null> { return this.interact(() => this.ui.input(title, initial), null); }
  secret(title: string): Promise<string | null> { return this.interact(() => this.ui.secret(title), null); }
  approve(request: ApprovalRequest) { return this.interact(() => this.ui.approve(request), "deny" as const); }
  async browseSessions(items: SessionItem[], details?: (item: SessionItem) => Promise<SessionDetails>) {
    const browse = this.ui.browseSessions?.bind(this.ui);
    return browse ? this.interact(() => browse(items, details), null) : null;
  }
  dismiss(): void { this.generation++; if (this.focused) this.ui.dismiss(); this.wake(); }
  draft(): string { return this.focused ? this.ui.draft() : this.draftText; }
  setDraft(text: string): void { this.draftText = text; if (this.focused) this.ui.setDraft(text); }
  clear(): void { this.entries = []; this.assistant = null; if (this.focused) this.ui.clear(); }
  copy(text: string): Promise<boolean> { return this.interact(() => this.ui.copy(text), false); }
  stop(): void { this.disposed = true; this.dismiss(); }
}
