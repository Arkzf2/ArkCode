# JSON events reference

English | [简体中文](../../zh-CN/reference/json-events.md) | [Docs home](../README.md)

`--json` implies print. stdout is JSONL; each non-empty line is one object, distinguished by `type`. This page records ArkCode `0.1.0` actual output. There is no separate protocol version number, and the stream is not a passthrough of all Pi events.

## Event fields

| type | Fields |
| --- | --- |
| `status` | model, thinking, cwd, permission, branch, context, state, queued, viewer; plus sessionId, sessionName, backgroundSessions, executionBlocked, shellSessions, initializing, mcpServers, skills when present |
| `message` | role is user, assistant, info, or error; text is the body |
| `assistant_delta` | text, the delta of this turn |
| `assistant_end` | text, the complete text of this answer |
| `reasoning` | id, text, active; present only when the provider provides it |
| `tool` | id, name, text, state; may have target, exitCode, diff |
| `approval` | request, decision; in print, decision is once or deny |

tool.state is running, done, or error; the same id can have multiple updates. text is display text and is not guaranteed to be the complete structured result of the tool. `assistant_end` should not be appended directly after an existing delta; that duplicates the answer.

status.context is `{ "tokens": number, "contextWindow": number, "percent": number }`; unknown is null. status.state kind is idle, running, awaiting-approval, or stopping. idle includes outcome: completed, failed, interrupted, or null; other states include run id and startedAt, and approval state has request.

approval.request contains id, tool, description, and cwd, and may have invocation. The invocation fields differ for file, shell, shell_control, and MCP. A parser should branch on kind and cannot assume `command` always exists.

## Order and termination

One run can contain multiple assistant answers and multiple tool calls. Status, tool, and delta events can interleave. Approval events happen before action dispatch; denied actions do not run. Errors can appear as message, tool, or final state.

Wait for the process to exit and check the [exit code](cli.md), while also handling the final run state. There is no separate `run_finished` event. Startup and configuration errors may write only to stderr and return a failing exit code; stdout may be empty.

The following show single event shapes; they do not form a complete stream or a fixed sequence:

```json
{"type":"assistant_delta","text":"The project entry is at "}
```

```json
{"type":"assistant_end","text":"The project entry is at src/cli.ts."}
```

```json
{"type":"tool","id":"call_1","name":"read","text":"File contents","state":"done"}
```

JSON content can contain user text, tool parameters, and paths. Hidden environment context is not emitted as UI messages; JSON is not a complete record of the raw model request.
