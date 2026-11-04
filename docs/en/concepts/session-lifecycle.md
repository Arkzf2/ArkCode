# Sessions, runs, and history

English | [简体中文](../../zh-CN/concepts/session-lifecycle.md) | [Docs home](../README.md)

A session stores a conversation you can continue. One submission or continuing the queue produces an agent run, which may call the model multiple times and execute tools. One terminal host can hold several independent sessions; the current view only decides input and display routing.

## Concurrency and ownership

Different sessions can run in the same workspace at the same time. Each session has one host with input and persistence write rights; other hosts become viewers. This constraint stops two processes from rewriting the same session history at once. It does not coordinate file modifications from different sessions in the same workspace.

A fork creates a new branch of session history. It does not create a file snapshot or a Git worktree. The original session stays, and workspace files are shared by all programs that use them.

## Shell handles

When bash returns a command that is still running, `session_id` identifies the ongoing process within the current agent run. It is not the conversation session ID. Multiple tool calls or CodeMode scripts can keep observing the same process; the end of the run cleans up handles and processes.

A tool wait expiry ends only that observation, not the process. Exiting the terminal, interrupting a task, and sending stop all request cleanup. Only a confirmed terminal state means managed process cleanup is complete; external MCP effects are decided separately by the service.

## Save and resume

`sessions/` stores JSONL history and `runs/` stores run markers. History resume reads the conversation and checkpoints without re-executing tools. When an active run marker lacks a confirmed end, resume shows Execution unconfirmed and limits execution.

Interruption does not roll back files. History says what happened in the past; it cannot replace checking the current state of disk, processes, and external services. For user operations, see [Session management](../guides/sessions.md); for exceptions, see [Troubleshooting](../troubleshooting.md).
