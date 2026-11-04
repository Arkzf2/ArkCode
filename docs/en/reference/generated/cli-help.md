# CLI help snapshot

English | [简体中文](../../../zh-CN/reference/generated/cli-help.md) | [Docs home](../../README.md)

Generated from the actual definitions. Do not edit by hand. Regenerate with `npm run docs:generate`.

```text
ArkCode 0.1.0

Usage: arkcode [options] [prompt]
       arkcode resume [session-id | --last]
       arkcode fork <session-id>
       arkcode models
       arkcode config --provider NAME --model ID
       arkcode config --provider NAME --model ID --base-url URL --api API
         --context-window N --max-tokens N --input text|image --reasoning true|false
         [--name NAME] [--api-key-env NAME]

  API is openai-completions, openai-responses, or anthropic-messages.
  Anthropic base URL is the API root; Pi appends /v1/messages.

  -C, --cwd PATH           Workspace directory
  -m, --model PROVIDER/ID  Select a configured Pi model
      --thinking LEVEL    off, minimal, low, medium, high, xhigh, max
      --permissions MODE  always-ask, ask-when-needed, never-ask
      --full-access       Alias for --permissions never-ask
      --trust             Trust project AGENTS.md, Skills, and MCP server configuration
  -p, --print             Run one prompt without a TUI
      --json              Emit JSON events
      --approve           Approve requested actions in print mode
      --home PATH         ArkCode configuration directory
  -h, --help              Show help

Seven built-in tools remain available in every approval mode; connected MCP tools are exposed dynamically.
Always Ask allows workspace reading/search, plain ls, and shell wait/stop; other actions and MCP calls need approval.
Ask When Needed allows ordinary built-in actions; dangerous commands, shell input, and MCP tools without user auto-approval ask.
Never Ask runs without tool approval. Untrusted directories skip project AGENTS.md, Skills, and MCP; user configuration still applies.
Use /connect to configure a Pi provider or custom endpoint.
Use /mcp to inspect servers and tools, reload configuration, reconnect, or enable/disable servers.
Use /skills to list or enable/disable Skills from user and project .agents/skills. @ searches files and Skills; @skill:name selects one.
Use /tool-mode to choose direct, codemode, or codemode-only for built-in tools; changes apply after compact or to new sessions.
Use /web-search [status|check|on|off] for provider Web Search. Check runs a real search and can incur provider fees.
Print mode requires --model or a saved default model.
Use /new for another concurrent session; /sessions opens the session list. Left also works on an empty composer.
Switching sessions keeps background runs active. Another terminal opening the same session is read-only.
/exit stops all sessions owned by this terminal. edit/write use Pi's in-process same-file queue.
```

## Parser options

| Option | Type | Short name |
| --- | --- | --- |
| `--cwd` | string | `-C` |
| `--home` | string | - |
| `--model` | string | `-m` |
| `--thinking` | string | - |
| `--permissions` | string | - |
| `--full-access` | boolean | - |
| `--read-only` | boolean | - |
| `--print` | boolean | `-p` |
| `--json` | boolean | - |
| `--approve` | boolean | - |
| `--last` | boolean | - |
| `--help` | boolean | `-h` |
| `--version` | boolean | `-v` |
| `--provider` | string | - |
| `--base-url` | string | - |
| `--api` | string | - |
| `--api-key-env` | string | - |
| `--name` | string | - |
| `--input` | string | - |
| `--reasoning` | string | - |
| `--context-window` | string | - |
| `--max-tokens` | string | - |
| `--trust` | boolean | - |
