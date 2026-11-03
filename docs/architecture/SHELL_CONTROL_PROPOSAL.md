# Bash sessions and shell_control proposal

Status: implemented, revised 2026-11-03. `bash` and `shell_control` reuse Pi registration, dispatch, and CodeMode. ArkCode owns resumable process sessions and output capture. Start with [the schema bundle](shell-control/README.md); model descriptions and context are in [the model contract](SHELL_CONTROL_MODEL_CONTRACT.md).

The user has fixed the observation windows and selected preview-plus-file output without shell token budgets or output pagination. CodeMode keeps its own programmatic-data and outer-output limits. This revision supersedes the earlier pagination proposal.

## Feasibility and ownership

The previous implementation could not hand off a running command through Pi's synchronous BashOperations result:

- `src/tools/shell.ts` previously waited for closure, ignored stdin, and retained only the first 128 KiB in its receipt. It now owns launch, observation, input, deadlines, and process-tree cancellation.
- `src/tools/shell-tools.ts` defines ArkCode-owned model tools. Pi's synchronous BashOperations still expects a numeric final exit code and closes its accumulator when the operation returns. A live process cannot be represented by a synthetic successful exit.
- `src/app/session-runtime.ts` calls `endRun()` after each agent run. Sessions survive tool calls and CodeMode scripts within that run, and expire after cleanup at run end.
- `src/tools/output-files.ts` retains immutable file authorization. `src/tools/shell-output.ts` exports immutable complete-prefix snapshots rather than exposing its growing private log.

`ManagedShell.execute()` retains completion-waiting behavior for the user `!` command. The new shell tools use Pi's public registration facilities; this change does not patch Pi dependencies.

## Reference implementations: observed behavior

The following facts were checked against local source snapshots, rather than inferred from tool names. Codex snapshot: `231c8abd2f4f7e3e14aa3e54bcf8136435e6f2f3`. DeepSeek Harness snapshot: `ce7073d51254c26cd63b22a60835b8f948deb447`. Defaults can differ in other deployments.

| Operation | Default observation window | Effective limits and behavior |
| --- | --- | --- |
| Codex `exec_command` | 10000 ms | POSIX: 250–30000 ms; Windows: 10000–30000 ms. Earlier command completion returns earlier. |
| Codex `write_stdin`, nonempty `chars` | 250 ms | 250–30000 ms. PTY writes also have a separate internal reaction grace of about 100 ms before output collection. |
| Codex `write_stdin`, empty or omitted `chars` | 5000 ms | 5000–300000 ms with the default configured maximum. The parser's 250 ms default is raised to 5000 ms for an empty poll. |
| DeepSeek `bash`, foreground | 120000 ms | Configured cap 600000 ms. With jobs and timeout promotion enabled, expiry hands off the existing process; otherwise expiry kills it. Explicit background execution returns a job id without an execution timeout. |
| DeepSeek `job_output` | Nonblocking | With `wait: true`, default 30000 ms, configured cap 600000 ms. Returns on settlement, the wait limit, or a user steer; wait expiry leaves the job running. |

Codex evidence: [argument defaults](<E:/Github Programs/codex/codex-rs/core/src/tools/handlers/unified_exec.rs:113>), [model-visible descriptions](<E:/Github Programs/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:27>), [wait constants](<E:/Github Programs/codex/codex-rs/core/src/unified_exec/mod.rs:66>), [effective empty-input clamp](<E:/Github Programs/codex/codex-rs/core/src/unified_exec/process_manager.rs:1048>). DeepSeek evidence: [executor defaults](<E:/Github Programs/deepseek-harness/packages/shell/bash-local/src/index.ts:100>), [bash promotion policy](<E:/Github Programs/deepseek-harness/packages/shell/tool-bash/src/index.ts:380>), [job wait configuration](<E:/Github Programs/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:42>), [job output schema](<E:/Github Programs/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:433>).

Codex's shell wait values are observation windows, not execution deadlines. Its output collector batches across incoming chunks until the deadline or output/process closure; it does not return on every new chunk. Both Codex and DeepSeek manage the ordinary model output position internally. Neither requires a model-facing cursor for normal polling. DeepSeek has a separate internal nonconsuming `readAt()` interface. Evidence: [Codex collector](<E:/Github Programs/codex/codex-rs/core/src/unified_exec/process_manager.rs:1590>), [DeepSeek internal reads](<E:/Github Programs/deepseek-harness/packages/jobs/jobs-local/src/index.ts:320>), [DeepSeek model cursor](<E:/Github Programs/deepseek-harness/packages/jobs/jobs-local/src/index.ts:466>).

### Input modes are different

Codex does not expose `stdin: "pipe" | "closed"` in model-facing `exec_command`. It exposes `tty`, default false. Ordinary non-TTY execution has output pipes but closed stdin. `tty: true` allocates a PTY for interactive input where supported. The lower-level exec server supports a writable stdin pipe, but this shell tool sets `pipe_stdin: false`. An ordinary nonempty `write_stdin` on a non-TTY session fails with `StdinClosed`; the exact interrupt string `"\u0003"` has a special path that invokes process interruption. Evidence: [TTY schema](<E:/Github Programs/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:45>), [exec-server parameters](<E:/Github Programs/codex/codex-rs/core/src/unified_exec/process_manager.rs:248>), [input/interrupt handling](<E:/Github Programs/codex/codex-rs/core/src/unified_exec/process_manager.rs:1021>).

DeepSeek's ordinary bash/jobs controls do not expose continued stdin writes. Its experimental terminal tools are a separate interface. ArkCode's `stdin: "pipe"` supports redirected-input programs. It does not allocate Codex's PTY. Stdin defaults to `closed`; the model opts into a pipe when later input is needed.

### Shell control and JavaScript control are separate

Codex's `exec_command` and `write_stdin` are peers in the shell tool set. In mixed CodeMode they can be called directly or through `tools.*`; in CodeModeOnly they are nested calls. The outer `wait(cell_id, terminate: true)` terminates a JavaScript cell, not an arbitrary shell session. Its default wait is 10000 ms. Shell observation and input/interruption use `write_stdin(session_id, ...)`. Evidence: [outer wait description](<E:/Github Programs/codex/codex-rs/code-mode-protocol/src/description.rs:48>), [mode research](../../research/architecture/agent-harness-evaluation-2026-10-29/codex-codemode-wait-layers-2026-11-02.md).

DeepSeek separates `job_output` from `job_kill`. The latter acknowledges a cancellation request; a later settlement confirms completion. Its PTC can call those tools but does not supply Codex's resumable outer JS-cell `wait` protocol.

## Tool interface and timing

Every bash call starts a fresh shell with its own command and descendants. Shell variables, functions, and cwd changes do not carry between calls. Keep the name `bash` even when the selected backend is PowerShell, but render the actual shell name in its description and runtime context.

| Tool or action | Input | Behavior |
| --- | --- | --- |
| `bash` | `command`, optional `yield_time_ms`, `timeout`, `stdin` | Start and observe; hand off the same process if it is still running |
| `shell_control.wait` | `session_id`, optional `wait_ms` | Observe and return newly collected output and current state |
| `shell_control.send` | `session_id`, `data` and/or `eof`, optional `wait_ms` | Write exact input, optionally close stdin, then observe |
| `shell_control.stop` | `session_id` | Immediately request process-tree cancellation; return confirmed cleanup or stopping |

| Observation | Default | Inclusive range |
| --- | --- | --- |
| bash `yield_time_ms` | 10000 ms | 10000 to 60000 ms |
| wait `wait_ms` | 10000 ms | 10000 to 300000 ms |
| send `wait_ms` | 500 ms | 500 to 60000 ms |

Earlier settlement returns earlier. These ranges constrain requested budgets, not minimum elapsed durations. Batch progress until settlement, the observation deadline, or user steering; one output chunk does not release a call. A terminal session returns immediately. A live wait keeps the same observation policy even when earlier output was truncated. Truncation never creates a pagination fast path.

Stop has no model-facing wait_ms. After validation and authorization, it issues cancellation immediately. The host uses an internal cleanup-confirmation budget of at most 5000 ms, returning earlier when cleanup is confirmed. If confirmation is still pending, return stopping and continue cleanup independently; a later wait can observe settlement. This internal budget bounds observation, not the lifetime of cleanup or the delay before sending cancellation. Do not require the model to choose it, and do not block indefinitely. Calling stop on a settled session preserves that result and returns immediately.

Reject invalid types, fractional milliseconds, and out-of-range budgets before side effects. JSON Schema defaults are annotations; handlers fill only omitted fields. `bash.timeout` remains an optional execution deadline in seconds, range 1 to 600 including fractional seconds, without a default. Unlike an observation deadline, it terminates the process tree and remains active after handoff. A send's observation starts after input delivery; startup, approval, input, and file-export overhead can extend total call time.

No `read` action, public cursor, `until`, PID, or `terminate` flag is needed. There is no shell `max_output_tokens` argument or `has_more` field. Stop remains an explicit side effect rather than a wait flag, allowing distinct validation, permissions, and cleanup reporting.

## Incremental observation

Each session has one internal committed observation watermark shared by direct and CodeMode calls. Capture continues independently of any tool call or UI subscriber.

1. After an observation finishes, capture a consistent interval from the previous watermark to the current capture position.
2. Prepare both the direct text and programmatic projections of that same interval. Export a file when either projection requires it.
3. Commit the result and advance the watermark through the entire interval, including bytes omitted from either projection.
4. Start the next observation after that position. It does not return an earlier omitted range or repeat an old tail when no new output exists.

An error before result commit does not advance the position. Delivery after commit is not a durable exactly-once protocol; a lost transport result cannot promise automatic replay. UI streaming, completion notices, compaction inventories, and reads of saved files never advance this position.

Reject overlapping waits on one session, while allowing input and cancellation during a pending wait. Serialize result preparation and commit separately from process/input operations. Never hold process or input locks during observation or file copying. Send and stop issue their effects before joining result preparation. Concurrent results can collect different intervals than their start order; returned output is session output, not proof that it was caused by a particular input.

UTF-8 decoding must span process chunks. Keep capture positions on decoded UTF-8 boundaries and preserve line accounting across observations. A later interval can begin partway through a line, but cannot replay the prefix already observed. Do not claim exact ordering between separate stdout and stderr pipes.

## Output limits and files

### Direct text and programmatic data

Retain Pi's distinction between model-facing text and data supplied to a CodeMode script.

| Projection | Limit | On excess |
| --- | --- | --- |
| Direct bash/control text | Last 2000 lines or 50 KiB of the current interval, whichever limits first | Show the tail, identify truncation and global file line range, provide saved path |
| Programmatic `structuredContent.output` | Independent 1 MiB payload limit | Keep head and tail with a bounded omission marker and saved path |
| CodeMode script output to the model | CodeMode's own configuration, currently default 10000 tokens | Use CodeMode's own truncation and saved-output behavior |

The first two projections belong to the same observation and carry the same process facts. Their output and truncation flags can differ. A 100 KiB shell result can be truncated in direct text while remaining complete for the script. The structured `truncated` flag describes the programmatic payload only. Do not cut script input to 50 KiB merely because the direct text preview has that limit.

The 1 MiB value is Pi's current programmatic shell constant, not a new model parameter or the CodeMode outer token configuration. Keep it as an independent host policy for both bash and control. The omission marker is small and outside the payload budget. Calculate omitted bytes after UTF-8 boundary adjustment. Do not promise that either truncated representation is valid complete JSON or a complete line protocol.

Pi already implements the direct tail-plus-file mechanism in `core/tools/bash.js` and `truncate.js`, with disk accumulation in `output-accumulator.js`. Its existing programmatic reader uses a separate 1 MiB head/tail limit. Codex's truncation formatter identifies truncation, original token count, and line count; its pending-buffer drain does not implement replay of model-omitted text. These observations support clear omission notices and incremental waits, without claiming Codex has Pi's automatic full-file mechanism.

Keep status and truncation notices outside the direct 2000-line/51200-byte body limit. Exactly reaching a limit does not trigger truncation if the full interval fits. For an oversized final line, return its UTF-8-safe suffix and explicitly identify the partial line. Global line numbers refer to the exported complete-prefix file, so a model can choose an appropriate `read` offset. Since the preview is a tail, omitted content normally precedes it.

### Complete saved logs and running snapshots

Capture into one private disk log from launch, with stream backpressure and a bounded in-memory UI receipt. Export a model-readable snapshot only when needed. Capturing from launch preserves the complete beginning without keeping arbitrary output in memory. A saved file contains the entire captured command prefix through the response watermark, including earlier observations.

When either projection truncates, expose an authorized complete-prefix artifact. For a running command, export an immutable snapshot and label it as output captured so far. Later output does not modify that file. After settlement, seal the final complete log. A later nontruncated result may still include the final artifact if the command previously required spooling. Never show a mutable private-log path as an authorized immutable artifact.

Prepare snapshots outside process/input locks. Reuse an export only for the same capture watermark and immutable identity; a hard link to an actively appended file is not an immutable snapshot. Copying has I/O and storage costs, so export only when needed and use safe filesystem clone support where available. Commit the observation only after required persistence and authorization succeed. A failure returns a tool error with known session/input state; never promise a missing or incomplete full log.

Add `shell_control` to trusted output producers and retain current realpath, file identity, size, and modification checks. Do not weaken those checks to authorize growing files. Snapshot retention follows the output-artifact policy rather than implying the process handle remains valid forever.

There is no normal log eviction to match a preview limit. Host limits are 8 live/stopping sessions, 128 retained session entries, and a 128 KiB UI receipt per session. Reject a new launch before spawning if capacity cannot be freed without losing required state; never evict a live process. Actual capture failure produces an error and does not advance the observation position. `output_lost_bytes` is reserved for known actual loss, and is not emitted for ordinary preview omission.

### File reads and CodeMode output files

`read` uses `ToolOutputFiles.readText()` for authorized text artifacts, including nested CodeMode reads. It scans in bounded chunks, applies line offset/limit and the direct preview limit, and checks immutable identity before and after reading. Files above 64 MiB can be read without a whole-file allocation. The older binary `read()` helper retains its 64 MiB guard. Reading a far line still scans the preceding bytes; there is no persistent line index.

CodeMode's saved file contains only text the script emitted. It does not automatically embed shell files or recover omitted shell output. Scripts can read relevant ranges, filter, and emit the evidence needed. Preserve handles, status, and file references when returning from a script. A later wait cannot restore output a script received but did not print.

## Input, EOF, and termination

Default stdin is `closed`. Opt into `pipe` for redirected-input programs, without a PTY promise. Send requires nonempty exact data or `eof: true`. Spaces and newlines are meaningful input. Do not trim or append a newline. Reject more than 65536 UTF-8 input bytes before writing. An independent 5000-ms host input-delivery deadline bounds pipe backpressure; it is separate from post-write observation.

`eof: true` closes stdin irreversibly after optional data. It does not send Ctrl+C or establish process exit. `exit\n` or `quit\n` can request cooperative exit only when recognized by the running program. Later stdin goes to that program's protocol, not automatically to a new shell parser. Pipe control bytes are not portable terminal signals. Use `stop` for host process-tree cancellation.

Successful input delivery reports `input.state: accepted`, meaning transport delivery, not application processing. Failed writes report `not_sent` only when absence of delivery is established; otherwise use `unknown`. Never resend automatically. Cancel or close a still-pending writer before accepting another write. Once termination begins, deny further input.

The first accepted managed termination cause wins. Natural completion that settles first remains natural completion; a timeout that wins cannot be relabeled by a later stop. Preserve actual OS exit code/signal separately from termination reason. Repeated stop is idempotent and does not restart cancellation, its grace period, or the original internal confirmation budget. Return the current cleanup state on a repeated stop; use wait for further observation. `stopping` with pending or failed cleanup does not confirm that all descendants have stopped. Terminal cancellation requires confirmed tree cleanup and final output capture.

## Results, lifecycle, permissions, and modes

Both tools declare the shared result schema and return structured content plus direct text from one observation. Live states are `running` and `stopping`. Terminal states are `completed`, `failed`, `cancelled`, and `timed_out`. Only terminal results carry final exit information. A normal nonzero command exit is a successful observation with session status `failed`, not an infrastructure exception.

Expected handler errors carry `kind: error`, bounded recovery text, optional known-state snapshot, and input-delivery state when relevant. They set the tool-error transport flag and do not consume output. CodeMode may resolve a structured error value; scripts inspect kind/status as well as handling validation failures that reject.

Each returned id belongs to its agent run. Before initial handoff, launch cancellation cleans up its child. After handoff, completion of a CodeMode script or cancellation of one observation preserves the process. Run end, explicit user interruption, shutdown, and execution deadlines clean up owned processes. Stopping one command does not mark the whole run user-interrupted. Persisted historical ids are never reattached or signalled by PID alone.

| Mode | Exposure |
| --- | --- |
| `direct` | Native bash and shell_control under the existing built-in policy |
| `codemode` | Native tools and nested `tools.bash()` / `tools.shell_control()` |
| `codemode-only` | Nested calls only |

Use the same session manager and permissions in all modes. Register the tool in tool names, loadout, mode prompts, and availability tracking. Permissions depend on action: wait observes an owned session, send supplies potentially executable interpreter input, and stop cancels owned work. Launch approval is not blanket approval for later interpreter commands. Extend the approval invocation beyond its current command/path-only shape. Do not classify the entire control tool as read-only or bypass viewer/recovery restrictions.

Use the same schema for public declarations and strict raw-argument checks in Pi's `prepareArguments`, before Pi's normal coercing validator. Derive internal types from the runtime schema and compare generated JSON snapshots. Set `constrainedSampling: false`; the installed strict converter rejects object unions. Local provider adapters preserve ordinary schema transport, but real provider acceptance still needs smoke checks.

`src/tools/shell-context.ts` adds metadata-only completion notices and a short inventory when preparing the next model request. Notices never consume output. A terminal tool result suppresses its notice; a `stopping` response does not suppress later cleanup confirmation. An already disclosed artifact remains an immutable prefix snapshot. Notices do not wake an idle model or promise replay of omitted text.

On compaction or mode changes, restore id, bounded command label, state, stdin state, last relevant artifact, and run lifetime. Do not repeat logs or resurrect expired handles. Other sessions' completion notices must not masquerade as user steering that releases an unrelated wait.

## Implementation and validation

1. `shell.ts` owns processes, observation, input, cancellation, and run cleanup.
2. `shell-output.ts` owns interval capture and projections; `output-files.ts` authorizes immutable range reads.
3. `shell-contract.ts` defines schemas and model descriptions; `shell-tools.ts` registers tools and applies authorization.
4. `shell-context.ts` preserves inventories and notices in durable history and live context. Runtime and terminal code display active sessions and real outcomes.
5. `scripts/shell-schemas.mjs` generates the published JSON Schema files from runtime definitions.

Acceptance must cover early exit, fixed-window batching, execution deadlines after handoff, cancellation of descendants, delayed/empty output, nonzero exits, exact Unicode input, EOF, backpressure, write/exit races, foreign handles, and cleanup failure. Verify that UI and model process states agree.

For output, test the exact line/byte boundaries, oversized Unicode lines, direct truncation with a complete programmatic result, programmatic head/tail truncation, readable immutable running snapshots, and read ranges above 64 MiB. After a truncated observation, the next wait must return only later bytes. A terminal wait with no new bytes returns empty output immediately. Neither a notice nor a file read consumes output. A CodeMode spill must contain only script-emitted content, with its own limits intact.

Real-process tests cover Git Bash and PowerShell Unicode input/EOF, incremental output, immutable snapshots, independent projections, cancellation, deadlines, and authorized range reads above 64 MiB. Local HTTP provider fixtures exercise direct, mixed, and CodeMode-only calls across scripts, action permissions, early terminal waits, and repeated stops. These tests do not call an external model service. POSIX process-group cleanup still needs execution on macOS/Linux. Real-provider schema acceptance and model behavior remain separate evaluation work; source precedent and fixture tests do not establish a model-performance benefit.
