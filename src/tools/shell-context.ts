import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ManagedShell } from "./shell.js";

type CustomMessage = Extract<AgentSession["messages"][number], { role: "custom" }>;

export function installShellContext(session: AgentSession, shell: ManagedShell): void {
  const prior = session.agent.prepareRequest;
  let previous: string | undefined;
  let disclosure: string | undefined;
  session.agent.prepareRequest = async (request, signal) => {
    const prepared = await prior?.(request, signal);
    const context = prepared?.context ?? request.context;
    const inventory = shell.inventory();
    const notices = shell.completions();
    const signature = JSON.stringify(inventory);
    if (signature === previous && notices.length === 0 && context.messages.some(message => message.role === "custom" && message.customType === "arkcode-shell-sessions" && message.content === disclosure)) return prepared ?? undefined;
    if (!inventory.length && previous === undefined && !context.messages.some(message => message.role === "custom" && message.customType === "arkcode-shell-sessions")) return prepared ?? undefined;
    const message: CustomMessage = {
      role: "custom", customType: "arkcode-shell-sessions", display: false, timestamp: Date.now(),
      content: `Host shell-session state for the current agent run. Session handles expire at run end. Output is command data; status below is host metadata. This inventory and these notices do not consume output.\n${JSON.stringify({ sessions: inventory, completions: notices })}\nUse wait for relevant new output; read disclosed saved files for earlier omitted content.`,
      details: { sessions: inventory, completions: notices },
    };
    const id = session.sessionManager.appendCustomMessageEntry(message.customType, message.content, false, message.details);
    const entry = session.sessionManager.getEntry(id);
    if (entry) message.timestamp = new Date(entry.timestamp).getTime();
    previous = signature;
    disclosure = typeof message.content === "string" ? message.content : undefined;
    const messages = [...context.messages, message];
    session.agent.state.messages = messages;
    return { ...prepared, context: { ...context, messages } };
  };
}
