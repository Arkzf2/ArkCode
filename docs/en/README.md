# ArkCode documentation

English | [简体中文](../zh-CN/README.md)

This site explains how to use, configure, and interface with ArkCode `0.1.0`. Start with the [Quickstart](quickstart.md).

## Day-to-day usage

| Task | Document |
| --- | --- |
| Configure models, keys, or compatible endpoints | [Model configuration](guides/models.md) |
| Submit tasks, handle the queue, and view output | [Terminal usage](guides/terminal.md) |
| Run tasks in parallel, resume, or fork | [Session management](guides/sessions.md) |
| Choose approval modes and project trust | [Permissions and trust](guides/permissions.md) |
| Set long-lived rules for a project | [Using AGENTS.md](guides/instructions.md) |
| Choose and manage reusable workflows | [Using Skills](guides/skills.md) |
| Connect external tools | [Using MCP](guides/mcp.md) |
| Inspect and use provider web search | [Using Web Search](guides/web-search.md) |
| Run tasks in scripts or CI | [Scripting](guides/scripting.md) |

## Interface reference

| Content | Reference |
| --- | --- |
| Launch arguments, subcommands, exit codes | [CLI](reference/cli.md) |
| Slash commands and shortcuts | [Interactive commands](reference/commands.md) |
| Config directory, settings, models, environment variables | [Configuration](reference/configuration.md) |
| MCP transports, filtering, authentication, overrides | [MCP configuration](reference/mcp-config.md) |
| Skill format, discovery, and reading rules | [Skills reference](reference/skills.md) |
| Tool arguments, shell control, output limits | [Tools reference](reference/tools.md) |
| CodeMode and when settings apply | [Tool modes](reference/tool-modes.md) |
| Non-interactive JSON format | [JSON events](reference/json-events.md) |
| Exact summary generation instructions | [Compaction prompt reference](reference/compaction-prompts.md) |
| System dependencies, platform verification, feature scope | [Platforms and limits](reference/platforms.md) |

## Understanding behavior and troubleshooting

- [Session lifecycle](concepts/session-lifecycle.md) explains sessions, runs, handles, and history.
- [Context and compaction](concepts/context-and-compaction.md) explains what the model actually sees and how work continues after compaction.
- [Troubleshooting](troubleshooting.md) covers model connections, MCP, viewer, Execution unconfirmed, shell, and compaction issues.

For development and documentation checks, see [Contributing](../../CONTRIBUTING.md).
