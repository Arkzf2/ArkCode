import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

type Message = AgentSession["messages"][number];
export const USER_TEXT_BUDGET = 20_000;
export const USER_TEXT_MARKER = "\n[... user text omitted ...]\n";
export const TOOL_PRUNING_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

export interface RetainedUser {
  inputId: string;
  entryId: string;
  origin: "human" | "legacy";
  delivery: "prompt" | "steering" | "follow-up" | "task-command";
  timestamp: number;
  originalLength: number;
  omissionMarker?: "…";
  fragments: Array<{ start: number; end: number; text: string }>;
}

export class CompactionError extends Error {
  constructor(readonly code: "budget-insufficient" | "overflow" | "invalid-summary" | "conflict" | "activation" | "cancelled", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompactionError";
  }
}

export function textTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 4); }

const outputFields = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
function outputOverrides(model: Model<Api>) {
  if (!["openai-completions", "openai-responses", "azure-openai-responses"].includes(model.api)) return [];
  return [model.samplingParams, ...Object.values(model.samplingParamsByThinkingLevel ?? {})]
    .flatMap((parameters) => outputFields.flatMap((key) => parameters && key in parameters ? [{ key, value: parameters[key] }] : []));
}
export function summarySampling(model: Model<Api>, output: number): Record<string, number> {
  return Object.fromEntries(outputOverrides(model).map(({ key }) => [key, output]));
}

export function requestBudget(model: Model<Api>, output?: number) {
  if (output === undefined) {
    output = model.maxTokens;
    for (const { key, value } of outputOverrides(model)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        throw new CompactionError("budget-insufficient", `The configured ${key} must be a positive output token limit.`);
      output = Math.max(output, value);
    }
  }
  const window = model.contextWindow;
  if (!Number.isFinite(window) || window <= 0 || !Number.isFinite(output) || output <= 0 || output >= window)
    throw new CompactionError("budget-insufficient", "The model must declare a context window and a usable output limit before compacting.");
  const input = window - output;
  const reserve = window >= 200_000 ? 50_000 : 25_000;
  const threshold = Math.floor(Math.min(input * 0.9, input - reserve));
  if (threshold <= 0) throw new CompactionError("budget-insufficient", `The model cannot accommodate the configured ${reserve / 1000}k input reserve. Select a larger-context model.`);
  return { window, output, input, threshold, measurement: "estimate" as const };
}

export function estimateMessages(messages: readonly Message[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += 6;
    if (message.role === "branchSummary" || message.role === "compactionSummary") { tokens += textTokens(message.summary); continue; }
    if (message.role === "bashExecution") { tokens += textTokens(message.command + "\n" + message.output); continue; }
    const content = message.content;
    if (typeof content === "string") tokens += textTokens(content);
    else for (const block of content) {
      if (block.type === "text") tokens += textTokens(block.text);
      else if (block.type === "thinking") tokens += textTokens(block.thinking);
      else if (block.type === "toolCall") tokens += textTokens(block.name + JSON.stringify(block.arguments));
      else if (block.type === "image") tokens += 1200;
    }
    if (message.role === "system") {
      tokens += textTokens(JSON.stringify(message.sections ?? {}));
      tokens += textTokens(JSON.stringify(message.toolsAdded ?? []));
      tokens += textTokens(JSON.stringify(message.toolsRemoved ?? []));
    } else if (message.role === "toolResult") tokens += textTokens(message.toolName + message.toolCallId);
  }
  return tokens;
}

export function renderUser(user: RetainedUser): string {
  const marker = user.omissionMarker ?? USER_TEXT_MARKER;
  const parts: string[] = [];
  let end = 0;
  for (const fragment of user.fragments) {
    if (fragment.start > end) parts.push(marker);
    parts.push(fragment.text);
    end = fragment.end;
  }
  if (end < user.originalLength) parts.push(marker);
  return parts.join("");
}

function sliceFragments(user: RetainedUser, head: number, tail: number): RetainedUser {
  const length = user.fragments.reduce((sum, fragment) => sum + fragment.end - fragment.start, 0);
  const fragments: RetainedUser["fragments"] = [];
  let offset = 0;
  for (const fragment of user.fragments) {
    const chars = Array.from(fragment.text);
    const ranges: Array<[number, number]> = [[0, head], [length - tail, length]];
    for (const [start, stop] of ranges) {
      const from = Math.max(0, start - offset), to = Math.min(chars.length, stop - offset);
      if (to > from) fragments.push({ start: fragment.start + from, end: fragment.start + to, text: chars.slice(from, to).join("") });
    }
    offset += chars.length;
  }
  return { ...user, fragments };
}

export function retainUsers(users: readonly RetainedUser[], budget = USER_TEXT_BUDGET): RetainedUser[] {
  const kept: RetainedUser[] = [];
  for (let index = users.length - 1; index >= 0; index--) {
    const user = users[index];
    if (!user || !user.fragments.some((fragment) => fragment.text.length)) continue;
    const cost = textTokens(renderUser(user));
    if (cost <= budget) { kept.unshift(user); budget -= cost; continue; }
    const boundary = budget < textTokens(USER_TEXT_MARKER) + 1 ? { ...user, omissionMarker: "…" as const } : user;
    const chars = boundary.fragments.flatMap((fragment) => Array.from(fragment.text));
    const lengths = chars.map((char) => Buffer.byteLength(char, "utf8"));
    const candidateFor = (tokens: number) => {
      let head = 0, tail = 0, bytes = 0;
      const headBytes = Math.ceil(tokens / 2) * 4, tailBytes = Math.floor(tokens / 2) * 4;
      while (head < lengths.length && bytes + (lengths[head] ?? 0) <= headBytes) bytes += lengths[head++] ?? 0;
      bytes = 0;
      while (tail < lengths.length - head && bytes + (lengths[lengths.length - tail - 1] ?? 0) <= tailBytes) bytes += lengths[lengths.length - ++tail] ?? 0;
      return sliceFragments(boundary, head, tail);
    };
    let low = 0, high = budget;
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      const candidate = candidateFor(size);
      if (textTokens(renderUser(candidate)) <= budget) low = size; else high = size - 1;
    }
    const candidate = candidateFor(low);
    if (candidate.fragments.length) kept.unshift(candidate);
    break;
  }
  return kept;
}

export function pruneToolResults(messages: readonly Message[]): { messages: Message[]; pruned: number } {
  let pruned = 0;
  const result = messages.map((message): Message => {
    if (message.role !== "toolResult") return message;
    const length = message.content.reduce((sum, block) => sum + (block.type === "text" ? Array.from(block.text).length : 0), 0);
    if (length <= 8192) return message;
    let offset = 0, marked = false;
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      const chars = Array.from(block.text);
      const start = offset;
      offset += chars.length;
      const head = chars.slice(0, Math.max(0, 4096 - start)).join("");
      const tail = chars.slice(Math.max(0, length - 1024 - start)).join("");
      const removed = Math.max(start, 4096) < Math.min(offset, length - 1024);
      const marker = removed && !marked ? TOOL_PRUNING_MARKER : "";
      if (removed) marked = true;
      return { ...block, text: head + marker + tail };
    });
    pruned++;
    return { ...message, content };
  });
  return { messages: result, pruned };
}

export function assertClosedTools(messages: readonly Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new CompactionError("conflict", `Tool result ${message.toolCallId} has no matching call.`);
    }
  }
  if (pending.size) throw new CompactionError("conflict", "Compaction must wait until all tool results have been collected.");
}
