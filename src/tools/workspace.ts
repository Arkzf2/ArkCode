import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".arkcode", "node_modules"]);

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

export async function readBuffer(cwd: string, path: string, writing = false, images = false): Promise<Buffer> {
  const guarded = await workspacePath(cwd, path, writing);
  const file = await open(guarded, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Expected a regular file.");
    if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 2 MiB limit.");
    const buffer = await file.readFile();
    if (buffer.includes(0) && !(images && await detectSupportedImageMimeTypeFromFile(guarded))) {
      throw new Error("Binary file cannot be read as text.");
    }
    return buffer;
  } finally { await file.close(); }
}

export async function collect(cwd: string, path: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string) => {
    signal?.throwIfAborted();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= 10000) throw new Error("File traversal exceeded 10000 files. Narrow the search path before retrying.");
      const name = entry.name.toLowerCase();
      if (SKIP_DIRECTORIES.has(name) || entry.isSymbolicLink() || name.startsWith(".env")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(await workspacePath(cwd, full));
    }
  };
  const validated = await workspacePath(cwd, path);
  if ((await stat(validated)).isDirectory()) await visit(validated);
  else files.push(validated);
  return files;
}
