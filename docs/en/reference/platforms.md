# Platforms and feature scope

English | [简体中文](../../zh-CN/reference/platforms.md) | [Docs home](../README.md)

## Runtime dependencies

| Item | Requirement |
| --- | --- |
| Node.js | At least 22.19.0 |
| Windows shell | Auto-detects Git Bash, falls back to PowerShell, prefers PowerShell 7 |
| macOS, Linux shell | `/bin/sh` |
| Git | Branch state and Git workspace boundary discovery |
| Model | Valid credentials, endpoint, and usable tool calling capability |

Each session fixes its shell at creation. Windows discovery checks PATH for Git installations and common system and user installation locations. The tool name is still bash; model prompts and `/status` show the actual interpreter. A failure does not switch interpreters automatically.

## Verification scope

On Windows, tests cover the real SDK, a local model and MCP protocol service, file operations, TUI rendering, and child process tree cancellation. They do not represent acceptance of all remote providers or native terminal experiences.

macOS and Linux process group cleanup on real machines, plus Chinese IME in different terminals, system clipboard, external editors, and browser OAuth callbacks, still need verification in the corresponding environment. Confirm these operations on your own platform before relying on them.

## Current product boundary

ArkCode supports concurrent sessions but does not provide multi-agent orchestration. Goal, plugins, persistent Plan, learned memory, cloud execution, RPC, a public SDK, and app-server are not open product interfaces. Code review can be submitted as an ordinary task; full Git diffs use external Git tools.

ArkCode is built on the Pi SDK but uses its own configuration directory, permissions, project resource discovery, and compaction policy. Pi's full CLI, extensions, prompt templates, themes, and automatic cache warm-up are not automatically available. For upstream reference, see [Pi docs](https://pi.dev/docs/latest).
