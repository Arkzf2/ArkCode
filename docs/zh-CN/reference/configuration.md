# 配置文件参考

[English](../../en/reference/configuration.md) | 简体中文 | [文档首页](../README.md)

## 配置目录

目录选择顺序为 `--home`、`ARKCODE_HOME`、默认 `~/.arkcode`。用户 Skills 的 `~/.agents/skills` 不受这个选择影响。

| 文件或目录 | 内容 |
| --- | --- |
| `settings.json` | 默认模型、推理、权限、工具模式、搜索、信任与项目指令预算 |
| `AGENTS.md` | 全局规则，始终可用 |
| `models.json` | 模型与端点配置 |
| `auth.json` | 模型供应商凭据，由运行时管理 |
| `model-cache.json` | 模型运行时缓存 |
| `mcp.json` | 用户 MCP 配置 |
| `mcp-auth.json`、`mcp.log` | MCP OAuth 凭据及服务日志 |
| `skills.json` | Skill 禁用偏好 |
| `sessions/` | 按真实工作区分组的 JSONL 会话历史 |
| `runs/` | active、结束或中断标记，不是第二份对话历史 |

只有工作区 `.arkcode/mcp.json` 作为项目 MCP 配置。ArkCode 不加载项目 `.pi/settings.json`、Pi 扩展、主题或 prompt 模板。

## settings.json

文件使用严格 JSON。未知字段报错。当前默认值由[实际配置定义生成](generated/settings-defaults.md)。

| 字段 | 类型 | 默认与含义 |
| --- | --- | --- |
| `provider` | 非空字符串 | 未设置，默认模型所属供应商 |
| `model` | 非空字符串 | 未设置，默认模型 ID |
| `thinking` | 枚举 | `medium`；允许 off、minimal、low、medium、high、xhigh、max |
| `permission` | 枚举 | `always-ask`；另有 ask-when-needed、never-ask |
| `toolMode` | 枚举 | `codemode`；另有 direct、codemode-only |
| `webSearch` | 布尔 | `true`，是否启用协议支持的搜索 |
| `trustedWorkspaces` | 非空路径字符串数组 | `[]`，可信工作区 |
| `projectDocMaxBytes` | 非负整数 | `32768`，最大为 JavaScript 安全整数，项目 AGENTS.md 总字节预算 |

有效的最小偏好示例：

```json
{
  "thinking": "medium",
  "permission": "always-ask",
  "toolMode": "codemode",
  "webSearch": true,
  "projectDocMaxBytes": 32768
}
```

旧权限 `ask` 和 `full-access` 会转换；`read-only` 报错。旧 `theme` 和 `statusline` 字段只供兼容读取，下一次保存移除。不要把 Pi 的 `defaultProvider`、`defaultModel` 或 `compaction` 设置复制到这里。

## 模型定义

`models.json` 使用 Pi 模型配置格式，根字段为 `providers`，字段名是 `baseUrl`。下例为自定义 OpenAI 兼容端点，需替换地址和模型能力：

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

| 字段 | 语义 |
| --- | --- |
| `baseUrl` | HTTP(S) API 地址，Completions 通常以 `/v1` 结束；ArkCode 的 Anthropic 配置入口要求不带末尾 `/v1` 的 API 根地址 |
| `api` | `/connect` 和 config 支持的三种协议见[CLI](cli.md) |
| `apiKey` | 可为字面量、环境变量引用 `$NAME` 或 `${NAME}`，也支持 Pi 的 `!command` 凭据命令 |
| `models[].id` | 模型 ID |
| `models[].name` | 显示名称 |
| `models[].input`、`reasoning` | 输入和推理能力 |
| `models[].contextWindow`、`maxTokens` | 上下文与最大输出，影响请求和压缩预算 |
| `models[].cost` | 可省略；填写时包含 input、output、cacheRead、cacheWrite 四个数值，费用元数据由 Pi 解释 |

模型文件支持的其余字段见[固定 Pi 1.5.0 格式参考](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/models-configuration.md)。[Pi latest 文档](https://pi.dev/docs/latest)提供上游背景；其设置、CLI 和可扩展能力不自动成为 ArkCode 功能。模型配置属于用户可信输入，凭据命令可能执行本地程序。

省略 cost 时，模型费用元数据可能显示为零。这不表示端点免费，应以实际供应商账单为准。

## 覆盖与生效

CLI 模型和权限覆盖当次启动。`/model`、`/permissions`、`/tool-mode`、`/web-search` 会保存相应默认值，但生效时机不同，详见[工具模式](tool-modes.md)。

项目 MCP 对同名用户条目整体覆盖，Skills 同名项按发现优先级选择，不能用一条统一配置优先级解释所有文件。项目 AGENTS.md 按目录范围注入，而非简单覆盖全局规则。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `ARKCODE_HOME` | 默认配置目录，可被 `--home` 覆盖 |
| 供应商密钥变量 | 由所选供应商读取，例如 `OPENAI_API_KEY`；不通过 `--api-key-env` 修改内建供应商行为 |
| 自定义密钥变量 | `models.json.apiKey`、MCP bearer、env 或 headers 中显式引用的变量 |
| `VISUAL`、`EDITOR` | 草稿外部编辑器，优先 VISUAL |
| `PI_CODEMODE_MAX_WORKERS` | Pi CodeMode worker 上限，正整数；默认 2，影响同时执行脚本的容量 |

会话锁在系统临时目录按 session ID 管理，不在 home 内。更换配置目录不会解除现有 session 锁。
