import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { displayUserText } from "../context/mentions.js";
import { inspectSession, listArkSessions, processAlive, readRunMarker } from "../session/storage.js";
import { SessionView } from "../ui/session-view.js";
import type { CliOptions } from "./args.js";
import { SessionRuntime } from "./session-runtime.js";
import type { InputMode, SessionItem, UserInterface } from "./types.js";
export { contentText } from "./session-runtime.js";

interface OpenSession { runtime: SessionRuntime; view: SessionView }

export class ArkHost {
  private sessions = new Map<string, OpenSession>();
  private current: OpenSession | null = null;
  private opening = new Set<OpenSession>();
  private navigating = false;
  private browsing = false;
  private closing = false;
  private exitTask: Promise<void> | null = null;
  readonly home: string;

  constructor(readonly options: CliOptions, private ui: UserInterface, private environment: { userHome?: string } = {}) { this.home = options.home; }
  get cwd(): string { return this.current?.runtime.cwd ?? this.options.cwd; }
  get outcome(): string | null { return this.current?.runtime.outcome ?? null; }
  private samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
  private sessionDir(cwd = this.cwd): string {
    return join(this.home, "sessions", Buffer.from(process.platform === "win32" ? cwd.toLowerCase() : cwd).toString("base64url"));
  }
  private refreshStatus(): void {
    if (this.closing) return;
    const status = this.current?.view.currentStatus;
    if (!status) return;
    const item = this.current?.runtime.item;
    this.ui.status({ ...status, sessionId: item?.id, sessionName: item?.title,
      backgroundSessions: [...this.sessions.values()].filter((entry) => entry !== this.current).flatMap(({ runtime }) => {
        const item = runtime.item;
        return item ? [{ id: item.id, title: item.title, state: item.state }] : [];
      }),
    });
  }
  private focus(entry: OpenSession): void {
    if (this.current === entry) { if (!entry.view.active) entry.view.activate(); return; }
    this.current?.view.deactivate();
    this.current = entry;
    entry.view.activate();
    entry.runtime.refreshSkills();
  }
  async start(): Promise<void> {
    await this.open(this.options);
    if (this.options.command === "resume" && !this.options.target && !this.options.last) await this.browseSessions();
  }
  private async open(options: CliOptions, manager?: SessionManager, draft?: string): Promise<void> {
    if (this.closing) return;
    const existing = manager ? this.sessions.get(manager.getSessionId()) : undefined;
    if (existing && !existing.runtime.viewer) { this.focus(existing); return; }
    const previous = this.current;
    const view = new SessionView(this.ui, () => this.refreshStatus());
    const runtime: SessionRuntime = new SessionRuntime(options, view, {
      open: (manager, draft): Promise<void> => this.open({ ...options, command: undefined, target: undefined, last: false, trust: false, cwd: runtime.cwd }, manager, draft),
      cancelTrust: previous !== null && !this.samePath(previous.runtime.cwd, options.cwd),
    }, this.environment.userHome);
    const entry = { runtime, view };
    this.opening.add(entry);
    this.focus(entry);
    try {
      await runtime.start(manager);
      if (existing && runtime.ready && !this.closing) await existing.runtime.exit();
      if (this.closing) { await runtime.exit(); return; }
      if (!runtime.ready) throw new Error("Session startup cancelled.");
      if (runtime.id) this.sessions.set(runtime.id, entry);
      if (draft !== undefined) view.setDraft(draft);
      this.refreshStatus();
    } catch (error) {
      await runtime.exit();
      if (previous && !this.closing) this.focus(previous);
      else if (!this.closing) this.current = null;
      throw error;
    } finally { this.opening.delete(entry); }
  }
  async submit(text: string, mode: InputMode = "prompt"): Promise<void> {
    if (this.closing || !this.current?.runtime.ready || this.navigating) return;
    if (text.trim().toLowerCase() === "/exit") { await this.exit(); return; }
    const match = /^\/(new|sessions|fork)(?:\s+(.*))?$/i.exec(text.trim());
    if (!match) { await this.current.runtime.submit(text, mode); return; }
    const [, name, argument = ""] = match;
    this.navigating = true;
    try {
      if (name?.toLowerCase() === "new") {
        await this.open({ ...this.options, cwd: this.cwd, command: undefined, target: undefined, last: false, trust: false, model: undefined, thinking: undefined });
      } else if (name?.toLowerCase() === "sessions" && !argument) await this.browseSessions();
      else {
        const item = name?.toLowerCase() === "fork" && !argument ? this.current.runtime.item : await this.resolveSession(argument);
        if (!item?.path) throw new Error("Send a prompt before forking this session.");
        await this.openItem(item, name?.toLowerCase() === "fork");
      }
    } catch (error) {
      (this.current?.view ?? this.ui).message("error", error instanceof Error ? error.message : String(error));
      this.ui.setDraft(text);
    } finally { this.navigating = false; }
  }
  private async sessionItems(): Promise<SessionItem[]> {
    const saved = await listArkSessions(this.home);
    const items = await Promise.all(saved.map(async (entry): Promise<SessionItem> => {
      const marker = await readRunMarker(this.home, entry.id);
      return { id: entry.id, path: entry.path, cwd: entry.cwd,
        title: entry.name || displayUserText(entry.firstMessage).replace(/\s+/g, " ").slice(0, 100) || "Untitled session",
        preview: displayUserText(entry.firstMessage), modified: entry.modified.getTime(), current: false,
        state: marker?.status === "active" ? processAlive(marker.pid) ? "working" : "unconfirmed" : "inactive" };
    }));
    for (const { runtime } of this.sessions.values()) {
      const item = runtime.item;
      if (!item) continue;
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) { if (!runtime.viewer) items[index] = item; }
      else items.unshift(item);
    }
    return items.map((item) => ({ ...item, current: item.id === this.current?.runtime.id }));
  }
  private async resolveSession(target: string): Promise<SessionItem> {
    const items = (await this.sessionItems()).filter((item) => this.samePath(item.cwd, this.cwd));
    const matched = target === "--last" ? items.filter((item) => item.path).sort((a, b) => b.modified - a.modified).slice(0, 1)
      : items.filter((item) => item.id === target || item.id.startsWith(target));
    if (matched.length !== 1 || !matched[0]) throw new Error(matched.length ? "Session ID is ambiguous." : "Session not found in this workspace.");
    return matched[0];
  }
  private async openItem(item: SessionItem, fork = false): Promise<void> {
    const loaded = this.sessions.get(item.id);
    if (loaded && !loaded.runtime.viewer && !fork) { this.focus(loaded); return; }
    if (!item.path) throw new Error("This session has no saved history yet.");
    const cwd = await realpath(item.cwd);
    const directory = this.sessionDir(cwd);
    if (!this.samePath(dirname(await realpath(item.path)), await realpath(directory))) throw new Error("Session file is outside its project history directory.");
    await inspectSession(item.path, cwd);
    const manager = fork ? SessionManager.forkFrom(item.path, cwd, directory) : SessionManager.open(item.path, directory, cwd);
    await this.open({ ...this.options, cwd, command: undefined, target: undefined, last: false, trust: false, model: undefined, thinking: undefined }, manager);
  }
  async browseSessions(): Promise<void> {
    if (this.closing || this.browsing || !this.current?.runtime.ready) return;
    this.browsing = true;
    this.current?.view.deactivate();
    try {
      const items = await this.sessionItems();
      const selection = this.ui.browseSessions ? await this.ui.browseSessions(items, async (item) => item.path ? await inspectSession(item.path) : { prompt: item.preview, model: item.model })
        : await this.ui.choose("Sessions", items.map((item) => ({ value: item.id, label: item.title, description: `${item.state} | ${item.cwd}` })))
          .then((id) => { const item = items.find((item) => item.id === id); return item ? { kind: "open" as const, item } : null; });
      if (!selection || this.closing) return;
      if (selection.kind === "new") await this.open({ ...this.options, cwd: selection.cwd, command: undefined, target: undefined, last: false, trust: false, model: undefined, thinking: undefined });
      else await this.openItem(selection.item);
    } catch (error) { (this.current?.view ?? this.ui).message("error", error instanceof Error ? error.message : String(error)); }
    finally {
      this.browsing = false;
      if (!this.closing && this.current && !this.current.view.active) this.current.view.activate();
    }
  }
  async editPrevious(): Promise<void> { await this.current?.runtime.editPrevious(); }
  async interrupt(): Promise<void> { await this.current?.runtime.interrupt(); }
  exit(): Promise<void> {
    if (this.exitTask) return this.exitTask;
    this.closing = true;
    const entries = new Set([...this.sessions.values(), ...this.opening]);
    for (const { view } of entries) view.stop();
    this.exitTask = (async () => {
      try {
        const results = await Promise.allSettled([...entries].map(({ runtime }) => runtime.exit()));
        this.sessions.clear();
        for (const result of results) if (result.status === "rejected") throw result.reason;
      } finally { this.ui.stop(); }
    })();
    return this.exitTask;
  }
}
