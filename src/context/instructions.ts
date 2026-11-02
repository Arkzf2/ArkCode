import type { Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const instructionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global"), path: z.string(), content: z.string() }),
  z.object({ kind: z.literal("project"), path: z.string(), scope: z.string(), content: z.string() }),
]);
type Instruction = z.infer<typeof instructionSchema>;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function metadata(path: string) {
  try { return await stat(path); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function gitDirectory(name: string): boolean {
  return (process.platform === "win32" ? name.toLowerCase() : name) === ".git";
}

function signature(info: Stats | undefined): string {
  return info ? [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(":") : "missing";
}

type Scope = { directory: string; scope: string };
type Discovery = { scopes: Scope[]; observations: Map<string, string>; complete: boolean };

export class InstructionsLoader {
  private global: Extract<Instruction, { kind: "global" }> | undefined;
  private warnings = new Set<string>();
  private contents = new Map<string, { signature: string; bytes: Buffer }>();
  private discovery: Discovery | undefined;

  constructor(private options: {
    cwd: string; home: string; trusted: boolean; projectDocMaxBytes: number; onWarning: (message: string) => void;
  }) {}

  invalidate(): void {
    this.discovery = undefined;
    this.contents.clear();
  }

  private async readContent(path: string, limit: number | undefined, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const info = await metadata(path);
    if (!info?.isFile()) { this.contents.delete(path); return Buffer.alloc(0); }
    const length = Math.min(info.size, limit === undefined ? info.size : limit + 1);
    const cached = this.contents.get(path);
    if (cached?.signature === signature(info) && cached.bytes.length >= length) return cached.bytes.subarray(0, length);
    const file = await open(path, "r");
    try {
      const actual = await file.stat();
      if (!actual.isFile()) return Buffer.alloc(0);
      const buffer = Buffer.alloc(Math.min(actual.size, limit === undefined ? actual.size : limit + 1));
      let count = 0;
      while (count < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
      const bytes = buffer.subarray(0, count);
      signal?.throwIfAborted();
      if (signature(actual) === signature(await file.stat())) this.contents.set(path, { signature: signature(actual), bytes });
      else this.contents.delete(path);
      return bytes;
    } finally { await file.close(); }
  }

  async load(signal?: AbortSignal): Promise<Instruction[]> {
    signal?.throwIfAborted();
    const warnings = new Set<string>();
    const warn = (message: string) => warnings.add(message);
    const globalPath = join(this.options.home, "AGENTS.md");
    try {
      const content = (await this.readContent(globalPath, undefined, signal)).toString("utf8").trim();
      this.global = content ? { kind: "global", path: globalPath, content } : undefined;
    } catch (error) {
      signal?.throwIfAborted();
      if (missing(error)) this.global = undefined;
      else warn(`Cannot read global instructions at ${globalPath}; retaining the last successful value. ${String(error)}`);
    }
    let project: Instruction[] = [];
    if (this.options.trusted && this.options.projectDocMaxBytes > 0) {
      try { project = await this.loadProject(warn, signal); }
      catch (error) {
        signal?.throwIfAborted();
        warn(`Cannot load project instructions for ${this.options.cwd}; project instructions are omitted. ${String(error)}`);
      }
    }
    signal?.throwIfAborted();
    for (const warning of warnings) if (!this.warnings.has(warning)) this.options.onWarning(warning);
    this.warnings = warnings;
    return this.global ? [this.global, ...project] : project;
  }

  private async loadProject(warn: (message: string) => void, signal?: AbortSignal): Promise<Instruction[]> {
    let remaining = this.options.projectDocMaxBytes;
    const files: Instruction[] = [];
    const read = async (directory: string, scope = directory) => {
      signal?.throwIfAborted();
      const path = join(directory, "AGENTS.md");
      if (this.global && resolve(path) === resolve(this.global.path)) return;
      const buffer = await this.readContent(path, remaining, signal);
      const used = Math.min(buffer.length, remaining);
      const content = buffer.subarray(0, used).toString("utf8");
      if (buffer.length > remaining) warn(`Project instructions at ${path} exceed the remaining ${remaining}-byte budget; truncating.`);
      if (content.trim()) {
        files.push({ kind: "project", path, scope, content });
        remaining -= used;
      }
    };
    const cached = this.discovery;
    if (cached) {
      let valid = true;
      for (const [path, value] of cached.observations) {
        signal?.throwIfAborted();
        if (signature(await metadata(path)) !== value) { valid = false; break; }
      }
      if (valid) {
        for (const { directory, scope } of cached.scopes) {
          if (!remaining) break;
          try { await read(directory, scope); }
          catch (error) { if (!missing(error)) throw error; }
        }
        if (cached.complete || !remaining) return files;
        files.length = 0;
        remaining = this.options.projectDocMaxBytes;
      }
    }
    this.discovery = undefined;
    const discovery: Discovery = { scopes: [], observations: new Map(), complete: false };
    const observe = async (path: string) => {
      const info = await metadata(path);
      discovery.observations.set(path, signature(info));
      return info;
    };
    const visit = async (directory: string, scope = directory) => {
      await observe(directory);
      discovery.scopes.push({ directory, scope });
      await read(directory, scope);
    };
    const finish = (complete: boolean) => {
      signal?.throwIfAborted();
      discovery.complete = complete;
      this.discovery = discovery;
      const paths = new Set([join(this.options.home, "AGENTS.md"), ...discovery.scopes.map(({ directory }) => join(directory, "AGENTS.md"))]);
      for (const path of this.contents.keys()) if (!paths.has(path)) this.contents.delete(path);
      return files;
    };
    const cwd = resolve(this.options.cwd);
    const ancestors: string[] = [];
    let directory = cwd;
    while (true) {
      signal?.throwIfAborted();
      ancestors.unshift(directory);
      try { if (await observe(join(directory, ".git"))) break; }
      catch { /* An unreadable parent marker must not hide workspace instructions. */ }
      const parent = dirname(directory);
      if (parent === directory) { ancestors.splice(0, ancestors.length, cwd); break; }
      directory = parent;
    }

    for (const ancestor of ancestors) {
      if (remaining === 0) return finish(false);
      try { await visit(ancestor); }
      catch (error) { if (!missing(error)) throw error; }
    }

    const root = await realpath(cwd);
    const visited = new Set<string>([root]);
    const pending = [cwd];
    while (pending.length && remaining > 0) {
      signal?.throwIfAborted();
      const current = pending.pop();
      if (!current) continue;
      let canonical: string;
      try { await observe(current); canonical = await realpath(current); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (current !== cwd) {
        if (visited.has(canonical) || !within(root, canonical)) continue;
        if (relative(root, canonical).split(sep).some(gitDirectory)) continue;
        visited.add(canonical);
        try { await visit(current, canonical); }
        catch (error) { if (!missing(error)) throw error; }
      }
      if (remaining === 0) break;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); }
      catch (error) { if (missing(error)) continue; throw error; }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries.reverse()) {
        if (gitDirectory(entry.name)) continue;
        const path = join(current, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink() && (await metadata(path))?.isDirectory()) pending.push(path);
      }
    }
    return finish(pending.length === 0 && remaining > 0);
  }
}
