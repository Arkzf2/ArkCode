# Troubleshooting

English | [简体中文](../zh-CN/troubleshooting.md) | [Docs home](README.md)

## No available model or credential errors

Run `arkcode models` to check models with credentials, use `/connect` to set up a provider, or confirm that the current process can read key environment variables. print requires `--model` or a saved default model.

For a custom endpoint, check the protocol, model ID, and baseUrl. The Anthropic configuration entry rejects a trailing `/v1`; OpenAI-compatible services usually need an API base ending in `/v1`. When an existing provider name is already bound to another endpoint, use a separate name.

If the process still uses old credentials after you change environment variables, check the saved credentials in `/connect`. Authentication saved in auth.json may take precedence over model files and inherited environment. Do not paste keys or complete auth files in issue reports.

## settings.json fails to load

Check strict JSON syntax and the [allowed fields](reference/configuration.md). Pi settings fields cannot be copied directly. The old `read-only` was removed; choose a current permission mode explicitly. Unknown fields, wrong enums, and invalid budgets report errors.

## MCP hangs on startup or connection fails

Use `/mcp status` to view server status and redacted diagnostics. Check that commands and paths exist, stdio stdout writes protocol data only, and required environment variables are set. A first `npx` or `uvx` may be downloading dependencies; install it beforehand or increase `startupTimeoutMs`, up to 300000.

After changing configuration, run `/mcp reload` or `/mcp reconnect SERVER`. Only trusted projects load project configuration. A project entry replaces the user entry completely, does not inherit user `autoApproveTools`, and cannot configure non-empty auto-approval rules.

When a remote service requires OAuth, run `/mcp login SERVER`. After a failed first startup, interactive mode requires you to choose retry or continue with currently available tools; non-interactive mode reports an error directly.

## No change after modifying the tool mode

The latest settings are used before the first model request. A session that already requested a model keeps its branch policy; a successful `/compact` or a new session applies new settings. resume, fork, reload, and reconnect do not replace the old branch policy automatically. Disabling and filtering tools still blocks calls immediately.

## Skills do not appear

Check that the file is named SKILL.md and is in a user or trusted project `.agents/skills` source. Run `/skills reload`, then inspect source diagnostics, disabled state, and shadowed same-name entries. `--home` does not change the user Skills directory, and `.pi/skills` does not participate in discovery.

## Session stays a read-only viewer

Another host may hold write rights for the session. Exit the original host, then reopen the session from `/sessions` to retry. Independent tasks can use `/new` or `/fork`.

If the startup message explicitly reports a stale lock, confirm that no process holds or is recovering the session before cleaning the one lock file named in the message. Do not guess a lock set from directory names and delete a group of locks. When lock ownership cannot be confirmed, the program does not clean up automatically.

## Execution unconfirmed

An old run has no reliable end record. First check the workspace files and external execution state, and confirm that the old command and its descendants have ended. Only after confirmation, edit that session's `<home>/runs/` marker: set status to `interrupted`, add `endedAt`, remove `pid`, and reopen the session.

Do not modify markers for other sessions, and do not treat a marker rewrite as proof that the process ended. A new session can work independently, but it does not mean the old process has stopped.

## Shell command still runs after wait

Observation budget expiry is not an execution timeout. The model should call shell_control wait with the original session_id; to cancel, use stop, then keep waiting until cleanup is confirmed. Do not start the same command again. PowerShell and Bash syntax differ; trust the actual shell shown by `/status`.

When output is truncated, read the saved file returned by read. A later wait does not resend previously omitted log. Handles expire across agent runs; see [Tools reference](reference/tools.md) for details.

## Compaction fails or budget is insufficient

Check that contextWindow and maxTokens match the real model capability and can fit the [reserve budget](concepts/context-and-compaction.md). The compaction request must also fit system rules, tool declarations, and pending user input.

Retry `/compact`, or create a new session after checking task state. Persistence, checkpoint activation, and history write errors require fixing file permissions, disk space, and session ownership first; you cannot bypass them by sending more tasks.

## Search check does not pass

Confirm that the model uses Responses or Anthropic Messages and that the endpoint actually supports server-side search. `/web-search check` must receive a successful search event; a text-only answer means the search did not run. A custom endpoint does not gain search capability merely by declaring the same protocol.
