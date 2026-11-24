import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { z } from "zod";
import { cleanOutput } from "./output.js";
import { bashInputSchema, parseShellArguments, ShellArgumentError, shellControlInputSchema, shellResultSchema, type ShellState } from "./shell-contract.js";

const SUMMARY_BYTES = 2048;
const TITLE = "Shell results (host observations)\n";
const OMITTED = "Additional shell results omitted.\n";
type ShellTool = "bash" | "shell_control";
const isShellTool = (name: string): name is ShellTool => name === "bash" || name === "shell_control";
const toolResult = z.object({
  structuredContent: z.unknown(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
});

function diagnostic(value: string): string {
  const text = cleanOutput(value).replace(/\s+/g, " ").trim();
  const bytes = Buffer.from(text);
  return JSON.stringify(bytes.length <= 160 ? text
    : new TextDecoder().decode(bytes.subarray(0, 157), { stream: true }) + "…");
}

function stateFields(state: ShellState): string[] {
  const fields = [`status=${state.status}`, `stdin_open=${state.stdin_open}`];
  if ("exit_code" in state) fields.push(`exit_code=${state.exit_code}`);
  if ("signal" in state && state.signal !== null) fields.push(`signal=${JSON.stringify(state.signal)}`);
  if ("termination_reason" in state) fields.push(`termination_reason=${state.termination_reason}`, `cleanup=${state.cleanup.state}`);
  if ("cleanup" in state && state.cleanup.message) fields.push(`cleanup_message=${diagnostic(state.cleanup.message)}`);
  return fields;
}

function summarize(tool: ShellTool, raw: unknown, isError: boolean, beforeExecution: boolean, args: unknown): string[] | undefined {
  const parsed = toolResult.safeParse(raw);
  const result = parsed.data?.structuredContent;
  if (Value.Check(shellResultSchema, result)) {
    if (result.kind === "session") {
      if (tool === "bash" && result.status === "completed" && !result.output_file) return;
      return [
        `session_id=${result.session_id}`, ...stateFields(result), `wake_reason=${result.wake_reason}`,
        ...(result.input ? [`input=${result.input.state}`] : []),
        ...(result.output_file ? [`output_file=${JSON.stringify(result.output_file)}`] : []),
      ];
    }
    return [
      "kind=error", `code=${result.error.code}`,
      ...(result.session ? [`session_id=${result.session.session_id}`, ...stateFields(result.session)] : []),
      ...(result.input ? [`input=${result.input.state}`] : []),
      ...(result.error.field ? [`field=${diagnostic(result.error.field)}`] : []),
      `message=${diagnostic(result.error.message)}`,
      ...(result.error.hint ? [`hint=${diagnostic(result.error.hint)}`] : []),
    ];
  }
  if (!isError) return;
  // Pi returns preparation failures as text. Recover the shell-specific fields with the same pure parser.
  if (beforeExecution) {
    try {
      if (tool === "bash") parseShellArguments(bashInputSchema, args);
      else parseShellArguments(shellControlInputSchema, args);
    } catch (error) {
      if (error instanceof ShellArgumentError) return [
        "kind=error", `code=${error.code}`,
        ...(error.field ? [`field=${diagnostic(error.field)}`] : []),
        `message=${diagnostic(error.message)}`,
        ...(error.hint ? [`hint=${diagnostic(error.hint)}`] : []),
      ];
    }
  }
  const message = parsed.data?.content?.[0]?.text;
  return ["kind=error", "code=tool_error", ...(message ? [`message=${diagnostic(message)}`] : [])];
}

export const installCodemodeShellSummary: ExtensionFactory = (pi) => {
  const scripts = new Map<string, { pending: Map<string, unknown>; text: string; omitted: boolean }>();
  pi.on("tool_execution_start", (event) => {
    if (!event.parentToolCallId && event.toolName === "codemode") {
      scripts.set(event.toolCallId, { pending: new Map(), text: "", omitted: false });
    } else if (event.parentToolCallId && isShellTool(event.toolName)) {
      scripts.get(event.parentToolCallId)?.pending.set(event.toolCallId, event.args);
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (!event.parentToolCallId) {
      scripts.delete(event.toolCallId);
      return;
    }
    const script = scripts.get(event.parentToolCallId);
    if (!script || !isShellTool(event.toolName)) return;
    const args = script.pending.get(event.toolCallId);
    script.pending.delete(event.toolCallId);
    const fields = summarize(event.toolName, event.result, event.isError, event.durationMs === undefined, args);
    if (!fields) return;
    const number = event.toolCallId.slice(event.parentToolCallId.length + 1);
    const prefix = `#${number} ${event.toolName} `;
    let line = `${prefix}${fields.join(" ")}\n`;
    const room = SUMMARY_BYTES - Buffer.byteLength(TITLE + script.text + OMITTED);
    if (Buffer.byteLength(line) > room && fields.at(-1)?.startsWith("output_file=")) {
      line = `${prefix}${fields.slice(0, -1).join(" ")} output_file_omitted=true\n`;
    }
    if (Buffer.byteLength(line) <= room) script.text += line;
    else script.omitted = true;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "codemode" || event.parentToolCallId) return;
    const script = scripts.get(event.toolCallId);
    scripts.delete(event.toolCallId);
    if (!script || (!script.text && !script.omitted)) return;
    const [header, ...output] = event.content;
    const summary = { type: "text" as const, text: TITLE + script.text + (script.omitted ? OMITTED : "") };
    return { content: header ? [header, summary, ...output] : [summary], structuredContent: event.structuredContent };
  });
};
