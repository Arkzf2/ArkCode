import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cleanOutput } from "./output.js";

const MAX_OUTPUT_BYTES = 128 * 1024;

export interface ShellReceipt {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

interface RunningShell {
  stop(): void;
  closed: Promise<void>;
}

export class ManagedShell {
  readonly executable: string;
  private readonly receipts: ShellReceipt[] = [];
  private readonly running = new Map<string, RunningShell>();

  constructor(readonly cwd: string, executable?: string) {
    this.executable = executable ?? (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  }

  list(): ShellReceipt[] {
    return this.receipts.map((receipt) => ({ ...receipt }));
  }

  async stopAll(): Promise<void> {
    const current = [...this.running.values()];
    current.forEach((entry) => entry.stop());
    await Promise.all(current.map((entry) => entry.closed));
  }

  async execute(command: string, signal?: AbortSignal, onUpdate?: (receipt: ShellReceipt) => void, onData?: (data: Buffer) => void): Promise<ShellReceipt> {
    signal?.throwIfAborted();
    const windows = process.platform === "win32";
    const args = windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n${command}\n$arkcodeCommandSucceeded = $?; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $arkcodeCommandSucceeded) { exit 1 }`]
      : ["-c", command];
    const child = spawn(this.executable, args, {
      cwd: this.cwd, shell: false, windowsHide: true, detached: !windows, stdio: ["ignore", "pipe", "pipe"],
    });
    const receipt: ShellReceipt = {
      id: randomUUID(), command, cwd: this.cwd, shell: this.executable, pid: child.pid ?? null,
      startedAt: Date.now(), endedAt: null, status: "running", exitCode: null, output: "", truncated: false,
    };
    this.receipts.push(receipt);
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let treeTermination: Promise<Error | null> | undefined;
    let resolveClosed: () => void = () => {};
    let rejectClosed: (error: Error) => void = () => {};
    const closed = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveClosed = resolvePromise;
      rejectClosed = rejectPromise;
    });
    const append = (text: string) => {
      const cleaned = cleanOutput(text);
      onData?.(Buffer.from(cleaned));
      const room = MAX_OUTPUT_BYTES - Buffer.byteLength(receipt.output);
      if (Buffer.byteLength(cleaned) > room) receipt.truncated = true;
      if (room > 0) {
        let fragment = Buffer.from(cleaned).subarray(0, room).toString("utf8");
        while (Buffer.byteLength(fragment) > room) fragment = fragment.slice(0, -1);
        receipt.output += fragment;
      }
      onUpdate?.({ ...receipt });
    };
    const stop = () => {
      if (cancelled || receipt.status !== "running") return;
      cancelled = true;
      if (!child.pid) return;
      if (windows) {
        const pid = child.pid;
        treeTermination = new Promise((resolveTermination) => {
          execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
            if (error) {
              const failure = new Error(`Process tree cleanup unconfirmed: ${error.message}`);
              append(failure.message);
              rejectClosed(failure);
              resolveTermination(failure);
            } else resolveTermination(null);
          });
        });
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
            rejectClosed(new Error(`Process group cleanup unconfirmed: ${String(error)}`));
          }
        }
        killTimer = setTimeout(() => {
          if (!child.pid) return;
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
              rejectClosed(new Error(`Process group cleanup unconfirmed: ${String(error)}`));
            }
          }
        }, 1000);
      }
    };
    this.running.set(receipt.id, { stop, closed });
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => append(error.message));
    child.on("close", async (code) => {
      const cleanupError = await treeTermination;
      if (cancelled && !windows && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
            rejectClosed(new Error(`Process group cleanup unconfirmed: ${String(error)}`));
          }
        }
      }
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      receipt.exitCode = code;
      receipt.endedAt = Date.now();
      receipt.status = cleanupError ? "failed" : cancelled ? "cancelled" : code === 0 ? "completed" : "failed";
      this.running.delete(receipt.id);
      onUpdate?.({ ...receipt });
      if (cleanupError) rejectClosed(cleanupError);
      else resolveClosed();
    });
    if (signal?.aborted) stop();
    await closed;
    return { ...receipt };
  }
}
