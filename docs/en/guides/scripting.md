# Run tasks in scripts

English | [简体中文](../../zh-CN/guides/scripting.md) | [Docs home](../README.md)

## Run one task

Configure credentials and a default model first, or pass `--model`. `--print` does not open the interactive UI:

```powershell
	arkcode --print "Explain the entry file and test commands of this project"
```

When no prompt is given on the command line, input can come from stdin, up to 1 MiB:

```powershell
	Get-Content -Raw task.txt | arkcode --print
```

Ordinary answers go to stdout; notes and errors go to stderr. When you need precise output, consume JSON events instead of parsing terminal display text.

## Handle approvals

Non-interactive mode denies actions that need approval by default. Use `--approve` to allow requested actions for this run explicitly:

```powershell
	arkcode --print --permissions always-ask --approve "Modify tests and run the related checks"
```

`--approve` does not change the permission configuration and does not remove file protections, MCP filtering, or recovery limits. `--permissions never-ask` does not wait for call approval. See [Permissions and trust](permissions.md) for the differences.

In automation, use `--trust` after you confirm the project configuration is trustworthy. Enabled MCP servers must finish startup; a failed server blocks the first request round.

## Consume JSON events

```powershell
	arkcode --json --permissions always-ask "Explain this project" > events.jsonl
```

`--json` implies `--print`; stdout is one JSON object per line. Use `type` to handle deltas, complete answers, tools, approvals, and status, then wait for the process to exit to judge the run result.

Events have no separate version number; the current format is for ArkCode `0.1.0`. A completed assistant message or a single tool success does not mean the whole run succeeded. For fields and exit codes, see [JSON events](../reference/json-events.md) and the [CLI reference](../reference/cli.md).
