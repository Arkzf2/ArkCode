# Interactive commands and shortcuts

English | [简体中文](../../zh-CN/reference/commands.md) | [Docs home](../README.md)

The actual registration of the command catalog is in the [generated directory](generated/commands.md). An unknown slash command reports an error and keeps the draft; it is not sent to the model as an ordinary prompt.

## Slash commands

| Command | Behavior and scope |
| --- | --- |
| `/help` | Shows commands and common keys |
| `/model [provider/id]` | Chooses a model and available reasoning levels, saves the default |
| `/connect` | Configures a provider or custom endpoint; requires idle |
| `/permissions [mode]` | Switches the approval mode immediately, saves the default, and revokes old authorizations |
| `/tool-mode [mode]` | Saves the built-in tool mode; requires idle; see [Tool modes](tool-modes.md) for effect |
| `/web-search [status or check or on or off]` | Search status, real check, and persistent toggle; requires idle |
| `/mcp` | Opens the server management menu; subcommands in the table below |
| `/skills` | Opens the Skills menu; subcommands are `list`, `reload`, `enable NAME_OR_PATH`, `disable NAME_OR_PATH` |
| `/status` | Prints model, workspace, session, permissions, shell, and cumulative usage |
| `/new` | Creates and switches to an independent session; background sessions keep running |
| `/sessions [id]` | Cross-project list; with an ID, opens the matching history of the current project |
| `/rename [name]` | Renames the current session; without a name shows an input box |
| `/fork [id]` | Forks the current session or a saved session of the current project |
| `/compact [instructions]` | Runs ArkCode compaction; optional summary requirements; requires idle |
| `/copy` | Copies the last complete answer |
| `/init` | Generates AGENTS.md from the project; does not overwrite an existing file; requires idle |
| `/exit` | Stops all sessions owned by this terminal and exits |

A viewer can inspect help, status, copy, sessions, MCP, and Skills lists, and can create an independent session with `/new` or `/fork`; it cannot modify the original session, connections, or preferences. Skill write operations also require no unconsumed steer or follow-up, and MCP write operations are constrained by connection and recovery state.

Goal, multi-agent, plugins, learned memory, persistent Plan, and cloud execution commands are currently unavailable.

## MCP subcommands

| Form | Behavior |
| --- | --- |
| `/mcp help`, `/mcp status` | Shows help or status |
| `/mcp tools SERVER` | Shows the tool catalog |
| `/mcp reload` | Rereads configuration |
| `/mcp reconnect [SERVER]` | Reads config and rebuilds the named connection; without a name reloads all |
| `/mcp enable SERVER`, `/mcp disable SERVER` | Saves and applies enable or disable state |
| `/mcp exposure SERVER MODE` | Saves `codemode`, `deferred`, `direct`, or `hidden`; respects policy effect boundaries |
| `/mcp login SERVER`, `/mcp logout SERVER` | OAuth login, or clears credentials and disconnects |

## Shortcuts

| Key or input | Context and behavior |
| --- | --- |
| Enter | Submits when idle; sends a steer during a run |
| Tab | Accepts a completion candidate when one exists; queues a follow-up during a run |
| Shift+Left | Edits unconsumed queue input |
| Left | Opens the session list in an empty composer |
| Esc | Returns in a panel; clears a selection when one exists; otherwise interrupts the task |
| Double Esc | Edits the previous prompt in an empty composer and creates a fork |
| Ctrl+C | Copies with a selection; otherwise interrupts during a run and exits when idle |
| Ctrl+D | Exits in an empty composer |
| Ctrl+T | Expands or collapses tool and reasoning details |
| Ctrl+O | Copies the last complete answer |
| Ctrl+R | Searches prompt history |
| Ctrl+G | Edits the draft with `VISUAL` or `EDITOR` |
| Ctrl+L | Clears the view, keeps history |
| PgUp, PgDn, End | Browse history and return to the latest content |
| `@`, `@skill:` | File and Skill completion, Skill-only completion |
| `!COMMAND` | Runs a user command in the current session shell |

In the session list, Tab/Shift+Tab chooses the status filter, `g` groups, `/` searches, `n` creates, and Enter opens. Approval and management panels handle their own keys first and do not apply chat input semantics.
