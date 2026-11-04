# Choose permissions and trust levels

English | [简体中文](../../zh-CN/guides/permissions.md) | [Docs home](../README.md)

## Choose an approval mode

Use `/permissions` to choose a mode; it is saved as the default for the next launch. The CLI `--permissions` overrides one launch.

| Mode | Auto-allowed | Still asks |
| --- | --- | --- |
| Always Ask, `always-ask` | Built-in read, grep, glob; standalone directory listing of the current shell; shell wait and stop; existing ordinary session authorizations matching identity and parameters | Other writes, commands, shell send, and MCP calls |
| Ask When Needed, `ask-when-needed` | Ordinary built-in actions, shell wait and stop; ordinary tools matching user-level MCP auto-approval rules | Limited high-risk shell rules, shell send, MCP destructive tools, and other unapproved MCP calls |
| Never Ask, `never-ask` | Does not wait for tool call approval | Server enabling, filtering, file boundaries, viewer, and recovery protections still apply |

The Always Ask directory listing exemption applies only to a standalone `ls`; PowerShell also supports `Get-ChildItem`. Pipelines, redirection, command substitution, and chained commands are not part of the exemption.

The approval panel can allow once, allow the same operation for this session, or deny. Authorization binds the full parameters, directory, and shell; MCP also binds configuration, schema, and connection identity. Stop, permission switches, and history resume do not reuse old approvals. High-risk commands, shell send, and destructive MCP calls require approval each time in both ask modes.

## Understand the risk check scope

Ask When Needed checks a limited set of rules: shutdown, formatting, raw device writes, recursive forced deletion, and some command wrappers and nested shells. It does not analyze arbitrary scripts or all side effects. `git push`, `git reset --hard`, and Python scripts do not require approval solely because of these limited rules.

When POSIX command parsing fails, times out, or meets an unsupported heredoc, Ask When Needed auto-allows and Always Ask asks. Deletion targets under `/tmp` or `/temp` without variables, wildcards, or `..` have a rule exception. Therefore Ask When Needed is not limited to commands without side effects.

File tools have workspace, sensitive path, symlink, and size limits. Shell executes with the current user's system permissions and can access outside the workspace. MCP operations run on external services, and MCP roots are not an OS sandbox.

## Trust a project

Choose whether to trust a directory when you open it for the first time, or pass `--trust` explicitly. Trust allows loading project AGENTS.md, project Skills, and `.arkcode/mcp.json`. Connecting a stdio MCP server starts commands from project configuration before specific tool call approval.

An untrusted directory keeps global AGENTS.md and user Skills, skips project resources, and defaults to Always Ask; explicit CLI permissions still apply. User-level configuration is always trusted user configuration.

MCP auto-approval can only be set in the user `mcp.json`; see [MCP configuration](../reference/mcp-config.md). Approval and tool exposure are independent; see [Tool modes](../reference/tool-modes.md).
