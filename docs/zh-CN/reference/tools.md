# 工具参考

[English](../../en/reference/tools.md) | 简体中文 | [文档首页](../README.md)

本页说明 ArkCode 提供给模型的工具，不是独立 HTTP 或 SDK 接口。七个内建工具在三种审批模式下均可用，调用形式由[工具模式](tool-modes.md)决定，执行仍经过[权限检查](../guides/permissions.md)。精确输入见[生成的工具定义](../../shared/generated/tool-inputs.json)。

## 文件工具

| 工具 | 必填参数 | 可选参数与行为 |
| --- | --- | --- |
| `read` | `path` | `offset` 为从 1 开始的行号，`limit` 限制行数；支持文本及受支持图片 |
| `write` | `path`、`content` | 写入完整内容，可创建父目录；不是基于旧版本的合并 |
| `edit` | `path`、`edits` | 每项包含 `oldText`、`newText`；全部按原文件匹配，oldText 必须唯一，各项不得重叠 |
| `grep` | `pattern` | `path`、`glob`、`ignoreCase`、`literal`、`context`、`limit`；默认匹配上限 100，默认区分大小写、正则、0 行上下文 |
| `glob` | `pattern` | `path`、`limit`；默认结果上限 1000 |

文件工具限制在工作区，真实路径和 symlink 不能越界。`.git`、`.arkcode` 不开放，普通读取拒绝凭据文件；`.env.example` 可被显式 read，但 grep/glob 排除 `.env*`。grep/glob 跳过依赖与元数据目录。glob 遍历超过 10000 个文件时报错，应缩小路径。

普通文本文件和 write 内容上限 2 MiB。已登记的 Skill 文件和工具输出文件有单独只读授权。授权不允许写入其目录或访问同目录其他文件。图片内容、文本截断和错误可能有不同返回形式，不应假定每个工具都返回 JSON。

edit 和 write 在同一进程的 SDK 实例内按实际文件串行修改；不同终端进程、shell、MCP 和外部编辑器不受该队列保护。完整 write 仍可能覆盖其他写入。工具失败不会自动撤销先前动作。

## bash

`bash` 是固定工具名，实际解释器可能为 Git Bash、PowerShell 或 `/bin/sh`，以会话环境和 `/status` 为准。执行失败不会自动切换解释器。精确 schema 见[bash 输入](../../shared/schemas/bash.input.schema.json)。

| 字段 | 约束 |
| --- | --- |
| `command` | 必填非空字符串，按实际 shell 语法执行 |
| `io_mode` | `pipe` 或 `pty`，默认 `pipe`。`pipe` 保留普通流和可写 stdin，`pty` 提供终端语义 |
| `yield_time_ms` | 初始观察窗口，整数毫秒，默认 10000，范围 10000 至 60000 |

命令会先运行并观察 `yield_time_ms` 指定的时间。若仍在运行，返回 `running` 和 `session_id`，进程继续运行。后续使用相同句柄调用 `shell_control`，不要重新启动命令。`yield_time_ms` 不会终止进程。普通命令使用 `pipe`，REPL、TUI 和终端提示使用 `pty`。

## shell_control

继续当前运行内已有句柄。`session_id` 是不透明句柄，不是 OS PID，不承诺跨用户轮次保留。精确 schema 见[shell_control 输入](../../shared/schemas/shell_control.input.schema.json)。

| action | 参数和默认值 |
| --- | --- |
| `wait` | 必填 `session_id`；可选 `chars`、`eof` 和 `yield_time_ms`；只读等待默认 10000 ms，带输入等待默认 500 ms |
| `stop` | 只接受 `action` 和 `session_id`，请求取消进程树 |

已结束进程立即返回。观察到期会让进程继续运行。同一句柄拒绝重叠 `wait`，但允许在等待期间输入和 `stop`。省略 `action` 且未提供输入字段时，按 `wait` 处理。发送 `chars` 或 `eof` 时必须使用 `action: "wait"`。

`chars` 精确传递文本，不 trim 或自动添加换行，最多 65536 UTF-8 字节。pipe 和 PTY 都支持 `chars`。`eof: true` 只适用于 pipe，会永久关闭 stdin。PTY 返回 `eof_not_supported`，应通过 `chars` 发送终端输入。`accepted` 只证明输入已交付，`unknown` 时不要自动重发。

`stop` 请求取消进程树，最多等待内部 5000 ms 确认清理。`stopping` 表示尚未确认全部后代停止，后续 `wait` 可取得最终状态。

## shell 结果与输出

结构化结果精确定义见[共用结果 schema](../../shared/schemas/shell.result.schema.json)。

| 字段 | 含义 |
| --- | --- |
| `kind` | `session` 或 `error` |
| `status` | session 的 `running`、`stopping`、`completed`、`failed` 或 `cancelled` |
| `session_id` | 同一 run 内可使用的句柄 |
| `output` | 本次新增的结构化输出 |
| `wake_reason` | exit、wait_limit、user_steer、stop_unconfirmed 或 cleanup_failed |
| `wall_time_seconds` | 本次调用耗时，单位秒，不含审批，不是累计进程寿命 |
| `exit_code`、`signal` | 终态的真实退出信息 |
| `termination_reason`、`cleanup` | 取消原因与清理确认状态 |
| `truncated`、`truncation`、`output_file` | 结构化输出是否省略、原因和保存路径 |
| `input` | 输入交付状态，错误结果可能为 accepted、not_sent 或 unknown |
| `error.code`、`error.message`、`error.field`、`error.hint` | 工具调用失败原因和修复提示；不同于进程非零退出 |

| 输出层 | 限制及截断方式 |
| --- | --- |
| 直接给模型的文本 | 本次增量末尾最多 2000 行或 50 KiB，先触及的限制生效 |
| CodeMode 接收的结构化 shell 数据 | 独立 1 MiB，超过后保留头尾并标注省略 |
| CodeMode 交给模型的脚本输出 | 使用自身输出预算，当前默认 10000 tokens |

后续 `wait` 只返回新的输出，不补发之前省略的内容。截断输出会保存到文件，可用 `read` 的 `offset` 和 `limit` 补读。登记的文本输出支持分段读取超过 64 MiB 的文件，授权在文件变化或运行结束后失效。

CodeMode 脚本结束不代表嵌套进程结束。脚本应检查 `kind` 和 `status`，并处理参数校验错误。当前运行结束、中断或 runtime 退出时会清理持续进程。

宿主为每个 CodeMode 结果附加最多 2 KiB 的 shell 状态摘要。摘要覆盖仍在运行、失败、取消、工具错误和会话控制结果。正常退出且没有保存日志的 `bash` 调用省略摘要。`wait_limit` 表示观察窗口结束时进程仍在运行。

## 动态工具

`WebSearch` 仅在搜索开关和协议可用时注册，输入为非空 `query`，最多 4000 字符，见[搜索指南](../guides/web-search.md)。MCP 工具由实际服务发现，遵守过滤和[暴露配置](mcp-config.md)。这些动态工具不属于七个固定内建工具的生成清单。
