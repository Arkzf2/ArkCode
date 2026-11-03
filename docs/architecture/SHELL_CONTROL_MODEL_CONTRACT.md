# Shell tool descriptions and model context

Status: implemented contract, revised 2026-11-03. [Architecture](SHELL_CONTROL_PROPOSAL.md) describes ownership and integration; [the schema bundle](shell-control/README.md) contains input and programmatic result schemas generated from the implementation with `npm run schemas:shell`.

## Tool descriptions

Edit and append to the selected Pi shell definition. Preserve cwd, stdout/stderr, its existing tail-preview/file statement, optional timeout, and ArkCode's OS-privilege sentence. The only base-text edit here clarifies 50KB as 50 KiB. The bash rendering below matches the input schema exactly. For PowerShell, derive the base paragraph from Pi's PowerShell factory so the first sentence names PowerShell.

### bash

```text
Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50 KiB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.

Returns process status and a short session_id. Commands that finish sooner return immediately; commands still running after the requested observation window continue in the same session. This is not a failure. Use shell_control to wait, send input, or stop that session instead of launching the command again. Already-finished sessions return immediately. wall_time_seconds reports this call's actual elapsed seconds, not cumulative process lifetime. A running session's saved file is an immutable snapshot of the command output captured so far. Read saved output only when needed for the task. Programmatic callers receive independently bounded structured output.

Runs with your OS privileges; commands can access paths outside the workspace.
```

| Argument | Model-visible field description |
| --- | --- |
| `command` | Command interpreted by the selected shell in the current working directory. |
| `yield_time_ms` | Maximum initial observation time in milliseconds, default 10000, range 10000 to 60000. Earlier exit returns earlier; expiry leaves the process running. |
| `timeout` | Optional execution deadline in seconds, 1 to 600, no default. Expiry cancels the process tree, including after handoff. |
| `stdin` | closed by default. pipe permits later exact input through shell_control. No PTY is allocated. |

### shell_control

```text
Wait for, send input to, or stop an existing shell session, returning newly collected output and current process status. Already-finished sessions return immediately; wait never forces a finished process to wait out the budget. wall_time_seconds reports this call's actual elapsed seconds, not cumulative process lifetime. Model-facing text shows at most the last 2000 lines or 50 KiB, whichever limit is reached first; truncated output is saved to a file. Programmatic callers receive independently bounded structured output. Later calls do not replay content omitted from earlier responses. Use action "wait" to observe the session, "send" to write exact input and optionally close stdin, or "stop" to request process-tree cancellation. Status "stopping" does not confirm termination.
```

| Branch | Argument | Model-visible field description |
| --- | --- | --- |
| wait | `action` | Observe until exit, observation expiry, or user steering. Return new output; never replay earlier omitted logs. |
| wait | `session_id` | Short opaque session_id returned by bash in this agent run. Pass it unchanged to shell_control; never use an OS PID. |
| wait | `wait_ms` | Observation budget in integer milliseconds, default 10000, range 10000 to 300000. Earlier exit and finished sessions return earlier. Expiry never stops the process. |
| send | `action` | Write exact input, optionally close stdin, then observe. Requires nonempty data or eof true. |
| send | `session_id` | Short opaque session_id returned by bash in this agent run. Pass it unchanged to shell_control; never use an OS PID. |
| send | `data` | Exact UTF-8 input, at most 65536 bytes. No trimming or appended newline. Include \n when required. |
| send | `eof` | After optional data, permanently close stdin. Can be true without data. EOF is not process termination or Ctrl+C. |
| send | `wait_ms` | Observation budget after input delivery, in integer milliseconds, default 500, range 500 to 60000. Earlier exit returns earlier. |
| stop | `action` | Immediately request process-tree cancellation. The host briefly confirms cleanup and returns its confirmed state or stopping. stopping does not confirm termination. |
| stop | `session_id` | Short opaque session_id returned by bash in this agent run. Pass it unchanged to shell_control; never use an OS PID. |

The control input is a root object with an action-discriminated union, expressed as disjoint `anyOf` branches by TypeBox. Reject unrelated fields. There is no read action, public cursor, until, PID, terminate flag, max_output_tokens argument, or has_more result. Use the complete generated schemas rather than a second permissive declaration.

## Timing and input semantics

| Operation | Default | Inclusive range |
| --- | --- | --- |
| bash yield_time_ms | 10000 ms | 10000 to 60000 ms |
| wait wait_ms | 10000 ms | 10000 to 300000 ms |
| send wait_ms | 500 ms | 500 to 60000 ms |

Earlier process settlement returns earlier. The accepted positive windows constrain requested budgets, not actual elapsed time. Observe across progress chunks until settlement, deadline, or user steering. Finished sessions return immediately. Preview truncation does not make a subsequent live wait return immediately. Wait expiry leaves the process running. An optional bash timeout is a separate execution deadline in seconds, 1 to 600 including fractional seconds, without a default.

Stop accepts only action and session_id. After validation and authorization, issue cancellation immediately, then let the host observe cleanup for up to an internal 5000 ms. Return cancelled on confirmed tree cleanup or stopping while cleanup remains pending. Pending cleanup continues after return. A cleanup failure is explicit and blocks further execution rather than claiming termination. This is an internal host policy, not a model argument or a delay before cancelling. A settled session returns its existing state immediately. Repeated stops do not reset cancellation or extend the original confirmation budget; they return current state. Use wait if later confirmation is needed.

Validate original arguments before side effects. Pi's ordinary validator coerces numeric strings and truncates fractional integers, so use its public prepareArguments hook for strict validation against the same schema first. Handlers fill omitted defaults explicitly. Action selects wait defaults; empty input does not implicitly select a wait branch.

Send requires nonempty data or eof true. Do not trim, append a newline, or reinterpret control bytes as a terminal signal. Close stdin only after supplied data is delivered. Input acceptance confirms the pipe write/close, not application processing. The host input-delivery timeout is 5000 ms, independent of the post-write observation window; total call duration can include both. Reject input above 65536 UTF-8 bytes before writing. Unknown delivery is never automatically retried.

Codex infers input versus polling from empty/nonempty chars and uses different effective waiting ranges. ArkCode's explicit actions express the same distinction while making EOF and cancellation unambiguous. EOF alone is an input operation, not a poll. Application exit statements can be sent when that program recognizes them; they are not a generic process stop. Stop requests host cancellation and reports whether cleanup is confirmed.

## Shared model guidance

Register this once alongside the available tools:

```text
Each bash call starts a fresh shell; variables and directory changes do not carry between calls. Use a finished result directly. Track session_id for running work; do independent work and use shell_control wait when the result is needed. Observation expiry leaves the process running. Do not repeat the launch to collect its result. Empty output and open stdin do not prove success or a need for input.
wall_time_seconds measures only the current bash or shell_control call in seconds, not cumulative process lifetime. A still-running notice names the requested observation window in milliseconds, not measured elapsed time. Already-finished sessions return immediately. CodeMode's Script completed means the JavaScript ended; a nested command may still be running.
Direct output previews keep at most the last 2000 lines or 50 KiB; programmatic output has an independent 1 MiB payload limit. Read saved output only when needed. Later waits return new output only, never earlier omitted logs. CodeMode applies its own output configuration to script-emitted text.
Send exact input only when the program protocol calls for it, include newlines explicitly, and close stdin with eof only when input is complete. Do not automatically resend input whose delivery is unknown. stop immediately requests cancellation; stopping does not confirm cleanup. Use wait if later confirmation is needed.
Sessions belong to this agent run across tool calls and CodeMode scripts; run end cleans them up. User steering releases observation without killing the process; explicit interruption stops owned work. Completion notices report undelivered settlement without consuming output. Before the final answer collect still-relevant results and do not claim unobserved work completed.
```

Completion notices are delivered with the next model request during the active run. They report settlement not already delivered by a tool result and do not consume output or replay omitted logs. They do not wake an idle model.

## Result contract and projections

Both tools return structuredContent matching the shared programmatic schema and a human-readable content projection. They use one capture snapshot and the same process state. Their text/data limits are intentionally independent, matching Pi's current separation.

| Programmatic field | Meaning |
| --- | --- |
| kind | session for a process observation; error for a tool/infrastructure failure |
| session_id, status | Short owned handle (`sh_` plus eight random hexadecimal characters) and running, stopping, completed, failed, cancelled, or timed_out |
| output | New interval output for a script, independently bounded at 1 MiB payload; larger data keeps head/tail and a bounded omission marker |
| truncated | Whether this programmatic interval was truncated; it does not describe the direct-text preview |
| truncation | Required when truncated: head_tail mode, byte reason, complete-prefix totals, interval bytes, shown payload bytes, omitted bytes |
| output_file | Authorized immutable complete-prefix file through this capture snapshot; required when either text or structured data truncates, optional otherwise |
| stdin_open | Whether future pipe writes remain possible; not an input request |
| wake_reason | exit, wait_limit, user_steer, stop_unconfirmed, or cleanup_failed |
| wall_time_seconds | Actual duration of this call in seconds, including execution preparation, input delivery, observation and output capture, excluding approval; not cumulative process lifetime |
| message | Continuation guidance while running, naming the requested observation budget on expiry and the same session_id to pass to shell_control |
| exit_code, signal | Actual OS values in terminal results only, nullable when unavailable |
| termination_reason | Managed stop, timeout, or user_interrupt, separate from actual OS exit data |
| input | accepted on successful send; handler errors may also report not_sent or unknown |
| cleanup | pending, confirmed, or failed; pending/failed cannot claim terminal cancellation |
| output_lost_bytes | Known actual capture loss since the previous observation; normal truncation is not loss |

Shell executable and cwd remain in host receipts, permission checks and the environment context; they are not repeated in model-visible shell results. Session ids are checked for collisions and not reused during a ManagedShell instance's lifetime, including across agent runs.

The direct text body keeps only the latest 2000 lines or 51200 UTF-8 bytes in that interval. State and truncation notices sit outside this body limit. It can truncate while structured output is complete. In that case structured truncated is false, but output_file still identifies the complete saved snapshot. Do not print both full text and full JSON beside each other for direct calls.

Structured data above 1 MiB keeps UTF-8-safe head and tail plus a short marker such as `[... 845112 bytes omitted ...]`. The 1 MiB budget covers payload; the marker is bounded separately. Its shown_bytes and omitted_bytes describe actual decoded UTF-8 bytes after boundary adjustment, with observation_bytes equal to their sum. This is independent of CodeMode's outer maxOutputTokens setting, currently default 10000.

On every committed observation, advance through the entire newly captured interval, even if one or both projections omit bytes. Never queue omissions for the next wait. After a final result, repeated waits return empty output immediately if no new bytes remain. Errors before commit, UI subscribers, notices, and saved-file reads do not consume this position. Do not promise exactly-once transport delivery or replay after a lost response.

Normal nonzero exits are session failed results with actual exit data and no transport error solely for that exit. Expected handler errors set the transport-error flag and include a bounded error code/message, optional nonconsuming known-session snapshot, and input-delivery state. Initial codes are invalid_arguments, spawn_failed, session_not_found, session_expired, session_limit, observation_in_progress, stdin_closed, process_exited, stdin_write_failed, permission_denied, and internal_error. Foreign handles reveal no other owner's metadata.

### Example structured results

```json
{"kind":"session","session_id":"sh_a1b2c3d4","status":"running","output":"Building...\n","truncated":false,"stdin_open":false,"wake_reason":"wait_limit","wall_time_seconds":10.014,"message":"[still running after the 10000ms observation window; session_id: sh_a1b2c3d4] Use shell_control with action \"wait\" and this session_id when the result is needed. Do not launch the command again."}
```

```json
{"kind":"session","session_id":"sh_a1b2c3d4","status":"completed","output":"All checks passed.\n","truncated":false,"stdin_open":false,"wake_reason":"exit","wall_time_seconds":0.814,"exit_code":0,"signal":null}
```

```json
{"kind":"session","session_id":"sh_e5f60718","status":"running","output":"","truncated":false,"stdin_open":false,"wake_reason":"wait_limit","wall_time_seconds":0.503,"input":{"state":"accepted"},"message":"[still running after the 500ms observation window; session_id: sh_e5f60718] Use shell_control with action \"wait\" and this session_id when the result is needed. Do not launch the command again."}
```

```json
{"kind":"error","error":{"code":"stdin_write_failed","message":"Input delivery is unknown. Do not resend automatically; inspect the session before deciding what to do."},"session":{"session_id":"sh_e5f60718","status":"running","stdin_open":false},"input":{"state":"unknown"}}
```

These are illustrative observations, not measured timing guarantees.

## Direct truncation context

Use Pi's existing tail convention, with explicit wording that the preview was truncated. This schematic omits the actual 2000-line body for brevity:

```text
Session: sh_a1b2c3d4 | Status: running | Process continues.
Wall time: 10.014 seconds | Observation: wait_limit | Stdin: closed
[still running after the 10000ms observation window; session_id: sh_a1b2c3d4] Use shell_control with action "wait" and this session_id when the result is needed. Do not launch the command again.

<actual tail preview of this observation>

[Output truncated. Showing lines 501-2500 of 2500 captured lines; preview limit: 2000 lines or 50 KiB. Full output captured so far: C:\Temp\ark-shell-example\snapshot-1.log]
[Read the saved file only if needed. Later waits return new output only.]
```

The implementation supplies the real absolute path, never the illustrative path above. The file includes the entire command prefix. On the next result, if the process produced lines 2501 to 2503, return only those lines. Do not return omitted lines 1 to 500. If it produced nothing, say no new output and preserve the actual status.

For byte-limited previews, also identify the 50-KiB limit. For an oversized last line, say `Output truncated. Showing the UTF-8-safe suffix of line N; earlier bytes of that line are omitted.` The footer still names the readable file. Use global 1-based file line numbers with Pi-compatible line counting, including an incomplete final line. If a new interval begins mid-line, do not replay its earlier bytes.

Terminal text names completed/failed/cancelled/timed_out and actual exit data. A truncated terminal result does not instruct the model to wait, read all logs, or rerun the command. Its saved file is final. A running snapshot contains output only through this response, and never changes afterward.

## Situation-specific context

| Situation | Required facts or concise wording | Intended next action |
| --- | --- | --- |
| Short successful command | completed, actual exit code, output | Use the result directly |
| Live observation expires | running, id, wait_limit; process continues | Do independent work or wait when the result is needed |
| Live observation has no new output | Empty body plus live status | Do not infer success, a hang, or required input from silence |
| Process ends before observation budget | Terminal state and this call's wall_time_seconds | Use the result immediately |
| Ordinary nonzero exit | failed with actual code/signal and output | Diagnose the command result |
| Spawn fails | spawn_failed; command did not start | Fix the cause without inventing a live handle |
| Direct preview truncates | Tail, omitted-content notice, file range and path | Read relevant file ranges only when needed |
| Programmatic data truncates | Head/tail, truthful structured truncation, file path | Filter or read saved data if needed; do not assume a complete parseable document |
| A later wait after truncation | Only new interval output, possibly empty | Never use wait to recover earlier omitted bytes |
| File export fails | Tool error with known state/input delivery | Do not claim a readable saved log; do not replay accepted input |
| Actual capture loss | Explicit failure and known lost bytes, no false full-log claim | Respect the evidence limit |
| Input accepted, process alive | accepted, stdin state, current process state | Inspect response; empty output is not a reason to resend |
| EOF accepted | accepted and stdin_open false | Wait if computation continues; do not claim EOF stopped it |
| Stdin already closed | stdin_closed and not_sent | Cannot reopen the same input pipe |
| Process exited before send | process_exited, not_sent, terminal snapshot | A wait may collect later unobserved bytes, never prior omissions |
| Write races with closure | stdin_write_failed, conservative unknown delivery | No automatic resend |
| Stop not confirmed | stopping, stop_unconfirmed, pending cleanup | Do not claim termination; use wait if confirmation is needed |
| Cleanup fails | stopping, failed cleanup, original termination reason | Report uncertainty, retain observation/cleanup access |
| Stop confirmed | cancelled, real exit data, stop reason, confirmed cleanup | Treat the owned tree as stopped |
| Stop after natural completion | Preserve terminal state | Do not relabel natural completion |
| Execution deadline | stopping until cleanup confirmed, then timed_out | Distinguish it from an observation deadline |
| User steer releases wait | user_steer and current state; if live, process continues | Handle the new input |
| Unknown, foreign, or expired id | Bounded unknown/expired error | Use authoritative current-run context; do not substitute an OS PID |

## Modes, completion, and context recovery

Direct mode exposes native tools. Mixed CodeMode supports native and nested calls. CodeMode-only exposes nested calls. The same session state, permissions, and observation watermark apply to all three. There is no output replay on a mode change.

Pi's CodeMode executor forwards structuredContent when an output schema is declared, including some structured error results. Scripts inspect kind/status, await calls, and handle pre-validation rejects. Preserve relevant output, ids, and file paths before a script finishes. Output received by a script is observed even if that script never prints it.

CodeMode output follows its own configuration. Its spill file contains script-emitted text only, not hidden shell output. Nested shell results retain their independent 1-MiB programmatic limit. Reading a relevant saved-log range is separate from waiting for new process output. Authorized text reads use bounded streaming and support saved files above 64 MiB.

Completion notices are metadata-only and never consume output. Deliver an undelivered terminal state once during the active run, with id, real exit data, cleanup facts, and an available artifact reference. A notice can say `Use wait if output produced since the last observation is relevant.` It cannot promise recovery of prior omitted content. Suppress notices superseded by a terminal tool result; a stopping response is not terminal delivery. Other jobs' notices must not act as new user steering.

On compaction or mode change, restore a short inventory with id, command label, state, stdin, relevant file reference, and lifetime. Do not repeat logs or expose expired ids as active. At run end/restart, report historical cleanup when relevant instead of promising reattachment.

## Verification before implementation acceptance

Check strict timing/input schemas, early exit, fixed batching, structured status invariants, exact Unicode writes, EOF, delivery uncertainty, cleanup races, mode permissions, and lifecycle cleanup. Verify actual byte and line limits, not just JSON Schema maxLength, which counts characters.

Verify independent direct/programmatic truncation on one snapshot, complete-prefix immutable files, marker accounting, and new-only waits after either truncation. Test authorized bounded reads above 64 MiB and mutation rejection. Keep CodeMode outer output configuration and files independent. Schema/adapter/helper probes alone do not prove runtime behavior or remote provider acceptance.
