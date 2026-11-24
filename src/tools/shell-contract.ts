import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1, description: "Short opaque session_id returned by bash in this agent run. Pass it unchanged to shell_control; never use an OS PID." });
const budget = (minimum: number, maximum: number, value: number, description: string) =>
  Type.Optional(Type.Integer({ minimum, maximum, default: value, description }));
export const bashInputSchema = Type.Object({
  command: Type.String({ minLength: 1, description: "Command interpreted by the selected shell in the current working directory." }),
  io_mode: Type.Optional(Type.Union([
    Type.Literal("pipe", { description: "Use ordinary stdout/stderr pipes and a writable stdin. shell_control can send chars or close stdin with eof." }),
    Type.Literal("pty", { description: "Use pseudo-terminal semantics for REPLs, TUIs, and terminal prompts. shell_control can send chars; eof is rejected for PTY sessions." }),
  ], { default: "pipe", description: "Process transport. Defaults to pipe. PTY output is returned in the same normalized session result format." })),
  yield_time_ms: budget(10000, 60000, 10000, "Maximum initial observation window in integer milliseconds, default 10000, range 10000 to 60000. Earlier exit returns earlier; expiry leaves the process running for shell_control."),
}, { additionalProperties: false });
const waitFields = {
  action: Type.Literal("wait", { description: "Observe this session and optionally deliver chars or eof before observing. Omit chars and eof for a read-only wait." }),
  session_id: id,
};
const charsDescription = "Optional exact UTF-8 text sent to the session, at most 65536 bytes. No trimming or appended newline. Include \\n when required. PTY sessions receive this as terminal input.";
const eofDescription = "Pipe sessions only. After optional chars, permanently close the pipe stdin. PTY sessions reject eof with error code eof_not_supported. EOF is not process termination or Ctrl+C.";
const waitBudgetDescription = "Observation budget in integer milliseconds. Read-only waits use 10000-300000; waits that write chars or EOF use 500-60000.";
export const shellControlInputSchema = Type.Union([
  Type.Object({
    ...waitFields,
    chars: Type.Optional(Type.String({ maxLength: 0, description: "Empty or omitted chars means no input." })),
    eof: Type.Optional(Type.Literal(false, { description: "No stdin is closed during a read-only wait." })),
    yield_time_ms: Type.Optional(Type.Integer({ minimum: 10000, maximum: 300000, default: 10000, description: `${waitBudgetDescription} Default 10000 for a read-only wait.` })),
  }, { additionalProperties: false }),
  Type.Object({
    ...waitFields,
    chars: Type.String({ minLength: 1, maxLength: 65536, description: charsDescription }),
    eof: Type.Optional(Type.Boolean({ default: false, description: eofDescription })),
    yield_time_ms: Type.Optional(Type.Integer({ minimum: 500, maximum: 60000, default: 500, description: `${waitBudgetDescription} Default 500 after input.` })),
  }, { additionalProperties: false }),
  Type.Object({
    ...waitFields,
    chars: Type.Optional(Type.String({ maxLength: 65536, description: charsDescription })),
    eof: Type.Literal(true, { description: eofDescription }),
    yield_time_ms: Type.Optional(Type.Integer({ minimum: 500, maximum: 60000, default: 500, description: `${waitBudgetDescription} Default 500 after input.` })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("stop", { description: "Immediately request process-tree cancellation. The host briefly confirms cleanup and returns its confirmed state or stopping. stopping does not confirm termination." }),
    session_id: id,
  }, { additionalProperties: false }),
], { type: "object" });

const reasons = Type.Union([Type.Literal("stop"), Type.Literal("user_interrupt")]);
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
  wake_reason: Type.Union([Type.Literal("exit"), Type.Literal("wait_limit"), Type.Literal("user_steer"), Type.Literal("stop_unconfirmed"), Type.Literal("cleanup_failed")], { description: "Why this observation returned. wait_limit leaves the process running and does not mean failure or process termination." }),
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
    Type.Literal("observation_in_progress"), Type.Literal("stdin_closed"), Type.Literal("eof_not_supported"), Type.Literal("process_exited"), Type.Literal("stdin_write_failed"), Type.Literal("permission_denied"), Type.Literal("internal_error"),
  ]), message: Type.String(), field: Type.Optional(Type.String()), hint: Type.Optional(Type.String()), retryable: Type.Optional(Type.Boolean()) }),
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

export class ShellArgumentError extends Error {
  readonly code = "invalid_arguments" as const;
  constructor(message: string, readonly field?: string, readonly hint?: string) { super(message); }
}

type RawArguments = Record<string, unknown>;
const controlFields = new Set(["action", "session_id", "chars", "eof", "yield_time_ms"]);
const hasOwn = (value: RawArguments, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is RawArguments => typeof value === "object" && value !== null && !Array.isArray(value);
const argumentError = (message: string, field?: string, hint?: string): never => { throw new ShellArgumentError(message, field, hint); };

function checkInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number") return argumentError(`${field} must be an integer number of milliseconds.`, field, `Use an integer from ${minimum} to ${maximum}.`);
  if (!Number.isInteger(value)) return argumentError(`${field} must be an integer number of milliseconds.`, field, `Use an integer from ${minimum} to ${maximum}.`);
  if (value < minimum || value > maximum) return argumentError(`${field} must be between ${minimum} and ${maximum} milliseconds; received ${value}.`, field, `Use a value in the inclusive range ${minimum}-${maximum}.`);
  return value;
}

function normalizeBashArguments(input: unknown): unknown {
  const object = isObject(input) ? { ...input } : argumentError("bash arguments must be a JSON object.", undefined, "Provide command and optional io_mode and yield_time_ms fields.");
  const unknown = Object.keys(object).filter(key => !["command", "io_mode", "yield_time_ms"].includes(key));
  if (unknown.includes("timeout")) argumentError("bash no longer accepts timeout.", "timeout", "Omit timeout; yield_time_ms only controls the initial observation window. Use shell_control action \"stop\" to cancel a running session.");
  if (unknown.length > 0) argumentError(`bash does not accept field(s): ${unknown.join(", ")}.`, unknown[0], "Remove the unknown field and retry.");
  if (typeof object.command !== "string" || object.command.length === 0) argumentError("command is required and must be a non-empty string.", "command", "Provide the shell command to execute.");
  if (hasOwn(object, "yield_time_ms") && object.yield_time_ms !== undefined) checkInteger(object.yield_time_ms, "yield_time_ms", 10000, 60000);
  if (hasOwn(object, "io_mode") && object.io_mode !== undefined && object.io_mode !== "pipe" && object.io_mode !== "pty") {
    argumentError(`io_mode must be either \"pipe\" or \"pty\"; received ${JSON.stringify(object.io_mode)}.`, "io_mode", "Use io_mode: \"pipe\" for ordinary streams or \"pty\" for terminal semantics.");
  }
  if (!hasOwn(object, "io_mode") || object.io_mode === undefined) object.io_mode = "pipe";
  if (!hasOwn(object, "yield_time_ms") || object.yield_time_ms === undefined) object.yield_time_ms = 10000;
  return object;
}

function normalizeControlArguments(input: unknown): unknown {
  const object = isObject(input) ? input : argumentError("shell_control arguments must be a JSON object.", undefined, "Provide session_id and action \"wait\" or \"stop\".");
  const value: RawArguments = { ...object };
  const hadLegacySend = value.action === "send";
  if (hasOwn(value, "data")) {
    if (hasOwn(value, "chars")) argumentError("Use only chars; data is the legacy name and cannot be combined with chars.", "chars", "Rename data to chars.");
    value.chars = value.data;
    delete value.data;
  }
  if (hasOwn(value, "wait_ms")) {
    if (hasOwn(value, "yield_time_ms")) argumentError("Use only yield_time_ms; wait_ms is the legacy name and cannot be combined with it.", "yield_time_ms", "Rename wait_ms to yield_time_ms.");
    value.yield_time_ms = value.wait_ms;
    delete value.wait_ms;
  }
  if (!hasOwn(value, "action")) {
    const hasInput = (hasOwn(value, "chars") && value.chars !== "") || value.eof === true;
    if (hasInput) argumentError("action is required when sending chars or EOF.", "action", "Use action: \"wait\" for observation and include chars/eof only when input is intended.");
    value.action = "wait";
  } else if (value.action === "send") {
    value.action = "wait";
  } else if (value.action !== "wait" && value.action !== "stop") {
    argumentError(`action must be \"wait\" or \"stop\"; received ${JSON.stringify(value.action)}.`, "action", "Legacy action \"send\" is accepted and mapped to action \"wait\".");
  }
  const unknown = Object.keys(value).filter(key => !controlFields.has(key));
  if (unknown.length > 0) argumentError(`shell_control does not accept field(s): ${unknown.join(", ")}.`, unknown[0], "Use action, session_id, chars, eof, and yield_time_ms.");
  if (typeof value.session_id !== "string" || value.session_id.length === 0) argumentError("session_id is required and must be a non-empty string.", "session_id", "Copy the opaque session_id returned by bash.");
  if (value.action === "stop") {
    if (hasOwn(value, "chars") || hasOwn(value, "eof") || hasOwn(value, "yield_time_ms")) argumentError("action \"stop\" accepts only session_id.", "action", "Use action \"wait\" for input or observation.");
    return value;
  }
  if (hasOwn(value, "chars") && typeof value.chars !== "string") argumentError("chars must be a string when provided.", "chars", "Use exact text, including any required newline.");
  if (typeof value.chars === "string" && Buffer.byteLength(value.chars, "utf8") > 65536) argumentError("chars exceeds the 65536-byte UTF-8 limit.", "chars", "Send a smaller chunk; do not split a protocol token unless the program permits it.");
  if (hasOwn(value, "eof") && value.eof !== undefined && typeof value.eof !== "boolean") argumentError("eof must be a boolean when provided.", "eof", "Use eof: true to close stdin after chars.");
  const hasInput = (typeof value.chars === "string" && value.chars.length > 0) || value.eof === true;
  const minimum = hasInput ? 500 : 10000;
  const maximum = hasInput ? 60000 : 300000;
  if (hasOwn(value, "yield_time_ms") && value.yield_time_ms !== undefined) checkInteger(value.yield_time_ms, "yield_time_ms", minimum, maximum);
  else value.yield_time_ms = hasInput ? 500 : 10000;
  if (hadLegacySend && !hasInput) argumentError("Legacy action \"send\" requires non-empty data/chars or eof: true.", "chars", "Use action \"wait\" without input for a read-only wait.");
  return value;
}

export function parseShellArguments<T extends TSchema>(schema: T, input: unknown): Static<T> {
  const schemaIdentity: TSchema = schema;
  const prepared = schemaIdentity === shellControlInputSchema ? normalizeControlArguments(input) : schemaIdentity === bashInputSchema ? normalizeBashArguments(input) : input;
  if (!Value.Check(schema, prepared)) {
    const detail = [...Value.Errors(schema, prepared)][0];
    argumentError(`Invalid shell arguments${detail?.message ? `: ${detail.message}` : "."}`, undefined, "Follow the tool schema and the action-specific field ranges.");
  }
  return Value.Parse(schema, prepared);
}

export const shellControlDescription = 'Continue an existing shell session and return newly collected output plus process status. Use action "wait" for observation and optional input: omit chars and eof for a read-only wait; provide chars and/or eof to deliver input before observing. When action is omitted and the request contains no input fields, the host infers action "wait". chars works for pipe and PTY sessions. eof closes stdin for pipe sessions and returns eof_not_supported for PTY sessions. The wait budget is yield_time_ms: read-only waits default to 10000 ms and allow 10000-300000; waits that write input default to 500 ms and allow 500-60000. Use action "stop" to request process-tree cancellation. Already-finished sessions return immediately. An observation expiry leaves a running process alive. wall_time_seconds is this call\'s elapsed time, not cumulative process lifetime. Model-facing text shows at most the last 2000 lines or 50 KiB; truncated output is saved to a file. Programmatic callers receive independently bounded structured output, including status and exit_code when terminal. Later calls return only new output.';
export const shellDescriptionAppend = "\n\nReturns process status and a short session_id. Commands that finish sooner return immediately; commands still running after the requested observation window continue in the same session. Choose io_mode \"pipe\" by default for ordinary streams, scripts, tests, and commands that may need a real EOF. Choose io_mode \"pty\" for REPLs, TUIs, and terminal prompts. Use shell_control with action \"wait\" to observe or provide chars, or action \"stop\" to cancel that session. chars works for either mode. eof closes stdin for pipe sessions and returns eof_not_supported for PTY sessions. Already-finished sessions return immediately. wall_time_seconds reports this call's actual elapsed seconds, not cumulative process lifetime. A running session's saved file is an immutable snapshot of the command output captured so far. Read saved output only when needed for the task. Programmatic callers receive independently bounded structured output.\n\nRuns with your OS privileges; commands can access paths outside the workspace.";
export const shellGuidance = `Each bash call starts a fresh shell; variables and directory changes do not carry between calls. Use a finished result directly. Track session_id for running work; do independent work and use shell_control wait when the result is needed. Observation expiry leaves the process running. Do not repeat the launch to collect its result. Empty output and open stdin do not prove success or a need for input.
wall_time_seconds measures only the current bash or shell_control call in seconds, not cumulative process lifetime. A still-running notice names the requested observation window in milliseconds, not measured elapsed time. Already-finished sessions return immediately. CodeMode's Script completed means the JavaScript ended; a nested command may still be running.
Direct output previews keep at most the last 2000 lines or 50 KiB; programmatic output has an independent 1 MiB payload limit. Read saved output only when needed. Later waits return new output only, never earlier omitted logs. CodeMode applies its own output configuration to script-emitted text.
Choose io_mode "pipe" by default. Choose io_mode "pty" when the command needs terminal semantics such as a REPL, TUI, or terminal prompt. Use action "wait" with non-empty chars only when the program protocol calls for input; include newlines explicitly. chars works for pipe and PTY sessions. Set eof: true only after pipe input is complete. PTY sessions return eof_not_supported for eof and accept terminal input through chars. Do not automatically resend input whose delivery is unknown. stop immediately requests cancellation; stopping does not confirm cleanup. Use a later wait if confirmation is needed.
Sessions belong to this agent run across tool calls and CodeMode scripts; run end cleans them up. User steering releases observation without killing the process; explicit interruption stops owned work. Completion notices report undelivered settlement without consuming output. Before the final answer collect still-relevant results and do not claim unobserved work completed.`;
