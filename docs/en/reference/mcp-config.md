# MCP configuration reference

English | [简体中文](../../zh-CN/reference/mcp-config.md) | [Docs home](../README.md)

The config file is strict JSON. The root object contains only `mcpServers`, and the file is at most 1 MiB. Each server name consists of letters, digits, dots, underscores, and hyphens, and starts with a letter or digit. Unknown fields in a server entry fail diagnostics for that entry.

## Sources and overrides

ArkCode reads user `<home>/mcp.json` first, then trusted workspace `.arkcode/mcp.json`. A project server with the same name replaces the user server completely; fields are not merged and auto-approval is not inherited. Untrusted projects skip project configuration.

`autoApproveTools` can only set non-empty rules in user configuration. When a project entry contains non-empty auto-approval rules, that server does not load; it does not fall back to the overridden user entry.

## Common fields

| Field | Type, default, constraint |
| --- | --- |
| `enabled` | boolean, default true |
| `description` | optional string |
| `exposure` | codemode, deferred, direct, hidden; default codemode |
| `toolExposure` | optional object; sets exposure per raw tool name or Pi `*` pattern |
| `enabledTools` | optional non-empty string array; omitted means all candidates, empty array means no tools |
| `disabledTools` | string array, default [], excluded first |
| `autoApproveTools` | string array, default [], user-level configuration only; used only by Ask When Needed |
| `startupTimeoutMs` | positive integer, default 60000, max 300000; includes startup and tool discovery wait |
| `toolTimeoutMs` | positive integer, default 30000, max 300000 |

`enabledTools`, `disabledTools`, and `autoApproveTools` match globs against the service's raw tool names. Filtering precedes exposure and approval. `readOnlyHint` does not grant call permission automatically; `destructiveHint` always requires approval in both ask modes.

## stdio fields

| Field | Type, default, constraint |
| --- | --- |
| `transport` | omitted or `stdio` |
| `command` | required non-empty string |
| `args` | string array, default [] |
| `cwd` | optional non-empty path; relative paths use the current workspace |
| `env` | string key-value object, default {}; `${NAME}` in values reads the environment variable at connection time |

Connecting starts the configured command; it does not wait for model tool approval. stdout is for the MCP protocol; service logs should go to stderr. Windows `.cmd` startup is handled by the transport layer. A first npx or uvx download also counts against the startup budget.

## Streamable HTTP fields

| Field | Type, default, constraint |
| --- | --- |
| `transport` | omitted or `http` |
| `url` | required HTTP(S) URL, must not embed credentials |
| `headers` | string key-value object, default {}; supports `${NAME}` |
| `bearerTokenEnvVar` | optional environment variable name; reads the bearer token at connection time |

A missing environment variable fails the connection. OAuth credentials are stored separately in `<home>/mcp-auth.json`, managed with `/mcp login` and `/mcp logout`; do not edit token files by hand.

## Effect and invocation

The effect boundaries of `exposure` and `toolExposure` are in [Tool modes](tool-modes.md). Server shutdown, config removal, and tool filtering block actual calls immediately. Old approvals cannot be reused after a connection rebuild or schema change.

Model tool names use the form `mcp__SERVER__TOOL`; name cleaning, oversized names, and conflicts may add a hash. Constructing a name cannot call a tool that was not discovered or was filtered.

Ordinary failures and timeouts do not replay tools automatically. When a service explicitly reports session expired, the runtime may rebuild the session and retry once, still through a new connection authorization. Cancelling a request does not guarantee that external side effects were undone.

MCP resources and prompts management, legacy HTTP+SSE, cross-client configuration import, and file watchers are not currently open. Configuration changes use reload or reconnect; see the [MCP guide](../guides/mcp.md) for operations.
