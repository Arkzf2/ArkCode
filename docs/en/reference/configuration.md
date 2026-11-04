# Configuration file reference

English | [简体中文](../../zh-CN/reference/configuration.md) | [Docs home](../README.md)

## Configuration directory

Directory selection order: `--home`, `ARKCODE_HOME`, default `~/.arkcode`. The user Skills directory `~/.agents/skills` is not affected by this selection.

| File or directory | Content |
| --- | --- |
| `settings.json` | Default model, reasoning, permissions, tool mode, search, trust, project instruction budget |
| `AGENTS.md` | Global rules, always available |
| `models.json` | Model and endpoint configuration |
| `auth.json` | Model provider credentials, managed by the runtime |
| `model-cache.json` | Model runtime cache |
| `mcp.json` | User MCP configuration |
| `mcp-auth.json`, `mcp.log` | MCP OAuth credentials and service logs |
| `skills.json` | Skill disable preferences |
| `sessions/` | JSONL session history grouped by actual workspace |
| `runs/` | Active, ended, or interrupted markers, not a second conversation history |

Only workspace `.arkcode/mcp.json` is project MCP configuration. ArkCode does not load project `.pi/settings.json`, Pi extensions, themes, or prompt templates.

## settings.json

The file uses strict JSON. Unknown fields report errors. Current defaults are [generated from the actual configuration definitions](generated/settings-defaults.md).

| Field | Type | Default and meaning |
| --- | --- | --- |
| `provider` | non-empty string | Not set; provider of the default model |
| `model` | non-empty string | Not set; default model ID |
| `thinking` | enum | `medium`; allows off, minimal, low, medium, high, xhigh, max |
| `permission` | enum | `always-ask`; also ask-when-needed, never-ask |
| `toolMode` | enum | `codemode`; also direct, codemode-only |
| `webSearch` | boolean | `true`; whether protocol-supported search is enabled |
| `trustedWorkspaces` | non-empty path string array | `[]`; trusted workspaces |
| `projectDocMaxBytes` | non-negative integer | `32768`; up to the maximum safe JavaScript integer; total byte budget for project AGENTS.md |

A valid minimal preference example:

```json
{
  "thinking": "medium",
  "permission": "always-ask",
  "toolMode": "codemode",
  "webSearch": true,
  "projectDocMaxBytes": 32768
}
```

Legacy permission values `ask` and `full-access` convert; `read-only` reports an error. Legacy `theme` and `statusline` fields are read for compatibility only and are removed at the next save. Do not copy Pi's `defaultProvider`, `defaultModel`, or `compaction` settings here.

## Model definitions

`models.json` uses the Pi model configuration format. The root field is `providers`, and the field name is `baseUrl`. The following is a custom OpenAI-compatible endpoint example; replace the address and model capabilities:

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "${LOCAL_API_KEY}",
      "models": [
        {
          "id": "my-model",
          "name": "My model",
          "input": ["text"],
          "reasoning": false,
          "contextWindow": 131072,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `baseUrl` | HTTP(S) API address; Completions usually ends with `/v1`; ArkCode's Anthropic configuration entry requires an API root without a trailing `/v1` |
| `api` | The three protocols supported by `/connect` and config; see [CLI](cli.md) |
| `apiKey` | Can be a literal, an environment variable reference `$NAME` or `${NAME}`, or a Pi `!command` credential command |
| `models[].id` | Model ID |
| `models[].name` | Display name |
| `models[].input`, `reasoning` | Input and reasoning capabilities |
| `models[].contextWindow`, `maxTokens` | Context and max output; affect requests and the compaction budget |
| `models[].cost` | Optional; when present, contains input, output, cacheRead, cacheWrite numbers; Pi interprets the cost metadata |

For the remaining fields supported by the model file, see the [pinned Pi 1.5.0 format reference](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/models-configuration.md). [Pi latest docs](https://pi.dev/docs/latest) provide upstream background; its settings, CLI, and extensibility do not automatically become ArkCode features. Model configuration is user-trusted input, and credential commands may execute local programs.

When cost is omitted, model cost metadata may display as zero. That does not mean the endpoint is free; use the actual provider bill.

## Overrides and effect

CLI model and permission options override one launch. `/model`, `/permissions`, `/tool-mode`, and `/web-search` save the corresponding defaults, but the effect timing differs; see [Tool modes](tool-modes.md).

Project MCP replaces a same-name user entry completely. Same-name Skills entries are selected by discovery priority; one unified config precedence rule cannot explain all files. Project AGENTS.md files are injected by directory scope rather than a simple override of global rules.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ARKCODE_HOME` | Default configuration directory; can be overridden by `--home` |
| Provider key variables | Read by the selected provider, for example `OPENAI_API_KEY`; `--api-key-env` does not change built-in provider behavior |
| Custom key variables | Variables explicitly referenced by `models.json.apiKey`, MCP bearer, env, or headers |
| `VISUAL`, `EDITOR` | External editor for drafts; VISUAL takes precedence |
| `PI_CODEMODE_MAX_WORKERS` | Pi CodeMode worker limit, positive integer, default 2; affects the capacity of concurrently running scripts |

Session locks are managed by session ID in the system temporary directory, not inside home. Changing the configuration directory does not release existing session locks.
