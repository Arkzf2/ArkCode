# Tool modes and effect timing

English | [简体中文](../../zh-CN/reference/tool-modes.md) | [Docs home](../README.md)

The tool mode decides how the model calls the seven built-in tools; it does not decide execution permissions. `WebSearch` follows the same built-in mode policy, and MCP exposure is configured separately.

| toolMode | Direct built-in calls | Calls through CodeMode |
| --- | --- | --- |
| `direct` | yes | no |
| `codemode` | yes | yes, the default mode |
| `codemode-only` | no | yes |

CodeMode executes JavaScript with QuickJS. Scripts discover tools with `searchTools()` and `describeTool()`, call them with `tools.NAME()`, output with `text()`, and store and load branch-local JSON data with `store()` and `load()`. It has no separate OS access interface and no extra exec or wait background script unit mechanism.

## MCP exposure

| exposure | Behavior |
| --- | --- |
| `codemode` | Default; discovered on demand inside scripts |
| `deferred` | Loaded through tool_search |
| `direct` | Declared directly to the model |
| `hidden` | Hidden |

Built-in codemode-only does not hide MCP tools separately configured as direct. Tool search cannot bypass the built-in mode. Server-side tool catalog updates can still happen during a session; the snapshot does not fix the schema.

## When settings apply

| Case | Policy used |
| --- | --- |
| New session, before the first model request | Latest saved configuration; can be changed repeatedly |
| Session that already requested a model | Current branch policy; new choices show as pending |
| resume, fork | Policy at the fork point and whether the model was already requested |
| Successful manual or automatic compact | Applies the latest tool modes and MCP exposure, writes them into the checkpoint |
| compact cancelled or failed | Keeps the old policy |
| reload, reconnect, enable | Requested sessions keep the current exposure; new servers wait for the policy boundary |
| disable, config removal, tool filtering | Blocks actual execution immediately |

Policy snapshots do not copy credentials, request headers, or startup commands, and do not restore old approvals. Configuration and schema are rechecked at the actual execution boundary. Changing the approval mode takes effect immediately and does not need compact.

`/web-search on` and off apply from the next task. Real MCP catalog revocation, connection identity changes, and tool disabling still affect callability immediately. Mode effect does not promise provider prompt cache hits.
