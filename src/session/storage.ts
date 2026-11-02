import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { parseCheckpoint } from "../compaction/checkpoint.js";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { displayUserText } from "../context/mentions.js";

const leaseSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid(), sessionId: z.string(), createdAt: z.number() });

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function listArkSessions(home: string): Promise<SessionInfo[]> {
  const root = join(home, "sessions");
  let directories;
  try { directories = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return []; throw error; }
  const groups = await Promise.all(directories.filter((entry) => entry.isDirectory()).map((entry) => SessionManager.listAll(join(root, entry.name))));
  return groups.flat().sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function readLease(path: string): Promise<z.infer<typeof leaseSchema> | null> {
  try {
    const parsed = leaseSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export class SessionLease {
  private released = false;
  private constructor(
    readonly viewer: boolean,
    readonly sessionId: string,
    private readonly path: string,
    private readonly token: string,
    readonly viewerReason: string | null = null,
  ) {}

  static async acquire(sessionId: string): Promise<SessionLease> {
    const identity = sessionId;
    const directory = join(tmpdir(), "arkcode-session-locks");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${createHash("sha256").update(identity).digest("hex")}.json`);
    const token = randomUUID();
    const take = async (): Promise<boolean> => {
      let descriptor;
      try {
        descriptor = await open(path, "wx", 0o600);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
      }
      try {
        await descriptor.writeFile(JSON.stringify({ pid: process.pid, token, sessionId, createdAt: Date.now() }));
        await descriptor.sync();
      } catch (error) {
        await descriptor.close();
        await unlink(path).catch(() => {});
        throw error;
      }
      await descriptor.close();
      return true;
    };
    if (await take()) return new SessionLease(false, sessionId, path, token);
    const owner = await readLease(path);
    if (!owner) return new SessionLease(true, sessionId, path, token,
      `Session ownership is unconfirmed. Inspect ${path} after verifying that no ArkCode process owns this session. Incomplete lease files require manual recovery.`);
    if (processAlive(owner.pid)) return new SessionLease(true, sessionId, path, token);

    const recoveryPath = `${path}.recovery`;
    let recovery;
    try {
      recovery = await open(recoveryPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return new SessionLease(true, sessionId, path, token,
        `Session lock recovery is pending or interrupted. Inspect ${recoveryPath} after verifying that no ArkCode process owns or is recovering this session. Orphaned recovery files require manual removal.`);
      throw error;
    }
    try {
      const current = await readLease(path);
      if (current?.token === owner.token && !processAlive(current.pid)) {
        await unlink(path);
        if (await take()) return new SessionLease(false, sessionId, path, token);
      }
      return new SessionLease(true, sessionId, path, token);
    } finally {
      await recovery.close();
      await unlink(recoveryPath).catch(() => {});
    }
  }

  async release(): Promise<void> {
    if (this.released || this.viewer) return;
    this.released = true;
    const owner = await readLease(this.path);
    if (owner?.token === this.token) await unlink(this.path).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
}

const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("thinking"), thinking: z.string() }).passthrough(),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal("toolCall"), id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).passthrough(),
]);
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);
const timestamp = z.number().finite();
const usageSchema = z.object({
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }).passthrough(),
}).passthrough();
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: contentSchema, timestamp }).passthrough(),
  z.object({ role: z.literal("user"), content: contentSchema, timestamp }).passthrough(),
  z.object({ role: z.literal("assistant"), content: z.array(contentBlockSchema), api: z.string(), provider: z.string(), model: z.string(), usage: usageSchema, stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]), timestamp }).passthrough(),
  z.object({ role: z.literal("toolResult"), toolCallId: z.string(), toolName: z.string(), content: z.array(contentBlockSchema), isError: z.boolean(), timestamp }).passthrough(),
  z.object({ role: z.literal("custom"), customType: z.string(), content: contentSchema, display: z.boolean(), timestamp }).passthrough(),
  z.object({ role: z.literal("bashExecution"), command: z.string(), output: z.string(), cancelled: z.boolean(), truncated: z.boolean(), timestamp }).passthrough(),
  z.object({ role: z.literal("branchSummary"), summary: z.string(), fromId: z.string().nullable(), timestamp }).passthrough(),
  z.object({ role: z.literal("compactionSummary"), summary: z.string(), tokensBefore: z.number(), timestamp }).passthrough(),
]);
const headerSchema = z.object({ type: z.literal("session"), version: z.literal(3), id: z.string().min(1), cwd: z.string().min(1), timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))) }).passthrough();
const entryBase = { id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))) };
const entrySchema = z.discriminatedUnion("type", [
  z.object({ ...entryBase, type: z.literal("message"), message: messageSchema }).passthrough(),
  z.object({ ...entryBase, type: z.literal("model_change"), provider: z.string(), modelId: z.string() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("thinking_level_change"), thinkingLevel: z.string() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("usage"), kind: z.string(), provider: z.string(), model: z.string(), usage: usageSchema }).passthrough(),
  z.object({ ...entryBase, type: z.literal("compaction"), summary: z.string(), firstKeptEntryId: z.string(), tokensBefore: z.number() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("branch_summary"), summary: z.string(), fromId: z.string() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("custom"), customType: z.string() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("custom_message"), customType: z.string(), content: contentSchema, display: z.boolean() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("label"), targetId: z.string(), label: z.string().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("session_info"), name: z.string().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal("context_edit"), targetId: z.string(), replacement: z.object({ content: contentSchema }).nullable() }).passthrough(),
]);

export interface SessionInspection {
  id: string;
  cwd: string;
  entries: number;
  messages: number;
  interrupted: boolean;
  name?: string;
  lastMessage?: string;
  prompt?: string;
  model?: string;
}

export async function inspectSession(path: string, expectedCwd?: string): Promise<SessionInspection> {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error("Session exceeds the 64 MiB inspection limit.");
  const source = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const header = headerSchema.parse(JSON.parse(lines[0] ?? ""));
  if (expectedCwd) {
    const expected = await realpath(expectedCwd);
    const actual = await realpath(header.cwd);
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(actual) !== normalize(expected)) throw new Error("Session belongs to a different workspace.");
  }
  const ids = new Set<string>();
  const entries = new Map<string, z.infer<typeof entrySchema>>();
  const pendingTools = new Set<string>();
  let messages = 0;
  let interrupted = false;
  let name: string | undefined;
  let lastMessage: string | undefined;
  let prompt: string | undefined;
  let model: string | undefined;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line || Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error(`Invalid session line ${index + 1}.`);
    let entry: z.infer<typeof entrySchema>;
    try { entry = entrySchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid session line ${index + 1}. ${error instanceof Error ? error.message : String(error)}`); }
    if (ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error(`Invalid session tree at line ${index + 1}.`);
    ids.add(entry.id);
    if (entry.type === "compaction") parseCheckpoint(entry.details);
    entries.set(entry.id, entry);
    if (entry.type === "session_info") name = entry.name;
    if (entry.type === "message") {
      messages++;
    }
  }
  const branch: Array<z.infer<typeof entrySchema>> = [];
  let leaf = Array.from(entries.values()).at(-1);
  while (leaf) {
    branch.unshift(leaf);
    leaf = leaf.parentId === null ? undefined : entries.get(leaf.parentId);
  }
  for (const entry of branch) {
    if (entry.type === "model_change") model = `${entry.provider}/${entry.modelId}`;
    if (entry.type !== "message") continue;
    if (entry.message.role === "user" || entry.message.role === "assistant") {
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const value = entry.message.role === "user" ? displayUserText(text) : text;
      if (value) {
        lastMessage = value.slice(0, 2048);
        if (entry.message.role === "user" && !prompt) prompt = value.slice(0, 2048);
      }
      if (entry.message.role === "assistant") model = `${entry.message.provider}/${entry.message.model}`;
    }
    if (entry.message.role === "assistant") {
      interrupted = entry.message.stopReason === "aborted" || entry.message.stopReason === "pending";
      for (const block of entry.message.content) if (block.type === "toolCall") pendingTools.add(block.id);
    } else if (entry.message.role === "toolResult") pendingTools.delete(entry.message.toolCallId);
  }
  return { id: header.id, cwd: header.cwd, entries: ids.size, messages, interrupted: interrupted || pendingTools.size > 0,
    ...(name === undefined ? {} : { name }), ...(lastMessage ? { lastMessage } : {}), ...(prompt ? { prompt } : {}), ...(model ? { model } : {}) };
}

const runBase = { runId: z.string().min(1), startedAt: z.number().finite(), cwd: z.string().min(1).optional() };
export const runMarkerSchema = z.discriminatedUnion("status", [
  z.object({ ...runBase, status: z.literal("active"), pid: z.number().int().positive() }),
  z.object({ ...runBase, status: z.literal("completed"), endedAt: z.number().finite() }),
  z.object({ ...runBase, status: z.literal("failed"), endedAt: z.number().finite() }),
  z.object({ ...runBase, status: z.literal("interrupted"), endedAt: z.number().finite() }),
]);
export type RunMarker = z.infer<typeof runMarkerSchema>;

function markerPath(home: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(home, "runs", `${key}.json`);
}

export async function readRunMarker(home: string, sessionId: string): Promise<RunMarker | null> {
  try { return runMarkerSchema.parse(JSON.parse(await readFile(markerPath(home, sessionId), "utf8"))); }
  catch (error) { if (missing(error)) return null; throw error; }
}

export async function writeRunMarker(home: string, sessionId: string, marker: RunMarker): Promise<void> {
  const validated = runMarkerSchema.parse(marker);
  await mkdir(join(home, "runs"), { recursive: true });
  const path = markerPath(home, sessionId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
}

export async function recoverRunMarker(home: string, sessionId: string): Promise<RunMarker | null> {
  const marker = await readRunMarker(home, sessionId);
  if (!marker || marker.status !== "active" || processAlive(marker.pid)) return marker;
  const interrupted: RunMarker = { status: "interrupted", runId: marker.runId, startedAt: marker.startedAt, endedAt: Date.now(), ...(marker.cwd ? { cwd: marker.cwd } : {}) };
  await writeRunMarker(home, sessionId, interrupted);
  return interrupted;
}
