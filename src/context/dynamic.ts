import { release, type as osType } from "node:os";
import { z } from "zod";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { InstructionsLoader, instructionSchema } from "./instructions.js";
import { getBranch } from "../ui/review.js";

export const CONTEXT_MESSAGE = "arkcode-context";
const environmentSchema = z.object({
  cwd: z.string(), platform: z.string(), os: z.string(), shell: z.string(),
  current_date: z.string(), timezone: z.string(), git_branch: z.string(),
  execution: z.enum(["available", "inspection-only"]),
});
const snapshotSchema = z.object({ environment: environmentSchema, agents: z.array(instructionSchema) });
const disclosureSchema = z.object({ version: z.literal(2), kind: z.enum(["full", "diff"]), snapshot: snapshotSchema });
export type ContextSnapshot = z.infer<typeof snapshotSchema>;
type CustomMessage = Extract<AgentSession["messages"][number], { role: "custom" }>;

function xml(text: string): string { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function renderEnvironment(environment: Partial<ContextSnapshot["environment"]>): string {
  return `<environment_context>\n${Object.entries(environment).map(([key, value]) => `<${key}>${xml(value)}</${key}>`).join("\n")}\n</environment_context>`;
}

function renderAgents(agents: ContextSnapshot["agents"]): string {
  const files = agents.map((file) => `<instructions kind="${file.kind}" path="${xml(file.path)}" scope="${xml(file.kind === "global" ? "all workspaces" : file.scope)}">\n${xml(file.content)}\n</instructions>`).join("\n");
  return `<project_instructions>\nThese replace all previously supplied project instructions, including global instructions. Earlier sources omitted below no longer apply. Global instructions apply to all workspaces. Each project file applies only to its scope directory and descendants. More specific directory instructions take precedence on conflicts within their scope; sibling directory rules do not apply to each other.\n${files || "No trusted project instructions apply."}\n</project_instructions>`;
}

export function renderFull(snapshot: ContextSnapshot): string {
  return `${renderEnvironment(snapshot.environment)}\n${renderAgents(snapshot.agents)}`;
}

export function renderDiff(previous: ContextSnapshot, current: ContextSnapshot): string | undefined {
  const environment = Object.fromEntries(Object.entries(current.environment).filter(([key, value]) => Reflect.get(previous.environment, key) !== value));
  const parts: string[] = [];
  if (Object.keys(environment).length) parts.push(renderEnvironment(environment));
  if (JSON.stringify(previous.agents) !== JSON.stringify(current.agents)) parts.push(renderAgents(current.agents));
  return parts.length ? parts.join("\n") : undefined;
}

export function contextUpdate(messages: AgentSession["messages"], snapshot: ContextSnapshot): CustomMessage | undefined {
  let previous: ContextSnapshot | undefined;
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== CONTEXT_MESSAGE) continue;
    const parsed = disclosureSchema.safeParse(message.details);
    if (!parsed.success) continue;
    if (parsed.data.kind === "full" || previous) previous = parsed.data.snapshot;
  }
  const content = previous ? renderDiff(previous, snapshot) : renderFull(snapshot);
  if (!content) return undefined;
  return { role: "custom", customType: CONTEXT_MESSAGE, content, display: false, timestamp: Date.now(),
    details: { version: 2, kind: previous ? "diff" : "full", snapshot } };
}

export function installDynamicContext(session: AgentSession, options: {
  cwd: string; home: string; shell: () => string; trusted: boolean; projectDocMaxBytes: number; executionBlocked: () => boolean;
  onWarning?: (message: string) => void;
  now?: () => Date; timezone?: () => string;
}): { capture: (signal?: AbortSignal) => Promise<CustomMessage>; invalidate: () => void } {
  const prior = session.agent.prepareRequest;
  const os = `${osType()} ${release()}`;
  const instructions = new InstructionsLoader({ ...options, onWarning: options.onWarning ?? (() => {}) });
  const capture = async (signal?: AbortSignal): Promise<CustomMessage> => {
    signal?.throwIfAborted();
    const timezone = options.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    const snapshot: ContextSnapshot = {
      environment: {
        cwd: options.cwd, platform: process.platform, os, shell: options.shell(),
        current_date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(options.now?.() ?? new Date()),
        timezone, git_branch: await getBranch(options.cwd), execution: options.executionBlocked() ? "inspection-only" : "available",
      },
      agents: await instructions.load(signal),
    };
    signal?.throwIfAborted();
    return { role: "custom", customType: CONTEXT_MESSAGE, content: renderFull(snapshot), display: false, timestamp: Date.now(),
      details: { version: 2, kind: "full", snapshot } };
  };
  session.agent.prepareRequest = async (request, signal) => {
    signal?.throwIfAborted();
    const prepared = await prior?.(request, signal);
    const context = prepared?.context ?? request.context;
    const full = await capture(signal);
    const snapshot = disclosureSchema.parse(full.details).snapshot;
    const message = contextUpdate(context.messages, snapshot);
    if (!message) return prepared ?? undefined;
    // Append to both durable history and the live request. No UI lifecycle event is emitted.
    const id = session.sessionManager.appendCustomMessageEntry(message.customType, message.content, false, message.details);
    const entry = session.sessionManager.getEntry(id);
    if (entry) message.timestamp = new Date(entry.timestamp).getTime();
    const messages = [...context.messages, message];
    session.agent.state.messages = messages;
    return { ...prepared, context: { ...context, messages } };
  };
  return {
    capture: (signal) => { instructions.invalidate(); return capture(signal); },
    invalidate: () => instructions.invalidate(),
  };
}
