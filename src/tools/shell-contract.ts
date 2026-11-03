import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1, description: "Short opaque session_id returned by bash in this agent run. Pass it unchanged to shell_control; never use an OS PID." });
const budget = (minimum: number, maximum: number, value: number, description: string) =>
  Type.Optional(Type.Integer({ minimum, maximum, default: value, description }));
export const bashInputSchema = Type.Object({
  command: Type.String({ minLength: 1, description: "Command interpreted by the selected shell in the current working directory." }),
  yield_time_ms: budget(10000, 60000, 10000, "Maximum initial observation time in milliseconds, default 10000, range 10000 to 60000. Earlier exit returns earlier; expiry leaves the process running."),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Optional execution deadline in seconds, 1 to 600, no default. Expiry cancels the process tree, including after handoff." })),
  stdin: Type.Optional(Type.Union([Type.Literal("closed"), Type.Literal("pipe")], { default: "closed", description: "closed by default. pipe permits later exact input through shell_control. No PTY is allocated." })),
}, { additionalProperties: false });
export const shellControlInputSchema = Type.Union([
  Type.Object({
    action: Type.Literal("wait", { description: "Observe until exit, observation expiry, or user steering. Return new output; never replay earlier omitted logs." }),
    session_id: id,
    wait_ms: budget(10000, 300000, 10000, "Observation budget in integer milliseconds, default 10000, range 10000 to 300000. Earlier exit and finished sessions return earlier. Expiry never stops the process."),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("send", { description: "Write exact input, optionally close stdin, then observe. Requires nonempty data or eof true." }),
    session_id: id,
    data: Type.Optional(Type.String({ maxLength: 65536, description: "Exact UTF-8 input, at most 65536 bytes. No trimming or appended newline. Include \\n when required." })),
    eof: Type.Optional(Type.Boolean({ default: false, description: "After optional data, permanently close stdin. Can be true without data. EOF is not process termination or Ctrl+C." })),
    wait_ms: budget(500, 60000, 500, "Observation budget after input delivery, in integer milliseconds, default 500, range 500 to 60000. Earlier exit returns earlier."),
  }, { additionalProperties: false, anyOf: [
    { required: ["data"], properties: { data: { minLength: 1 } } },
    { required: ["eof"], properties: { eof: { const: true } } },
  ] }),
  Type.Object({
    action: Type.Literal("stop", { description: "Immediately request process-tree cancellation. The host briefly confirms cleanup and returns its confirmed state or stopping. stopping does not confirm termination." }),
    session_id: id,
  }, { additionalProperties: false }),
], { type: "object" });

const reasons = Type.Union([Type.Literal("stop"), Type.Literal("timeout"), Type.Literal("user_interrupt")]);
const cleanup = <T extends "pending" | "confirmed" | "failed">(state: T) => Type.Object({ state: Type.Literal(state), message: Type.Optional(Type.String()) });
const terminal = {
  stdin_open: Type.Literal(false), exit_code: Type.Union([Type.Integer(), Type.Null()]), signal: Type.Union([Type.String(), Type.Null()]),
};
export const shellStateSchema = Type.Union([
  Type.Object({ status: Type.Literal("running", { description: "The process has not reached a confirmed terminal state. Continue observing this session with shell_control wait; do not launch the command again." }), stdin_open: Type.Boolean() }),
  Type.Object({ status: Type.Literal("stopping"), stdin_open: Type.Literal(false), termination_reason: reasons,
    cleanup: Type.Union([cleanup("pending"), cleanup("failed")]) }),
  Type.Object({ ...terminal, status: Type.Literal("completed"), exit_code: Type.Literal(0), signal: Type.Null() }),
  Type.Object({ ...terminal, status: Type.Literal("failed") }, { not: { properties: { exit_code: { const: 0 }, signal: { const: null } }, required: ["exit_code", "signal"] } }),
  Type.Object({ ...terminal, status: Type.Literal("cancelled"), termination_reason: Type.Union([Type.Literal("stop"), Type.Literal("user_interrupt")]), cleanup: cleanup("confirmed") }),
  Type.Object({ ...terminal, status: Type.Literal("timed_out"), termination_reason: Type.Literal("timeout"), cleanup: cleanup("confirmed") }),
]);
const preview = Type.Union([
  Type.Object({ truncated: Type.Literal(false) }),
  Type.Object({ truncated: Type.Literal(true), output_file: Type.String(), truncation: Type.Object({
    mode: Type.Literal("head_tail"), reason: Type.Literal("bytes"),
    total_lines: Type.Integer({ minimum: 1 }), total_bytes: Type.Integer({ minimum: 1 }),
    observation_bytes: Type.Integer({ minimum: 1048577 }), shown_bytes: Type.Integer({ minimum: 0, maximum: 1048576 }), omitted_bytes: Type.Integer({ minimum: 1 }),
  }) }),
]);
export type ShellPreview = Static<typeof preview>;
export const shellSessionSchema = Type.Intersect([shellStateSchema, preview, Type.Object({
  kind: Type.Literal("session"), session_id: id,
  output: Type.String({ maxLength: 1048704, description: "New programmatic output, independently limited to 1 MiB UTF-8 payload plus a bounded omission marker. Direct text uses a separate 2000-line/50-KiB tail preview. Omitted output is never replayed by wait." }),
  wake_reason: Type.Union([Type.Literal("exit"), Type.Literal("wait_limit"), Type.Literal("user_steer"), Type.Literal("stop_unconfirmed"), Type.Literal("cleanup_failed")], { description: "Why this observation returned. wait_limit leaves the process running and does not mean failure or execution timeout." }),
  wall_time_seconds: Type.Number({ minimum: 0, description: "Actual elapsed time of this bash or shell_control call in seconds, including execution preparation, input delivery, observation and output capture, excluding approval. Not cumulative process lifetime; an already-finished session returns immediately." }),
  message: Type.Optional(Type.String({ description: "Host continuation guidance for a running process. A named observation window is the requested wait budget in milliseconds, not measured elapsed time. Use the same session_id rather than launching the command again." })),
  input: Type.Optional(Type.Object({ state: Type.Literal("accepted") })),
  output_lost_bytes: Type.Optional(Type.Integer({ minimum: 1 })),
  output_file: Type.Optional(Type.String()),
})], { unevaluatedProperties: false });
export const shellErrorSchema = Type.Object({
  kind: Type.Literal("error"),
  error: Type.Object({ code: Type.Union([
    Type.Literal("invalid_arguments"), Type.Literal("spawn_failed"), Type.Literal("session_not_found"), Type.Literal("session_expired"), Type.Literal("session_limit"),
    Type.Literal("observation_in_progress"), Type.Literal("stdin_closed"), Type.Literal("process_exited"), Type.Literal("stdin_write_failed"), Type.Literal("permission_denied"), Type.Literal("internal_error"),
  ]), message: Type.String() }),
  session: Type.Optional(Type.Intersect([shellStateSchema, Type.Object({ session_id: id })], { unevaluatedProperties: false })),
  input: Type.Optional(Type.Object({ state: Type.Union([Type.Literal("accepted"), Type.Literal("not_sent"), Type.Literal("unknown")]) })),
}, { additionalProperties: false });
export const shellResultSchema = Type.Union([shellSessionSchema, shellErrorSchema]);
export type BashInput = Static<typeof bashInputSchema>;
export type ShellControlInput = Static<typeof shellControlInputSchema>;
export type ShellState = Static<typeof shellStateSchema>;
export type ShellSessionResult = Static<typeof shellSessionSchema>;
export type ShellError = Static<typeof shellErrorSchema>;
export type ShellResult = Static<typeof shellResultSchema>;

export function parseShellArguments<T extends TSchema>(schema: T, input: unknown): Static<T> {
  if (!Value.Check(schema, input)) throw new Error("Invalid shell arguments. Follow the tool schema, action-specific fields, and observation time ranges.");
  if (typeof input === "object" && input !== null && "data" in input && typeof input.data === "string" && Buffer.byteLength(input.data) > 65536) {
    throw new Error("Shell input exceeds 65536 UTF-8 bytes.");
  }
  return input;
}

export const shellControlDescription = 'Wait for, send input to, or stop an existing shell session, returning newly collected output and current process status. Already-finished sessions return immediately; wait never forces a finished process to wait out the budget. wall_time_seconds reports this call\'s actual elapsed seconds, not cumulative process lifetime. Model-facing text shows at most the last 2000 lines or 50 KiB, whichever limit is reached first; truncated output is saved to a file. Programmatic callers receive independently bounded structured output. Later calls do not replay content omitted from earlier responses. Use action "wait" to observe the session, "send" to write exact input and optionally close stdin, or "stop" to request process-tree cancellation. Status "stopping" does not confirm termination.';
export const shellDescriptionAppend = "\n\nReturns process status and a short session_id. Commands that finish sooner return immediately; commands still running after the requested observation window continue in the same session. This is not a failure. Use shell_control to wait, send input, or stop that session instead of launching the command again. Already-finished sessions return immediately. wall_time_seconds reports this call's actual elapsed seconds, not cumulative process lifetime. A running session's saved file is an immutable snapshot of the command output captured so far. Read saved output only when needed for the task. Programmatic callers receive independently bounded structured output.\n\nRuns with your OS privileges; commands can access paths outside the workspace.";
export const shellGuidance = `Each bash call starts a fresh shell; variables and directory changes do not carry between calls. Use a finished result directly. Track session_id for running work; do independent work and use shell_control wait when the result is needed. Observation expiry leaves the process running. Do not repeat the launch to collect its result. Empty output and open stdin do not prove success or a need for input.
wall_time_seconds measures only the current bash or shell_control call in seconds, not cumulative process lifetime. A still-running notice names the requested observation window in milliseconds, not measured elapsed time. Already-finished sessions return immediately. CodeMode's Script completed means the JavaScript ended; a nested command may still be running.
Direct output previews keep at most the last 2000 lines or 50 KiB; programmatic output has an independent 1 MiB payload limit. Read saved output only when needed. Later waits return new output only, never earlier omitted logs. CodeMode applies its own output configuration to script-emitted text.
Send exact input only when the program protocol calls for it, include newlines explicitly, and close stdin with eof only when input is complete. Do not automatically resend input whose delivery is unknown. stop immediately requests cancellation; stopping does not confirm cleanup. Use wait if later confirmation is needed.
Sessions belong to this agent run across tool calls and CodeMode scripts; run end cleans them up. User steering releases observation without killing the process; explicit interruption stops owned work. Completion notices report undelivered settlement without consuming output. Before the final answer collect still-relevant results and do not claim unobserved work completed.`;
