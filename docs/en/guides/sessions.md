# Manage sessions

English | [简体中文](../../zh-CN/guides/sessions.md) | [Docs home](../README.md)

## Create and switch sessions

Run `/new` to create an independent session. The old session stays; running model requests, tools, and the queue continue. Each session has its own history, draft, approvals, shell, and MCP connections.

Run `/sessions`, or press Left in an empty composer, to open the cross-project session list. Arrow keys move, Enter opens, `/` searches, Tab switches the status filter, `g` changes grouping, `n` creates a new session in the selected project, and Esc returns.

Background sessions show a note when they need approval; the approval panel appears only after you switch back. Ctrl+C interrupts only the current session; exiting the terminal stops all sessions owned by that terminal.

## Resume history

Run this in the target project:

```powershell
	arkcode resume --last
	arkcode resume SESSION_ID
```

Replace `SESSION_ID` with the ID shown by `/status` or the list. `resume --last` selects the most recent session of the current workspace; in the TUI you can select across projects from `/sessions`. Resume shows the full history of the current branch, including messages from before compaction, but does not replay historical tools, drafts, or the queue.

Switching to an untrusted project asks you to choose a trust level again. When opening fails, the original session and draft are kept.

## Create a fork

Run `arkcode fork SESSION_ID`, or run `/fork` in the UI to fork the current session. `/fork ID` selects a saved session of the current project. You must submit at least one task and save history before forking.

A fork copies the conversation and tool policy from the starting point, uses the same workspace, and does not create a Git branch or worktree or roll back files. Coordinate concurrent edits to the same files yourself.

## Handle a read-only viewer

One session has one writable host at a time. When another terminal opens it, that terminal becomes a read-only viewer, periodically refreshes saved history, and cannot submit tasks, steer, rename, or change session settings.

A viewer can use `/new` or `/fork` to create an independent session. After the original host exits, reopen the session in the viewer's `/sessions` to retry acquiring write rights. Session locks are keyed by session ID; a different `--home` does not bypass the lock.

For Execution unconfirmed and stale locks, see [Troubleshooting](../troubleshooting.md). For the difference between a session and one run, see [Session lifecycle](../concepts/session-lifecycle.md).
