# CLI reference

English | [简体中文](../../zh-CN/reference/cli.md) | [Docs home](../README.md)

This page describes ArkCode `0.1.0`. For the full help and parser option list, see the [generated CLI snapshot](generated/cli-help.md).

## Launch and subcommands

| Form | Behavior |
| --- | --- |
| `arkcode [options] [prompt]` | Starts the terminal UI; you can submit the first task after launch |
| `arkcode resume [SESSION_ID]` | Resumes the named session; interactive mode opens the session list when the ID is omitted |
| `arkcode resume --last` | Resumes the most recent saved session of the current workspace |
| `arkcode fork SESSION_ID` | Forks the named session, using the original workspace files |
| `arkcode models` | Lists `provider/model` entries available with current credentials |
| `arkcode config --provider NAME --model ID` | Chooses a built-in model and saves it as default |
| `arkcode config` with custom endpoint arguments | Saves a custom provider and model, checks credentials, then sets it as default |

There are no separate `exec`, `mcp add`, RPC, or app-server subcommands. Model tools also have no standalone CLI entry.

## Launch options

| Option | Type and default | Behavior |
| --- | --- | --- |
| `-C, --cwd` | path, current directory | Workspace directory |
| `-f, --file` | path, repeatable | Explicit workspace attachment; text files remain path references, images become image parts |
| `--home` | path | Overrides `ARKCODE_HOME` and the default `~/.arkcode` |
| `-m, --model` | string | Chooses `provider/id`; without a provider, matches available models and the default provider |
| `--thinking` | enum | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; actual capability depends on the model |
| `--permissions` | enum | `always-ask`, `ask-when-needed`, `never-ask`; overrides one launch |
| `--full-access` | boolean, false | Compatibility alias for `--permissions never-ask` |
| `--read-only` | removed | Reports an explicit error and asks for a current approval mode |
| `--trust` | boolean, false | Trusts project AGENTS.md, Skills, and MCP configuration |
| `-p, --print` | boolean, false | Runs one task and exits without interactive input |
| `--json` | boolean, false | Implies print; stdout is line-delimited JSON |
| `--approve` | boolean, false | Approves actions that request approval in print mode; does not change persistent permissions |
| `--last` | boolean, false | resume selects the most recent session of the current workspace |
| `-h, --help` | boolean, false | Prints help and exits |
| `-v, --version` | boolean, false | Prints version and exits |

The permission values `ask` and `full-access` map compatibly to `always-ask` and `never-ask`; the `read-only` value also reports an error. Permission values do not decide tool exposure.

## config options

| Option | Constraint |
| --- | --- |
| `--provider` | Required provider identifier; custom endpoints cannot take built-in provider names |
| `--model` | Required model ID here, without the provider prefix |
| `--base-url` | Required for custom configuration, HTTP(S), must not embed credentials |
| `--api` | Required for custom configuration: `openai-completions`, `openai-responses`, `anthropic-messages` |
| `--context-window` | Required for custom configuration, positive integer |
| `--max-tokens` | Required for custom configuration, positive integer, no larger than the context window |
| `--input` | Required for custom configuration, `text` or `image`; image includes text capability |
| `--reasoning` | Required for custom configuration, string `true` or `false` |
| `--name` | Optional display name, default is the model ID; custom configuration only |
| `--api-key-env` | Optional environment variable name; custom endpoints only, stored as an environment variable reference in the model config |

Providing any endpoint or model capability option enters the custom configuration path and requires all required options. Built-in providers use their own environment variables or saved credentials. For the configuration format, see [Configuration](configuration.md).

## Input and exit

Print mode reads stdin, up to 1 MiB, when there is no positional prompt and stdin is not a terminal. A prompt or `--file` attachment is required. In normal launch, when input or output is not a terminal, a prompt or attachment switches to print mode.

Prompt text, including stdin, keeps `@defer`, `@Ident`, and `@file.png` literal. Use `arkcode -p --file "image with space.png" "Inspect this image"` to attach a file explicitly. Paths resolve within `--cwd`; up to eight distinct attachments are accepted per input. Missing attachments and images sent to a text-only model report an error.

| Exit code | Meaning |
| --- | --- |
| `0` | Task completed normally, or help, version, configuration, or another command succeeded |
| `1` | Configuration, startup, or run failure, or no valid completed result |
| `130` | Non-interactive task marked interrupted |

OS signals, force-killing the process, and shell wrappers can also decide the final process exit status. Interruption does not roll back files and does not prove external service effects were undone. For output format, see [JSON events](json-events.md).
