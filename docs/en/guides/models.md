# Configure models

English | [简体中文](../../zh-CN/guides/models.md) | [Docs home](../README.md)

## Connect a built-in provider

Run `/connect` in the terminal and choose the provider, model, and credential source. You can use existing credentials, provider environment variables, or an API key in a masked input. The key is stored in `auth.json` in the config directory; the default model is stored in `settings.json`.

Use `/model` to switch models and the reasoning effort that model supports. Context window, image, and reasoning capabilities come from the model definition; configuration options do not make the endpoint support them automatically.

When provider environment variables are already set, you can set the default model from the CLI. The model IDs below are examples; run `arkcode models` first to confirm what is available locally:

```powershell
	$env:OPENAI_API_KEY = "your-key"
	arkcode models
	arkcode config --provider openai --model gpt-4.1
```

`arkcode models` lists only models with credentials available. The first interactive startup saves the default model you choose; script runs need an existing default model or explicit `--model`.

## Add a custom endpoint

Choose a separate provider name for the custom endpoint, and state the protocol, context window, max output, input, and reasoning capabilities. Do not reuse a name already taken by a built-in provider.

```powershell
	$env:LOCAL_API_KEY = "your-key"
	arkcode config --provider local --model my-model --base-url http://localhost:1234/v1 --api openai-completions --context-window 131072 --max-tokens 4096 --input text --reasoning false --api-key-env LOCAL_API_KEY
	arkcode --model local/my-model
```

Replace the example URL, model ID, key, and capability values. A context window that is too small cannot fit the compaction reserve; see [Context and compaction](../concepts/context-and-compaction.md).

The configuration entry supports `openai-completions`, `openai-responses`, and `anthropic-messages`. An Anthropic Messages base URL is the API root without a trailing `/v1`; the client appends `/v1/messages`.

For custom reasoning models `deepseek-flash` and `deepseek-v4-pro` using `openai-responses`, ArkCode defaults `compat.supportsDeveloperRole` to `false` so system instructions use the `system` role. Startup also fills this default in existing configurations. Explicit compatibility settings are preserved.

When a custom provider already has a model, you cannot change it to a different protocol or endpoint. Use separate provider names for different endpoints.

## Choose a model temporarily or isolate configuration

```powershell
	arkcode --model local/my-model --thinking off
	arkcode --home "D:\arkcode-profile" -C "D:\my-project"
```

Under `--home`, credentials, default model, MCP configuration, and history are stored separately. User Skills still come from the user home directory's `.agents/skills`.

For config files and override rules, see [Configuration reference](../reference/configuration.md). For connection failures, see [Troubleshooting](../troubleshooting.md).
