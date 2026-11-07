# CLI 参考

[English](../../en/reference/cli.md) | 简体中文 | [文档首页](../README.md)

本页描述 ArkCode `0.1.0`。完整帮助和解析器参数清单见[生成的 CLI 快照](generated/cli-help.md)。

## 启动与子命令

| 形式 | 行为 |
| --- | --- |
| `arkcode [options] [prompt]` | 启动终端界面，可在启动后提交首条任务 |
| `arkcode resume [SESSION_ID]` | 恢复指定会话；交互模式省略 ID 时打开会话列表 |
| `arkcode resume --last` | 恢复当前工作区最近的已保存会话 |
| `arkcode fork SESSION_ID` | 从指定会话建立新分支，使用原工作区文件 |
| `arkcode models` | 列出当前凭据可用的 `provider/model` |
| `arkcode config --provider NAME --model ID` | 选择内建模型并保存为默认 |
| `arkcode config` 加自定义端点参数 | 保存自定义 provider 和模型，检查凭据后设为默认 |

没有独立的 `exec`、`mcp add`、RPC 或 app-server 子命令。模型工具也没有独立 CLI 调用入口。

## 启动参数

| 参数 | 类型及默认 | 行为 |
| --- | --- | --- |
| `-C, --cwd` | 路径，默认当前目录 | 工作区目录 |
| `-f, --file` | 路径，可重复 | 显式指定工作区附件；文本文件保留路径引用，图片作为图片内容传递 |
| `--home` | 路径 | 覆盖 `ARKCODE_HOME` 和默认 `~/.arkcode` |
| `-m, --model` | 字符串 | 选择 `provider/id`；无 provider 时按可用模型及默认供应商匹配 |
| `--thinking` | 枚举 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；实际能力依模型而定 |
| `--permissions` | 枚举 | `always-ask`、`ask-when-needed`、`never-ask`，覆盖当次启动 |
| `--full-access` | 布尔，false | `--permissions never-ask` 的兼容别名 |
| `--read-only` | 已移除 | 显式报错，要求选择当前审批模式 |
| `--trust` | 布尔，false | 信任项目 AGENTS.md、Skills 和 MCP 配置 |
| `-p, --print` | 布尔，false | 运行一条任务并退出，无交互输入 |
| `--json` | 布尔，false | 隐含 print，stdout 输出逐行 JSON |
| `--approve` | 布尔，false | 在 print 中批准请求审批的动作，不更改持久权限 |
| `--last` | 布尔，false | resume 选择当前工作区最近会话 |
| `-h, --help` | 布尔，false | 输出帮助后退出 |
| `-v, --version` | 布尔，false | 输出版本后退出 |

权限值 `ask` 和 `full-access` 分别兼容映射到 `always-ask` 和 `never-ask`；`read-only` 值同样报错。工具暴露方式不由权限参数决定。

## config 参数

| 参数 | 约束 |
| --- | --- |
| `--provider` | 必填，供应商标识；自定义端点不能占用内建供应商名称 |
| `--model` | 必填，此处为模型 ID，无需 provider 前缀 |
| `--base-url` | 自定义配置必填，HTTP(S)，不得嵌入凭据 |
| `--api` | 自定义必填：`openai-completions`、`openai-responses`、`anthropic-messages` |
| `--context-window` | 自定义必填，正整数 |
| `--max-tokens` | 自定义必填，正整数，不大于上下文窗口 |
| `--input` | 自定义必填，`text` 或 `image`；image 包含 text 能力 |
| `--reasoning` | 自定义必填，字符串 `true` 或 `false` |
| `--name` | 可选显示名称，默认模型 ID；仅自定义配置使用 |
| `--api-key-env` | 可选环境变量名，仅自定义端点使用，写入模型配置为环境变量引用 |

提供任一端点或模型能力参数即进入自定义配置路径，需要补齐全部必填项。内建供应商使用自己的环境变量或已存凭据。配置格式见[配置文件](configuration.md)。

## 输入与退出

print 模式无位置提示且 stdin 非终端时读取 stdin，最多 1 MiB。必须提供提示或 `--file` 附件。普通启动的输入或输出不是终端时，有提示或附件会转为 print。

正文及 stdin 中的 `@defer`、`@Ident`、`@file.png` 均按原文传递。显式附件使用 `arkcode -p --file "image with space.png" "检查这张图片"`。路径在 `--cwd` 内解析，每次输入最多八个不同附件。附件不存在或向纯文本模型发送图片时会报错。

| 退出码 | 含义 |
| --- | --- |
| `0` | 任务正常完成，或帮助、版本、配置等命令成功 |
| `1` | 配置、启动、运行失败，或没有有效完成结果 |
| `130` | 非交互任务被标记为中断 |

操作系统信号、强制杀进程和 shell 包装也可能决定最终进程退出状态。中断不回滚文件，也不证明外部服务效果已撤销。输出格式见[JSON 事件](json-events.md)。
