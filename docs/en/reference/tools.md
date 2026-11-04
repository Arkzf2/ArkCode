# Tools reference

English | [简体中文](../../zh-CN/reference/tools.md) | [Docs home](../README.md)

This page describes the tools ArkCode offers to the model. They are not a standalone HTTP or SDK interface. The seven built-in tools are available in all three approval modes; call form is decided by [Tool modes](tool-modes.md), and execution still goes through [permissions checks](../guides/permissions.md). For exact inputs, see the [generated tool definitions](../../shared/generated/tool-inputs.json).

## File tools

| Tool | Required arguments | Optional arguments and behavior |
| --- | --- | --- |
| `read` | `path` | `offset` is a 1-based line number, `limit` caps lines; supports text and supported images |
| `write` | `path`, `content` | Writes the complete content; can create parent directories; not a merge based on an old version |
| `edit` | `path`, `edits` | Each item has `oldText` and `newText`; all items match the original file, oldText must be unique, items must not overlap |
| `grep` | `pattern` | `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`; default match cap 100, case-sensitive, regex, 0 context lines |
| `glob` | `pattern` | `path`, `limit`; default result cap 1000 |

File tools stay inside the workspace; real paths and symlinks cannot cross it. `.git` and `.arkcode` are not exposed, and ordinary reads reject credential files; `.env.example` can be read explicitly, but grep and glob exclude `.env*`. grep and glob skip dependency and metadata directories. glob reports an error when it traverses more than 10000 files; narrow the path.

Ordinary text files and write content have a 2 MiB limit. Registered Skill files and tool output files have separate read-only authorization. That authorization does not allow writing into their directories or accessing other files in the same directory. Image content, text truncation, and errors may have different return forms; do not assume every tool returns JSON.

edit and write serialize against actual files within the same process SDK instance; different terminal processes, shell, MCP, and external editors are not protected by that queue. A full write can still overwrite another write. A tool failure does not automatically undo earlier actions.

## bash

`bash` is the fixed tool name. The actual interpreter may be Git Bash, PowerShell, or `/bin/sh`, depending on the session environment and `/status`. Execution failure does not switch interpreters automatically. For the exact schema, see [bash input](../../shared/schemas/bash.input.schema.json).

| Field | Constraint |
| --- | --- |
| `command` | Required non-empty string, executed with the actual shell syntax |
| `yield_time_ms` | integer milliseconds, default 10000, range 10000 to 60000 |
| `timeout` | optional execution limit, 1 to 600 seconds, decimals allowed, no default |
| `stdin` | `closed` or `pipe`, default closed, no PTY |

When the observation window expires, the tool returns `running` with a short `session_id`; the process keeps running. Wait with the same handle; do not restart the command. The execution limit acts independently and requests cancellation of the process tree when it expires.

## shell_control

Performs wait, send, or stop on an existing handle within the current agent run. `session_id` is an opaque handle, not an OS PID, and is not promised across user turns. For the exact schema, see [shell_control input](../../shared/schemas/shell_control.input.schema.json).

| action | Arguments and defaults |
| --- | --- |
| `wait` | required session_id; wait_ms default 10000, integer range 10000 to 300000 |
| `send` | required session_id; requires non-empty data or eof=true; wait_ms default 500, integer range 500 to 60000 |
| `stop` | accepts only action and session_id; starts cancellation immediately, does not accept wait_ms |

An ended process returns immediately. wait does not return on one progress event, and observation expiry does not terminate the process. Overlapping waits on the same handle are rejected, but send and stop are allowed during a wait.

send requires the process to have started with pipe. It passes the string exactly, without trimming or adding a newline, up to 65536 UTF-8 bytes. EOF closes stdin permanently; it is not termination or Ctrl+C. `accepted` proves delivery only, not program processing; `unknown` must not be resent automatically. Every send needs approval in both ask modes.

stop waits up to an internal 5000 ms for cleanup confirmation. `stopping` means not all descendants are confirmed stopped; a later wait can get the final state. A cleanup failure keeps the unconfirmed state and blocks further execution. Repeated stop does not extend the original confirmation deadline.

## Shell results and output

The structured result is defined exactly in the [shared result schema](../../shared/schemas/shell.result.schema.json).

| Field | Meaning |
| --- | --- |
| `kind` | `session` or `error` |
| `status` | session: running, stopping, completed, failed, cancelled, or timed_out |
| `session_id` | handle usable within the same run |
| `output` | new structured output of this call |
| `wake_reason` | exit, wait_limit, user_steer, stop_unconfirmed, or cleanup_failed |
| `wall_time_seconds` | this call's duration in seconds, excluding approval, not cumulative process lifetime |
| `exit_code`, `signal` | real exit information at a terminal state |
| `termination_reason`, `cleanup` | cancellation or timeout reason and cleanup confirmation state |
| `truncated`, `truncation`, `output_file` | whether structured output was omitted, why, and the saved path |
| `input` | delivery state; error results may be accepted, not_sent, or unknown |
| `error.code`, `error.message` | tool call failure reason; different from a process normal non-zero exit |

| Output layer | Limit and truncation |
| --- | --- |
| Text directly to the model | at most 2000 lines or 50 KiB at the tail of this increment, whichever limit hits first |
| Structured shell data received by CodeMode | separate 1 MiB; when exceeded, keeps head and tail and marks omission |
| Script output CodeMode passes to the model | uses its own output budget, currently default 10000 tokens |

Later waits return only new output; omitted content is not resent. On truncation, the complete log or an immutable complete prefix snapshot of the running output is saved; use read with offset and limit to read more. Registered text output supports ranged reads beyond 64 MiB files; authorization expires when the file identity changes or the run instance ends, and history resume does not restore it.

A CodeMode script ending does not mean a nested process ended. Scripts must check `kind` and `status` and handle rejects caused by argument validation. The whole agent run end, interruption, or runtime exit cleans up persistent processes.

## Dynamic tools

`WebSearch` registers only when the search toggle and protocol are available. Its input is a non-empty `query`, up to 4000 characters; see the [search guide](../guides/web-search.md). MCP tools are discovered from the actual service and follow filtering and [exposure configuration](mcp-config.md). These dynamic tools are not part of the generated catalog of the seven fixed built-in tools.
