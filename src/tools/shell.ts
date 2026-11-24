import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { spawn as spawnPty, type IPty } from "node-pty";
import { createOutputCleaner } from "./output.js";
import { resolveShell, shellInstructions, type ShellConfiguration } from "./shell-config.js";
import { ShellOutput, type CapturePosition } from "./shell-output.js";
import type { BashInput, ShellControlInput, ShellError, ShellPreview, ShellSessionResult, ShellState } from "./shell-contract.js";

const RECEIPT_BYTES = 128 * 1024;
const STOP_CONFIRM_MS = 5000;
type Reason = "stop" | "user_interrupt";
export interface ShellReceipt {
  id: string; command: string; cwd: string; shell: string; pid: number | null;
  startedAt: number; endedAt: number | null; status: ShellState["status"];
  exitCode: number | null; output: string; truncated: boolean;
}
type Projection = Awaited<ReturnType<ShellOutput["project"]>>;
export interface ShellObservation { result: ShellSessionResult; text: string; receipt: ShellReceipt }
interface Entry {
  mode: "pipe" | "pty"; child?: ChildProcess; pty?: IPty; pid: number | null; stdin?: NonNullable<ChildProcess["stdin"]>;
  receipt: ShellReceipt; state: ShellState; log: ShellOutput;
  position: CapturePosition; closed: Promise<void>; resolveClosed: () => void;
  observers: Set<() => void>; waiting: boolean; observing: number; writing: boolean;
  handedOff: boolean; terminalDelivered: boolean; noticeDelivered: boolean;
  results: Promise<unknown>; killTimer?: NodeJS.Timeout;
  progressTimer?: NodeJS.Timeout;
  cancellation?: { reason: Reason; startedAt: number; cleanup: Promise<Error | null> };
  cleanupError?: Error;
  lastOutputFile?: string;
  onUpdate?: (receipt: ShellReceipt) => void; onData?: (data: Buffer) => void;
}
interface ObserveOptions { signal?: AbortSignal; exportFile?: (path: string) => Promise<void>; input?: "accepted"; onData?: (data: Buffer) => void }
type LegacyShellControlInput =
  | { action: "send"; session_id: string; data?: string; eof?: boolean; wait_ms?: number }
  | { action: "wait"; session_id: string; wait_ms?: number };
type ShellControlRequest = ShellControlInput | LegacyShellControlInput;
export class ShellOperationError extends Error {
  constructor(readonly code: ShellError["error"]["code"], message: string, readonly snapshot?: ShellError["session"], readonly delivery?: "accepted" | "not_sent" | "unknown") { super(message); }
}
const live = (state: ShellState) => state.status === "running" || state.status === "stopping";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const noProcess = (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH";
const isObjectLike = (value: unknown): value is object => typeof value === "object" && value !== null;
const invokeNoArg = (owner: unknown, method: string): void => {
  if (!isObjectLike(owner)) return;
  const operation = Reflect.get(owner, method);
  if (typeof operation === "function") Reflect.apply(operation, owner, []);
};
const disposePtyResources = (pty: IPty): void => {
  if (process.platform !== "win32") {
    invokeNoArg(pty, "destroy");
    return;
  }
  const agent = Reflect.get(pty, "_agent");
  if (isObjectLike(agent)) {
    invokeNoArg(Reflect.get(agent, "_conoutSocketWorker"), "dispose");
    invokeNoArg(Reflect.get(agent, "_inSocket"), "destroy");
    invokeNoArg(Reflect.get(agent, "_outSocket"), "destroy");
  }
  invokeNoArg(Reflect.get(pty, "_socket"), "destroy");
};

export class ManagedShell {
  private readonly selected: ShellConfiguration;
  private readonly entries = new Map<string, Entry>();
  private readonly expired = new Set<string>();
  private readonly issuedIds = new Set<string>();
  private readonly calls = new Map<string, { result: Promise<ShellObservation>; settled: boolean }>();
  private steerVersion = 0;
  private pendingStarts = 0;
  private changed: ((receipt: ShellReceipt) => void) | undefined;
  constructor(readonly cwd: string, executable?: string) { this.selected = Object.freeze(resolveShell({ executable })); }
  get configuration(): ShellConfiguration { return this.selected; }
  get executable(): string { return this.configuration.executable; }
  get kind(): ShellConfiguration["kind"] { return this.configuration.kind; }
  get instructions(): string { return shellInstructions(this.configuration); }
  set onChange(callback: ((receipt: ShellReceipt) => void) | undefined) { this.changed = callback; }
  list(): ShellReceipt[] { return [...this.entries.values()].map(entry => ({ ...entry.receipt })); }
  inventory() { return [...this.entries.values()].filter(entry => entry.handedOff && (live(entry.state) || !entry.terminalDelivered)).map(entry => ({ session_id: entry.receipt.id, command: entry.receipt.command.slice(0, 200), ...entry.state, ...(entry.lastOutputFile ? { output_file: entry.lastOutputFile } : {}) })); }
  completions() {
    return [...this.entries.values()].filter(entry => entry.handedOff && !live(entry.state) && !entry.terminalDelivered && !entry.noticeDelivered && entry.observing === 0)
      .map(entry => { entry.noticeDelivered = true; return { session_id: entry.receipt.id, ...entry.state, ...(entry.lastOutputFile ? { output_file: entry.lastOutputFile } : {}) }; });
  }
  describe(id: string) { const entry = this.get(id); return { ...entry.receipt, ...entry.state, session_id: id }; }
  steer(): void { this.steerVersion++; for (const entry of this.entries.values()) for (const wake of entry.observers) wake(); }
  async beginRun(): Promise<void> {
    if ([...this.entries.values()].some(entry => live(entry.state))) return;
    for (const entry of this.entries.values()) { await entry.results; this.expired.add(entry.receipt.id); await entry.log.close(); }
    this.entries.clear(); this.calls.clear();
    while (this.expired.size > 128) { const id = this.expired.values().next().value; if (id === undefined) break; this.expired.delete(id); }
  }
  async endRun(): Promise<void> { await this.stopAll(); await this.beginRun(); }
  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new ShellOperationError(this.expired.has(id) ? "session_expired" : "session_not_found", "Shell session is unknown or no longer belongs to this active agent run.");
    return entry;
  }
  once(id: string, operation: () => Promise<ShellObservation>): Promise<ShellObservation> {
    const previous = this.calls.get(id); if (previous) return previous.result;
    if (this.calls.size >= 128) {
      const first = [...this.calls].find(([, call]) => call.settled);
      if (first) this.calls.delete(first[0]);
    }
    const result = operation();
    const call = { result, settled: false }; this.calls.set(id, call);
    void result.then(() => { call.settled = true; }, () => { call.settled = true; });
    return result;
  }
  private snapshot(entry: Entry) { return { session_id: entry.receipt.id, ...entry.state }; }
  private allocateId(): string {
    let id: string;
    do { id = `sh_${randomBytes(4).toString("hex")}`; } while (this.issuedIds.has(id));
    this.issuedIds.add(id);
    return id;
  }
  private notify(entry: Entry): void {
    if (entry.progressTimer) { clearTimeout(entry.progressTimer); entry.progressTimer = undefined; }
    entry.onUpdate?.({ ...entry.receipt }); this.changed?.({ ...entry.receipt }); for (const wake of entry.observers) wake();
  }
  private async start(input: BashInput, onUpdate?: Entry["onUpdate"], onData?: Entry["onData"]): Promise<Entry> {
    if (this.pendingStarts + [...this.entries.values()].filter(entry => live(entry.state)).length >= 8) throw new ShellOperationError("session_limit", "At most 8 active shell sessions are allowed. Finish or stop existing work first.");
    let release: Promise<void> | undefined;
    if (this.entries.size + this.pendingStarts >= 128) {
      const old = [...this.entries.values()].find(entry => !live(entry.state) && entry.terminalDelivered && entry.observing === 0);
      if (!old) throw new ShellOperationError("session_limit", "Shell history is full. Collect existing results before starting more work.");
      this.entries.delete(old.receipt.id); this.expired.add(old.receipt.id); release = old.log.close();
    }
    this.pendingStarts++;
    let log: ShellOutput;
    try { await release; log = await ShellOutput.create(); } finally { this.pendingStarts--; }
    const args = this.kind === "powershell"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n${input.command}\n$arkcodeCommandSucceeded = $?; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $arkcodeCommandSucceeded) { exit 1 }`]
      : ["-c", input.command];
    const mode = input.io_mode ?? "pipe";
    let child: ChildProcess | undefined;
    let pty: IPty | undefined;
    try {
      if (mode === "pty") {
        pty = spawnPty(this.executable, args, { cwd: this.cwd, env: process.env, cols: 120, rows: 40, name: "xterm-color", useConpty: true });
      } else {
        child = spawn(this.executable, args, { cwd: this.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      }
    } catch (error) {
      await log.close();
      throw new ShellOperationError("spawn_failed", `The command did not start. ${errorText(error)}`);
    }
    let resolveClosed = () => {};
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const pid = child?.pid ?? pty?.pid ?? null;
    const receipt: ShellReceipt = { id: this.allocateId(), command: input.command, cwd: this.cwd, shell: this.executable, pid,
      startedAt: Date.now(), endedAt: null, status: "running", exitCode: null, output: "", truncated: false };
    const entry: Entry = { mode, child, pty, pid, stdin: child?.stdin ?? undefined, log, receipt, closed, resolveClosed, state: { status: "running", stdin_open: true },
      position: { bytes: 0, newlines: 0, openLine: false }, observers: new Set(), waiting: false, observing: 0, writing: false, handedOff: false,
      terminalDelivered: false, noticeDelivered: false, results: Promise.resolve(), onUpdate, onData };
    this.entries.set(receipt.id, entry);
    const append = (cleaned: string) => {
      if (!log.append(cleaned)) {
        child?.stdout?.pause(); child?.stderr?.pause();
        pty?.pause();
        log.drained(() => { child?.stdout?.resume(); child?.stderr?.resume(); pty?.resume(); });
      }
      onData?.(Buffer.from(cleaned));
      const room = RECEIPT_BYTES - Buffer.byteLength(receipt.output);
      if (Buffer.byteLength(cleaned) > room) receipt.truncated = true;
      if (room > 0) receipt.output += new TextDecoder().decode(Buffer.from(cleaned).subarray(0, room), { stream: true });
      onUpdate?.({ ...receipt });
      if (!entry.progressTimer) {
        entry.progressTimer = setTimeout(() => { entry.progressTimer = undefined; this.changed?.({ ...receipt }); }, 100);
        entry.progressTimer.unref();
      }
    };
    const stdout = createOutputCleaner(); const stderr = createOutputCleaner();
    if (child) {
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (text: string) => append(stdout(text))); child.stderr?.on("data", (text: string) => append(stderr(text)));
      child.stdin?.on("error", () => {});
      child.stdin?.on("close", () => { if (entry.state.status === "running") entry.state = { status: "running", stdin_open: false }; });
      child.on("close", (code, signal) => { void this.finish(entry, code, signal).catch(error => {
      entry.cleanupError = new Error(errorText(error));
      entry.state = { status: "stopping", stdin_open: false, termination_reason: entry.cancellation?.reason ?? "stop", cleanup: { state: "failed", message: errorText(error) } };
      receipt.status = "stopping"; resolveClosed(); this.notify(entry);
      }); });
      try { await new Promise<void>((resolve, reject) => { child?.once("spawn", resolve); child?.once("error", reject); }); }
      catch (error) {
        await closed; this.entries.delete(receipt.id); await log.close();
        throw new ShellOperationError("spawn_failed", `The command did not start. ${errorText(error)}`);
      }
    } else if (pty) {
      pty.onData(data => append(stdout(data)));
      pty.onExit(({ exitCode, signal }) => { void this.finish(entry, exitCode, signal === undefined || signal === 0 ? null : String(signal)).catch(error => {
        entry.cleanupError = new Error(errorText(error));
        entry.state = { status: "stopping", stdin_open: false, termination_reason: entry.cancellation?.reason ?? "stop", cleanup: { state: "failed", message: errorText(error) } };
        receipt.status = "stopping"; resolveClosed(); this.notify(entry);
      }); });
    }
    this.notify(entry); return entry;
  }
  private async finish(entry: Entry, code: number | null, signal: string | null): Promise<void> {
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.receipt.exitCode = code;
    if (!entry.cancellation) {
      entry.state = code === 0 && signal === null
        ? { status: "completed", stdin_open: false, exit_code: 0, signal: null }
        : { status: "failed", stdin_open: false, exit_code: code, signal };
      entry.receipt.status = entry.state.status;
      entry.receipt.endedAt = Date.now();
    }
    if (entry.cancellation && process.platform !== "win32" && entry.pid) {
      try { process.kill(-entry.pid, "SIGKILL"); } catch (error) { if (!noProcess(error)) entry.cleanupError = new Error(errorText(error)); }
    }
    const cleanup = await entry.cancellation?.cleanup;
    if (cleanup) entry.cleanupError = cleanup;
    try { await entry.log.flush(); } catch { /* The output operation reports capture failure independently of process exit. */ }
    if (entry.cleanupError) entry.state = { status: "stopping", stdin_open: false, termination_reason: entry.cancellation?.reason ?? "stop", cleanup: { state: "failed", message: entry.cleanupError.message } };
    else if (entry.cancellation) entry.state = { status: "cancelled", stdin_open: false, exit_code: code, signal, termination_reason: entry.cancellation.reason, cleanup: { state: "confirmed" } };
    else if (code === 0 && signal === null) entry.state = { status: "completed", stdin_open: false, exit_code: 0, signal: null };
    else entry.state = { status: "failed", stdin_open: false, exit_code: code, signal };
    if (entry.pty) {
      try { disposePtyResources(entry.pty); } catch { /* PTY process state is already settled. */ }
    }
    entry.receipt.status = entry.state.status;
    if (!live(entry.state)) entry.receipt.endedAt = Date.now();
    entry.resolveClosed(); this.notify(entry);
  }
  private cancel(entry: Entry, reason: Reason): boolean {
    if (entry.state.status !== "running") return false;
    entry.state = { status: "stopping", stdin_open: false, termination_reason: reason, cleanup: { state: "pending" } };
    entry.receipt.status = "stopping";
    const pid = entry.pid;
    const cleanup = new Promise<Error | null>(resolve => {
      if (!pid) { resolve(null); return; }
      if (process.platform === "win32") execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: STOP_CONFIRM_MS }, error => {
        resolve(error ? new Error(`Process tree cleanup unconfirmed: ${error.message}`) : null);
      });
      else {
        try {
          process.kill(-pid, "SIGTERM");
          if (entry.pty) entry.pty.kill();
          resolve(null);
        } catch (error) { resolve(noProcess(error) ? null : new Error(errorText(error))); }
        entry.killTimer = setTimeout(() => {
          try { process.kill(-pid, "SIGKILL"); } catch (error) { if (!noProcess(error)) entry.cleanupError = new Error(errorText(error)); }
        }, 1000);
      }
    });
    entry.cancellation = { reason, startedAt: Date.now(), cleanup };
    void cleanup.then(error => {
      if (error && entry.state.status === "stopping") {
        entry.cleanupError = error; entry.state = { ...entry.state, cleanup: { state: "failed", message: error.message } }; this.notify(entry);
      }
    });
    this.notify(entry); return true;
  }
  private async pause(entry: Entry, milliseconds: number, signal?: AbortSignal): Promise<"exit" | "wait_limit" | "user_steer" | "cleanup_failed"> {
    signal?.throwIfAborted(); const version = this.steerVersion;
    if (!live(entry.state)) return "exit";
    if (entry.cleanupError) return "cleanup_failed";
    return new Promise((resolve, reject) => {
      const finish = (reason: "exit" | "wait_limit" | "user_steer" | "cleanup_failed") => { clearTimeout(timer); signal?.removeEventListener("abort", abort); entry.observers.delete(check); resolve(reason); };
      const check = () => { if (!live(entry.state)) finish("exit"); else if (entry.cleanupError) finish("cleanup_failed"); else if (version !== this.steerVersion) finish("user_steer"); };
      const abort = () => { clearTimeout(timer); entry.observers.delete(check); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Shell observation aborted.")); };
      const timer = setTimeout(() => finish("wait_limit"), milliseconds);
      entry.observers.add(check); signal?.addEventListener("abort", abort, { once: true }); check(); if (signal?.aborted) abort();
    });
  }
  private async observe(entry: Entry, milliseconds: number, options: ObserveOptions = {}, started = performance.now()): Promise<ShellObservation> {
    entry.observing++;
    try {
      const wake = await this.pause(entry, milliseconds, options.signal);
      const make = async (): Promise<ShellObservation> => {
        options.signal?.throwIfAborted();
        const state = entry.state;
        const receipt = { ...entry.receipt };
        const projection = await entry.log.project(entry.position, !live(state));
        if (projection.outputFile) await options.exportFile?.(projection.outputFile);
        options.signal?.throwIfAborted();
        const preview: ShellPreview = projection.truncated && projection.outputFile
          ? { truncated: true, output_file: projection.outputFile, truncation: { ...projection.truncation, mode: "head_tail", reason: "bytes" } }
          : { truncated: false };
        const message = state.status === "running"
          ? `${wake === "wait_limit" ? `[still running after the ${milliseconds}ms observation window; session_id: ${entry.receipt.id}]` : `[still running; session_id: ${entry.receipt.id}]`} Use shell_control with action "wait" and this session_id when the result is needed. Do not launch the command again.`
          : undefined;
        const result: ShellSessionResult = { kind: "session", session_id: entry.receipt.id, ...state, ...preview,
          output: projection.output, ...(projection.outputFile ? { output_file: projection.outputFile } : {}),
          wake_reason: !live(state) ? "exit" : state.status === "stopping" && wake === "wait_limit" ? "stop_unconfirmed" : wake,
          wall_time_seconds: (performance.now() - started) / 1000,
          ...(message ? { message } : {}), ...(options.input ? { input: { state: options.input } } : {}),
        };
        entry.position = projection.end; entry.handedOff = true;
        if (projection.outputFile) entry.lastOutputFile = projection.outputFile;
        if (!live(state)) entry.terminalDelivered = true;
        return { result, text: this.render(result, projection), receipt };
      };
      const pending = entry.results.then(make, make); entry.results = pending.catch(() => {}); return await pending;
    } catch (error) {
      if (error instanceof ShellOperationError || options.signal?.aborted) throw error;
      throw new ShellOperationError("internal_error", `Shell output could not be prepared. ${errorText(error)}`, this.snapshot(entry), options.input);
    } finally { entry.observing--; }
  }
  private render(result: ShellSessionResult, projection: Projection): string {
    const status = "exit_code" in result ? `Exit code: ${result.exit_code ?? "unknown"}${result.signal ? `; signal: ${result.signal}` : ""}`
      : result.status === "stopping" ? "Cancellation requested; termination is not yet confirmed." : "Process continues.";
    let text = `Session: ${result.session_id} | Status: ${result.status} | ${status}\nWall time: ${result.wall_time_seconds.toFixed(3)} seconds | Observation: ${result.wake_reason} | Stdin: ${result.stdin_open ? "open" : "closed"}`;
    if (result.message) text += `\n${result.message}`;
    if (result.input) text += "\nInput accepted by the session. Application processing remains unconfirmed.";
    if ("cleanup" in result && result.cleanup.message) text += `\nCleanup: ${result.cleanup.state}. ${result.cleanup.message}`;
    text += `\n\n${projection.display.content || "(no new output)"}`;
    if (projection.display.truncated) {
      const shown = projection.display.lastLinePartial ? `Showing the UTF-8-safe suffix of line ${projection.display.endLine}`
        : `Showing lines ${projection.display.startLine}-${projection.display.endLine} of ${projection.display.totalLines} captured lines`;
      text += `\n\n[Output truncated. ${shown}; preview limit: 2000 lines or 50 KiB. Full output${live(result) ? " captured so far" : ""}: ${projection.outputFile}]\n[Read the saved file only if needed. Later waits return new output only.]`;
    }
    if (!projection.display.truncated && projection.outputFile) text += `\n\n[Full captured output: ${projection.outputFile}]`;
    return text;
  }
  async launch(input: BashInput, options: ObserveOptions = {}): Promise<ShellObservation> {
    const started = performance.now();
    options.signal?.throwIfAborted(); const entry = await this.start(input, undefined, options.onData);
    const abort = () => { if (!entry.handedOff) this.cancel(entry, "user_interrupt"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try { if (options.signal?.aborted) { abort(); options.signal.throwIfAborted(); } return await this.observe(entry, input.yield_time_ms ?? 10000, options, started); }
    finally { options.signal?.removeEventListener("abort", abort); }
  }
  async control(input: ShellControlRequest, options: ObserveOptions = {}): Promise<ShellObservation> {
    const started = performance.now();
    options.signal?.throwIfAborted();
    const request = input.action === "send"
      ? { action: "wait", session_id: input.session_id, chars: input.data, eof: input.eof, yield_time_ms: input.wait_ms }
      : "wait_ms" in input
        ? { action: "wait", session_id: input.session_id, yield_time_ms: input.wait_ms }
        : input;
    const entry = this.get(request.session_id);
    if (request.action === "stop") return this.observe(entry, this.cancel(entry, "stop") ? STOP_CONFIRM_MS : 0, options, started);
    const chars = "chars" in request ? request.chars : undefined;
    const eof = "eof" in request ? request.eof : undefined;
    const yieldTime = "yield_time_ms" in request ? request.yield_time_ms : undefined;
    const hasInput = (chars?.length ?? 0) > 0 || eof === true;
    if (hasInput) {
      if (entry.state.status !== "running") throw new ShellOperationError("process_exited", "Input was not sent; the process is finished or stopping.", this.snapshot(entry), "not_sent");
      if (eof === true && entry.mode === "pty") throw new ShellOperationError("eof_not_supported", "Input was not sent. eof is supported only for pipe sessions. PTY input uses terminal characters through chars.", this.snapshot(entry), "not_sent");
      if (!entry.state.stdin_open) throw new ShellOperationError("stdin_closed", "Input was not sent. This session's stdin is closed and cannot be reopened.", this.snapshot(entry), "not_sent");
      if (entry.writing) throw new ShellOperationError("observation_in_progress", "Another input delivery is still in progress.", this.snapshot(entry), "not_sent");
      entry.writing = true;
      try {
        if (entry.pty) {
          if (chars) entry.pty.write(chars);
        } else {
          const stream = entry.stdin;
          if (!stream || stream.destroyed || stream.writableEnded) throw new Error("stdin is closed during input delivery");
          await new Promise<void>((resolve, reject) => {
            let finished = false;
            const finish = (error?: Error | null) => { if (finished) return; finished = true; clearTimeout(timer); stream.removeListener("error", failed); stream.removeListener("close", closed); options.signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
            const failed = (error: Error) => finish(error);
            const closed = () => finish(new Error("stdin closed during input delivery"));
            const abort = () => { stream.destroy(); finish(new Error("input delivery interrupted")); };
            const timer = setTimeout(() => { stream.destroy(); finish(new Error("input delivery exceeded 5000 ms")); }, 5000);
            stream.once("error", failed); stream.once("close", closed); options.signal?.addEventListener("abort", abort, { once: true });
            const afterWrite = (error?: Error | null) => {
              if (error) { finish(error); return; }
              if (eof) stream.end(() => { if (entry.state.status === "running") entry.state = { ...entry.state, stdin_open: false }; finish(); });
              else finish();
            };
            if (chars) stream.write(chars, "utf8", afterWrite); else afterWrite();
            if (options.signal?.aborted) abort();
          });
        }
        if (entry.pty && entry.state.status === "running") entry.state = { ...entry.state, stdin_open: true };
      } catch (error) {
        if (entry.stdin) entry.stdin.destroy();
        if (entry.state.status === "running" && entry.mode === "pipe") entry.state = { ...entry.state, stdin_open: false };
        throw new ShellOperationError("stdin_write_failed", `Input delivery is unknown; do not resend automatically. ${errorText(error)}`, this.snapshot(entry), "unknown");
      } finally { entry.writing = false; }
      return this.observe(entry, yieldTime ?? 500, { ...options, input: "accepted" }, started);
    }
    if (entry.waiting) throw new ShellOperationError("observation_in_progress", "Another wait is observing this session. Input and stop remain available.", this.snapshot(entry));
    entry.waiting = true;
    try { return await this.observe(entry, yieldTime ?? 10000, options, started); }
    finally { entry.waiting = false; }
  }
  async stopAll(): Promise<void> {
    const active = [...this.entries.values()].filter(entry => live(entry.state));
    for (const entry of active) this.cancel(entry, "user_interrupt");
    await Promise.all(active.map(entry => this.pause(entry, STOP_CONFIRM_MS)));
    if (active.some(entry => live(entry.state))) throw new Error("Process tree cleanup unconfirmed. Inspect remaining shell sessions before continuing.");
  }
  async execute(command: string, signal?: AbortSignal, onUpdate?: Entry["onUpdate"], onData?: Entry["onData"]): Promise<ShellReceipt> {
    signal?.throwIfAborted(); const entry = await this.start({ command }, onUpdate, onData);
    entry.stdin?.end();
    const abort = () => { this.cancel(entry, "user_interrupt"); };
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    try { await entry.closed; if (entry.cleanupError) throw entry.cleanupError; entry.terminalDelivered = true; return { ...entry.receipt }; }
    finally { signal?.removeEventListener("abort", abort); }
  }
}
