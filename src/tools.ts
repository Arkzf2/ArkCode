import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { minimatch } from "minimatch";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest } from "./domain.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".arkcode", "node_modules"]);

export function cleanOutput(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

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

  async execute(command: string, signal?: AbortSignal, onUpdate?: (receipt: ShellReceipt) => void): Promise<ShellReceipt> {
    signal?.throwIfAborted();
    const windows = process.platform === "win32";
    const args = windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${command}\n$arkcodeCommandSucceeded = $?; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $arkcodeCommandSucceeded) { exit 1 }`]
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

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function workspacePath(cwd: string, path: string, writing = false): Promise<string> {
  if (!path || path.includes("\0")) throw new Error("Invalid workspace path.");
  const root = await realpath(cwd);
  const target = resolve(root, path);
  if (!within(root, target)) throw new Error("File tools are limited to the workspace.");
  const segments = relative(root, target).split(/[\\/]/).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment === ".git" || segment === ".arkcode")) {
    throw new Error("Protected workspace metadata is unavailable to file tools.");
  }
  if (!writing && segments.some((segment) => segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example"))) {
    throw new Error("Credential files are unavailable to file tools.");
  }
  let ancestor = target;
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      if (!within(root, actual)) throw new Error("Symbolic link points outside the workspace.");
      const actualSegments = relative(root, actual).split(/[\\/]/).map((segment) => segment.toLowerCase());
      if (actualSegments.includes(".git") || actualSegments.includes(".arkcode")) {
        throw new Error("Symbolic link points to protected workspace metadata.");
      }
      if (!writing && actualSegments.some((segment) => segment === ".env" || (segment.startsWith(".env.") && segment !== ".env.example"))) {
        throw new Error("Symbolic link points to a credential file.");
      }
      return target;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function readText(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Expected a regular file.");
    if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 2 MiB text limit.");
    const buffer = await file.readFile();
    if (buffer.includes(0)) throw new Error("Binary file cannot be read as text.");
    return buffer.toString("utf8");
  } finally { await file.close(); }
}

function result(text: string, details: unknown = {}, isError = false): { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean } {
  return { content: [{ type: "text", text: cleanOutput(text) }], details, ...(isError ? { isError: true } : {}) };
}

function define<T extends TSchema>(
  name: string, description: string, parameters: T,
  execute: (id: string, params: Static<T>, signal?: AbortSignal, update?: (text: string) => void) => Promise<ReturnType<typeof result>>,
): ToolDefinition<T> {
  return {
    name, label: name, description, promptSnippet: description, parameters, executionMode: "sequential",
    async execute(id, params, signal, onUpdate) {
      return execute(id, params, signal, onUpdate ? (text) => onUpdate(result(text)) : undefined);
    },
  };
}

export function createTools(options: {
  cwd: string;
  authorize: (request: ApprovalRequest) => Promise<boolean>;
  shell: ManagedShell;
}): ToolDefinition[] {
  const { cwd, authorize, shell } = options;
  const check = async (id: string, tool: string, description: string, params: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const exactDescription = `${description}\nArguments:\n${JSON.stringify(params)}`;
    if (!await authorize({ id, tool, description: exactDescription, cwd })) throw new Error("Tool execution denied.");
    signal?.throwIfAborted();
  };
  const pathSchema = Type.Object({ path: Type.Optional(Type.String()) });
  const read = define("read", "Read workspace text files with one-based offset and bounded line count.", Type.Object({
    path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  }), async (id, params, signal) => {
    await check(id, "read", params.path, params, signal);
    const path = await workspacePath(cwd, params.path);
    const lines = (await readText(path)).split(/\r?\n/);
    const start = (params.offset ?? 1) - 1;
    const selected = lines.slice(start, start + (params.limit ?? 500));
    let text = selected.map((line, index) => `${start + index + 1}: ${line}`).join("\n");
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) text = Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n[Output truncated]";
    if (start + selected.length < lines.length) text += `\n[Continue with offset ${start + selected.length + 1}; ${lines.length} total lines]`;
    return result(text);
  });
  const write = define("write", "Create or overwrite a workspace text file.", Type.Object({ path: Type.String(), content: Type.String() }), async (id, params, signal) => {
    if (Buffer.byteLength(params.content) > MAX_FILE_BYTES) throw new Error("Content exceeds the 2 MiB text limit.");
    await workspacePath(cwd, params.path, true);
    await check(id, "write", `Write ${params.path}`, params, signal);
    const path = await workspacePath(cwd, params.path, true);
    await mkdir(dirname(path), { recursive: true });
    signal?.throwIfAborted();
    await workspacePath(cwd, params.path, true);
    await writeFile(path, params.content, "utf8");
    return result(`Wrote ${params.path}`);
  });
  const edit = define("edit", "Replace one exact, unique text occurrence in a workspace file.", Type.Object({
    path: Type.String(), oldText: Type.String({ minLength: 1 }), newText: Type.String(),
  }), async (id, params, signal) => {
    await workspacePath(cwd, params.path, true);
    await check(id, "edit", `Edit ${params.path}`, params, signal);
    const path = await workspacePath(cwd, params.path, true);
    const text = await readText(path);
    const index = text.indexOf(params.oldText);
    if (index < 0) throw new Error("oldText was not found. Read the file before editing.");
    if (text.indexOf(params.oldText, index + 1) >= 0) throw new Error("oldText matches more than once. Include more surrounding text.");
    const updated = text.slice(0, index) + params.newText + text.slice(index + params.oldText.length);
    if (Buffer.byteLength(updated) > MAX_FILE_BYTES) throw new Error("Updated file exceeds the 2 MiB text limit.");
    signal?.throwIfAborted();
    await workspacePath(cwd, params.path, true);
    await writeFile(path, updated, "utf8");
    return result(`Edited ${params.path}`);
  });
  const ls = define("ls", "List workspace directory entries.", pathSchema, async (id, params, signal) => {
    await check(id, "ls", params.path ?? ".", params, signal);
    const entries = await readdir(await workspacePath(cwd, params.path ?? "."), { withFileTypes: true });
    return result(entries.filter((entry) => !SKIP_DIRECTORIES.has(entry.name)).slice(0, 1000)
      .map((entry) => entry.name + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " [symlink]" : "")).join("\n"));
  });
  const collect = async (path: string, signal?: AbortSignal): Promise<string[]> => {
    const files: string[] = [];
    const visit = async (dir: string) => {
      signal?.throwIfAborted();
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (files.length >= 10000) return;
        if (SKIP_DIRECTORIES.has(entry.name) || entry.isSymbolicLink() || entry.name.startsWith(".env")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    const validated = await workspacePath(cwd, path);
    if ((await stat(validated)).isDirectory()) await visit(validated);
    else files.push(validated);
    return files;
  };
  const find = define("find", "Find workspace files by glob pattern, excluding dependency and metadata directories.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }), async (id, params, signal) => {
    await check(id, "find", params.pattern, params, signal);
    const files = await collect(params.path ?? ".", signal);
    const matches = files.map((path) => relative(cwd, path).split(sep).join("/"))
      .filter((path) => minimatch(path, params.pattern, { matchBase: true, dot: true, nocase: process.platform === "win32" }));
    return result(matches.slice(0, 500).join("\n") + (matches.length > 500 || files.length >= 10000 ? "\n[Search truncated]" : ""));
  });
  const grep = define("grep", "Search workspace text files using a regular expression; returns file and line locations.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), ignoreCase: Type.Optional(Type.Boolean()) }), async (id, params, signal) => {
    await check(id, "grep", params.pattern, params, signal);
    const pattern = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
    const files = await collect(params.path ?? ".", signal);
    const matches: string[] = [];
    let bytes = 0;
    let skipped = 0;
    for (const file of files) {
      signal?.throwIfAborted();
      let text: string;
      try { text = await readText(await workspacePath(cwd, file)); } catch { skipped++; continue; }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (!pattern.test(line)) continue;
        const match = `${relative(cwd, file)}:${index + 1}: ${line}`;
        matches.push(match);
        bytes += Buffer.byteLength(match);
        if (matches.length >= 500 || bytes >= MAX_OUTPUT_BYTES) return result(matches.join("\n") + "\n[Search truncated]");
      }
    }
    return result(matches.join("\n") + (skipped ? `\n[Skipped ${skipped} binary, large, protected or unreadable files]` : "") + (files.length >= 10000 ? "\n[File traversal truncated]" : ""));
  });
  const bash = define("bash", `Run a command in ${shell.executable}. This is an unsandboxed native shell, not necessarily Bash.`, Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })) }), async (id, params, signal, update) => {
    await check(id, "bash", `${shell.executable}\n${params.command}`, params, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = params.timeout ? setTimeout(abort, params.timeout * 1000) : undefined;
    try {
      const receipt = await shell.execute(params.command, controller.signal, (value) => update?.(value.output));
      const text = `${receipt.output}\n[${receipt.status}; exit code ${receipt.exitCode ?? "unknown"}${receipt.truncated ? "; output truncated" : ""}]`;
      return result(text, receipt, receipt.status !== "completed");
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  });
  return [read, write, edit, grep, find, ls, bash];
}
