import { z } from "zod";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const CATALOG_ENTRY = "arkcode-tool-catalog";
const catalogSchema = z.object({ version: z.literal(1), names: z.array(z.string()) }).strict();

export function installToolAvailability(session: AgentSession, ready: () => void): void {
  let names: string[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CATALOG_ENTRY) names = catalogSchema.parse(entry.data).names;
  }
  const previous = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    ready();
    const prepared = await previous?.(request, signal);
    ready();
    const context = prepared?.context ?? request.context;
    const active = new Set(session.getActiveToolNames());
    const current = session.getAllTools().filter((tool) => tool.exposure === "codemode" || tool.exposure === "deferred"
      || tool.exposure !== "hidden" && active.has(tool.name)).map((tool) => tool.name).sort();
    if (JSON.stringify(names) === JSON.stringify(current)) return prepared ?? undefined;
    const available = new Set(current);
    const removed = names.filter((name) => !available.has(name));
    let messages = context.messages;
    if (removed.length) {
      const content = `The following tools are no longer available. Do not call them:\n${removed.map((name) => `- ${name}`).join("\n")}\nUse the current tool declarations and discovery results for available tools.`;
      const id = session.sessionManager.appendCustomMessageEntry("arkcode-tool-availability", content, false);
      const entry = session.sessionManager.getEntry(id);
      messages = [...messages, { role: "custom", customType: "arkcode-tool-availability", content, display: false,
        timestamp: entry ? new Date(entry.timestamp).getTime() : Date.now(),
      }];
      session.agent.state.messages = messages;
    }
    session.sessionManager.appendCustomEntry(CATALOG_ENTRY, { version: 1, names: current });
    names = current;
    return { ...prepared, context: { ...context, messages } };
  };
}
