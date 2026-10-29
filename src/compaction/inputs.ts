import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { displayUserText } from "../context/mentions.js";
import { latestCheckpoint } from "./checkpoint.js";
import type { RetainedUser } from "./policy.js";

export const INPUT_ENTRY = "arkcode-input";
const imageSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict();
const inputSchema = z.object({ kind: z.literal("input"), inputId: z.string(), rawText: z.string(), preparedText: z.string(),
  images: z.array(imageSchema), delivery: z.enum(["prompt", "steering", "follow-up", "task-command"]), timestamp: z.number().finite(),
}).strict();
const eventSchema = z.discriminatedUnion("kind", [inputSchema,
  z.object({ kind: z.literal("bound"), inputId: z.string(), entryId: z.string() }).strict(),
  z.object({ kind: z.literal("delivered"), inputId: z.string() }).strict(),
  z.object({ kind: z.literal("withdrawn"), inputId: z.string() }).strict(),
]);
type Input = z.infer<typeof inputSchema> & { capturedAt: string; entryId?: string; delivered: boolean; withdrawn: boolean };
function messageText(message: Extract<AgentSession["messages"][number], { role: "user" }>): string {
  return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

export class InputJournal {
  constructor(private manager: SessionManager) {}
  capture(input: { rawText: string; preparedText: string; images?: ImageContent[]; delivery: Input["delivery"] }): string {
    const inputId = randomUUID();
    this.manager.appendCustomEntry(INPUT_ENTRY, inputSchema.parse({ ...input, kind: "input", inputId, images: input.images ?? [], timestamp: Date.now() }));
    return inputId;
  }
  private read(): Input[] {
    const inputs = new Map<string, Input>();
    for (const entry of this.manager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== INPUT_ENTRY) continue;
      const event = eventSchema.parse(entry.data);
      if (event.kind === "input") { inputs.set(event.inputId, { ...event, capturedAt: entry.id, delivered: false, withdrawn: false }); continue; }
      const input = inputs.get(event.inputId);
      if (!input) throw new Error(`Missing source input ${event.inputId}.`);
      if (event.kind === "bound") input.entryId = event.entryId;
      else if (event.kind === "delivered") input.delivered = true;
      else input.withdrawn = true;
    }
    return [...inputs.values()];
  }
  bind(): void {
    const inputs = this.read();
    const bound = new Set(inputs.flatMap((input) => input.entryId ? [input.entryId] : []));
    const captured = new Set<string>();
    for (const entry of this.manager.getBranch()) {
      captured.add(entry.id);
      if (entry.type !== "message" || entry.message.role !== "user" || bound.has(entry.id)) continue;
      const text = messageText(entry.message);
      const input = inputs.find((input) => captured.has(input.capturedAt) && !input.entryId && !input.withdrawn
        && (text === input.preparedText || text.startsWith(input.preparedText + "\n\n")));
      if (!input) continue;
      input.entryId = entry.id;
      bound.add(entry.id);
      this.manager.appendCustomEntry(INPUT_ENTRY, { kind: "bound", inputId: input.inputId, entryId: entry.id });
    }
  }
  markDelivered(entryIds: Set<string>): void {
    this.bind();
    for (const input of this.read()) {
      if (!input.delivered && !input.withdrawn && input.entryId && entryIds.has(input.entryId))
        this.manager.appendCustomEntry(INPUT_ENTRY, { kind: "delivered", inputId: input.inputId });
    }
  }
  withdraw(preparedTexts: readonly string[]): void {
    const inputs = this.read();
    for (const text of preparedTexts) {
      const input = inputs.findLast((input) => !input.delivered && !input.withdrawn && input.preparedText === text);
      if (input) { input.withdrawn = true; this.manager.appendCustomEntry(INPUT_ENTRY, { kind: "withdrawn", inputId: input.inputId }); }
    }
  }
  withdrawUnbound(): void {
    this.bind();
    for (const input of this.read()) if (!input.entryId && !input.delivered && !input.withdrawn)
      this.manager.appendCustomEntry(INPUT_ENTRY, { kind: "withdrawn", inputId: input.inputId });
  }
  restorePending(): string[] {
    this.bind();
    const restored: string[] = [];
    for (const input of this.read()) {
      if (input.entryId || input.delivered || input.withdrawn) continue;
      const entryId = this.manager.appendMessage({ role: "user", content: [{ type: "text", text: input.preparedText }, ...input.images], timestamp: input.timestamp });
      this.manager.appendCustomEntry(INPUT_ENTRY, { kind: "bound", inputId: input.inputId, entryId });
      restored.push(input.rawText);
    }
    return restored;
  }
  snapshot() {
    this.bind();
    const checkpoint = latestCheckpoint(this.manager);
    const inputs = this.read();
    const byEntry = new Map(inputs.flatMap((input) => input.entryId ? [[input.entryId, input] as const] : []));
    const users: RetainedUser[] = [...(checkpoint?.checkpoint.retainedUsers ?? [])];
    const pendingEntryIds: string[] = [];
    const active = this.manager.buildSessionProjection().entries;
    let legacy = false;
    for (const projected of active) {
      if (projected.sourceEntry.type !== "message") continue;
      const message = projected.messages.find((message) => message.role === "user");
      if (message?.role !== "user") continue;
      const entryId = projected.sourceEntry.id;
      const input = byEntry.get(entryId);
      if (input?.withdrawn) continue;
      if (input && !input.delivered) { pendingEntryIds.push(entryId); continue; }
      const text = input ? input.rawText : displayUserText(messageText(message));
      const originalLength = Array.from(text).length;
      if (!originalLength) continue;
      legacy ||= !input;
      users.push({ inputId: input?.inputId ?? `legacy:${entryId}`, entryId, origin: input ? "human" : "legacy",
        delivery: input?.delivery ?? "prompt", timestamp: message.timestamp, originalLength,
        fragments: [{ start: 0, end: originalLength, text }],
      });
    }
    return { users, pendingEntryIds, deliveredInputIds: inputs.filter((input) => input.delivered && !input.withdrawn).map((input) => input.inputId), legacy };
  }
}
