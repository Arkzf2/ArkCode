# ArkCode

English | [简体中文](README-CN.md) | [Docs home](docs/en/README.md)

ArkCode is an AI coding assistant in the terminal. It reads projects, edits files, runs commands, and continues work across sessions.

ArkCode provides an interactive terminal UI, tool approvals, session resume and forks, an input queue, Skills, MCP, and script output. Model access and the tool loop are built on the Pi SDK; ArkCode manages permissions, project context, persistent command control, and compaction.

## Getting started

Requires Node.js 22.19 or newer. Windows uses Git Bash when available and PowerShell otherwise; macOS and Linux use `/bin/sh`. See [Platform support](docs/en/reference/platforms.md) for dependencies and the tested scope.

Install and start from the repository root:

```powershell
	npm install
	npm run build
	npm start
```

On first launch, choose the workspace trust level, then run `/connect` to configure a model and credentials. Submit a task, for example:

```text
	Inspect this project, explain the entry file and test commands, and do not modify files.
```

To use `arkcode` from other directories, run `npm link` in the repository root:

```powershell
	arkcode -C "D:\my-project"
	arkcode resume --last
```

For the full first-run walkthrough, see [Quickstart](docs/en/quickstart.md).

## Documentation

[Documentation languages](docs/README.md): English and 简体中文.

| Task | Entry |
| --- | --- |
| Configure providers, custom endpoints, and the default model | [Model configuration](docs/en/guides/models.md) |
| Submit tasks, queue, copy, and interrupt | [Terminal usage](docs/en/guides/terminal.md) |
| Create, switch, resume, and fork sessions | [Session management](docs/en/guides/sessions.md) |
| Choose approval modes and trust projects | [Permissions and trust](docs/en/guides/permissions.md) |
| Set project rules and reusable workflows | [AGENTS.md](docs/en/guides/instructions.md), [Skills](docs/en/guides/skills.md) |
| Connect external tools or use web search | [MCP](docs/en/guides/mcp.md), [Web Search](docs/en/guides/web-search.md) |
| Run in scripts and process JSON output | [Scripting](docs/en/guides/scripting.md) |
| Look up commands, configuration, tools, and limits | [Docs home](docs/en/README.md), [Troubleshooting](docs/en/troubleshooting.md) |

Current version is `0.1.0`. For development and documentation maintenance, see [Contributing](CONTRIBUTING.md).
