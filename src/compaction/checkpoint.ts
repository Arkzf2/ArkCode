import { z } from "zod";
import type { AgentSession, SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";
import { toolModeSchema } from "../tools/mode.js";

export const retainedUserSchema = z.object({
  inputId: z.string().min(1), entryId: z.string().min(1), origin: z.enum(["human", "legacy"]),
  delivery: z.enum(["prompt", "steering", "follow-up", "task-command"]), timestamp: z.number().finite(),
  originalLength: z.number().int().nonnegative(),
  omissionMarker: z.literal("…").optional(),
  fragments: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), text: z.string() }).strict()),
}).strict().superRefine((user, ctx) => {
  let end = 0;
  for (const fragment of user.fragments) {
    if (fragment.start < end || fragment.end > user.originalLength || fragment.end <= fragment.start || Array.from(fragment.text).length !== fragment.end - fragment.start)
      ctx.addIssue({ code: "custom", message: "Invalid retained user source range." });
    end = fragment.end;
  }
});
export const toolSettingsSnapshotSchema = z.object({
  version: z.literal(1), toolMode: toolModeSchema,
  mcp: z.array(z.object({ key: z.string(), exposure: z.enum(["direct", "codemode", "deferred", "hidden"]),
    toolExposure: z.record(z.string(), z.enum(["direct", "codemode", "deferred", "hidden"])).optional(),
  }).strict()),
}).strict();

const textContent = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough())]);
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: textContent, timestamp: z.number().finite(),
    sections: z.record(z.string(), z.string().nullable()).optional(),
    toolsAdded: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }).passthrough()).optional(),
    toolsRemoved: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  }).passthrough(),
  z.object({ role: z.literal("user"), content: textContent, timestamp: z.number().finite() }).passthrough(),
  z.object({ role: z.literal("custom"), customType: z.string(), content: textContent, timestamp: z.number().finite(), display: z.literal(false), details: z.unknown().optional() }).passthrough(),
]);
export const checkpointSchema = z.object({
  version: z.literal(1), kind: z.enum(["summary", "refresh"]), id: z.string().min(1), cutoff: z.string().nullable(),
  summary: z.string().trim().min(1), replacementMessages: z.array(messageSchema).min(1),
  retainedUsers: z.array(retainedUserSchema), pendingEntryIds: z.array(z.string()), deliveredInputIds: z.array(z.string()),
  contextBaseline: z.unknown(), toolSettings: toolSettingsSnapshotSchema,
  model: z.object({ provider: z.string(), id: z.string() }), reason: z.enum(["manual", "threshold", "overflow"]),
  budget: z.object({ window: z.number().positive(), input: z.number().positive(), output: z.number().positive(), threshold: z.number().positive(), measurement: z.literal("estimate") }),
  tokensBefore: z.number().nonnegative(), tokensAfter: z.number().nonnegative(), prunedResults: z.number().int().nonnegative(),
}).strict();
type StoredCheckpoint = z.infer<typeof checkpointSchema>;
type ReplacementMessage = Extract<AgentSession["messages"][number], { role: "system" | "user" | "custom" }>;
export type Checkpoint = Omit<StoredCheckpoint, "replacementMessages"> & { replacementMessages: ReplacementMessage[] };

export function parseCheckpoint(details: unknown): Checkpoint | undefined {
  const wrapper = z.object({ arkcode: z.unknown() }).safeParse(details);
  if (!wrapper.success || wrapper.data.arkcode === undefined) return undefined;
  const checkpoint = checkpointSchema.parse(wrapper.data.arkcode);
  // Serialized TypeBox tool schemas have no runtime symbols. Validate their JSON fields above before restoring the SDK type.
  return { ...checkpoint, replacementMessages: checkpoint.replacementMessages as ReplacementMessage[] };
}

export function latestCheckpoint(manager: Pick<SessionManager, "getBranch">): { entry: Extract<SessionEntry, { type: "compaction" }>; checkpoint: Checkpoint } | undefined {
  for (const entry of manager.getBranch().toReversed()) {
    if (entry.type !== "compaction") continue;
    const checkpoint = parseCheckpoint(entry.details);
    if (checkpoint) return { entry, checkpoint };
    return undefined;
  }
  return undefined;
}
