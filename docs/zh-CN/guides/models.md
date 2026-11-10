# 配置模型

[English](../../en/guides/models.md) | 简体中文 | [文档首页](../README.md)

## 连接内建供应商

在终端运行 `/connect`，选择供应商、模型和凭据来源。可以使用已有凭据、供应商环境变量或隐藏输入的 API key。输入的密钥保存在配置目录的 `auth.json`，默认模型保存在 `settings.json`。

通过 `/model` 切换模型和该模型支持的推理等级。模型上下文窗口、图片和推理能力来自模型定义；配置选项不会使端点自动具备相应能力。

已有供应商环境变量时，可以从 CLI 设置默认模型。以下模型 ID 只是示例，先通过 `arkcode models` 确认本机可用列表：

```powershell
	$env:OPENAI_API_KEY = "your-key"
	arkcode models
	arkcode config --provider openai --model gpt-4.1
```

`arkcode models` 只列出已具备凭据的可用模型。首次交互启动保存你选择的默认模型；脚本运行需要已有默认模型或显式 `--model`。

## 添加自定义端点

为自定义端点选择独立的 provider 名称，明确协议、上下文窗口、最大输出、输入和推理能力。不要使用内建供应商已占用的名称。

```powershell
	$env:LOCAL_API_KEY = "your-key"
	arkcode config --provider local --model my-model --base-url http://localhost:1234/v1 --api openai-completions --context-window 131072 --max-tokens 4096 --input text --reasoning false --api-key-env LOCAL_API_KEY
	arkcode --model local/my-model
```

替换示例 URL、模型 ID、密钥和能力值。上下文窗口过小会无法容纳压缩保留预算，见[上下文与压缩](../concepts/context-and-compaction.md)。

配置入口支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`。Anthropic Messages 的 base URL 使用 API 根地址，不带末尾 `/v1`；客户端会追加 `/v1/messages`。

自定义推理模型 `deepseek-flash` 和 `deepseek-v4-pro` 使用 `openai-responses` 时，ArkCode 默认设置 `compat.supportsDeveloperRole` 为 `false`，使系统提示使用 `system` 角色。启动时也会为已有配置补齐这一默认值，并保留用户显式设置的兼容性选项。

同一个自定义 provider 已有模型时，不能把它改到不同协议或端点。为不同端点使用不同 provider 名称。

## 临时选择模型或隔离配置

```powershell
	arkcode --model local/my-model --thinking off
	arkcode --home "D:\arkcode-profile" -C "D:\my-project"
```

`--home` 下的凭据、默认模型、MCP 配置和历史独立保存。用户 Skills 仍来自用户主目录的 `.agents/skills`。

配置文件及覆盖规则见[配置参考](../reference/configuration.md)。连接失败时见[故障排查](../troubleshooting.md)。
