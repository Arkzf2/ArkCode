import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
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

export class InstructionsLoader {
  private global: Extract<Instruction, { kind: "global" }> | undefined;
  private warnings = new Set<string>();

  constructor(private options: {
    cwd: string; home: string; trusted: boolean; projectDocMaxBytes: number; onWarning: (message: string) => void;
  }) {}

  async load(signal?: AbortSignal): Promise<Instruction[]> {
    signal?.throwIfAborted();
    const warnings = new Set<string>();
    const warn = (message: string) => warnings.add(message);
    const globalPath = join(this.options.home, "AGENTS.md");
    try {
      const info = await metadata(globalPath);
      const content = info?.isFile() ? (await readFile(globalPath, { encoding: "utf8", signal })).trim() : "";
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
    const cwd = resolve(this.options.cwd);
    const ancestors: string[] = [];
    let directory = cwd;
    while (true) {
      signal?.throwIfAborted();
      ancestors.unshift(directory);
      try { if (await metadata(join(directory, ".git"))) break; }
      catch { /* An unreadable parent marker must not hide workspace instructions. */ }
      const parent = dirname(directory);
      if (parent === directory) { ancestors.splice(0, ancestors.length, cwd); break; }
      directory = parent;
    }

    let remaining = this.options.projectDocMaxBytes;
    const files: Instruction[] = [];
    const read = async (directory: string, scope = directory) => {
      signal?.throwIfAborted();
      const path = join(directory, "AGENTS.md");
      if (this.global && resolve(path) === resolve(this.global.path)) return;
      if (!(await metadata(path))?.isFile()) return;
      let file;
      try { file = await open(path, "r"); }
      catch (error) { if (missing(error)) return; throw error; }
      try {
        const info = await file.stat();
        if (!info.isFile()) return;
        const buffer = Buffer.alloc(Math.min(remaining + 1, info.size));
        let count = 0;
        while (count < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
          if (bytesRead === 0) break;
          count += bytesRead;
        }
        const used = Math.min(count, remaining);
        const content = buffer.subarray(0, used).toString("utf8");
        if (count > remaining) warn(`Project instructions at ${path} exceed the remaining ${remaining}-byte budget; truncating.`);
        if (content.trim()) {
          files.push({ kind: "project", path, scope, content });
          remaining -= used;
        }
      } finally { await file.close(); }
    };
    for (const ancestor of ancestors) {
      if (remaining === 0) return files;
      try { await read(ancestor); }
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
      try { canonical = await realpath(current); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (current !== cwd) {
        if (visited.has(canonical) || !within(root, canonical)) continue;
        if (relative(root, canonical).split(sep).some(gitDirectory)) continue;
        visited.add(canonical);
        try { await read(current, canonical); }
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
    return files;
  }
}
