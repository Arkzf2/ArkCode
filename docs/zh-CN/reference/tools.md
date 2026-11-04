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
| `yield_time_ms` | 整数毫秒，默认 10000，范围 10000 至 60000 |
| `timeout` | 可选执行期限，1 至 600 秒，允许小数，无默认值 |
| `stdin` | `closed` 或 `pipe`，默认 closed，不分配 PTY |

观察窗口到期时返回 `running` 和短 `session_id`，进程继续运行。应使用相同句柄等待，不重新启动命令。执行期限独立生效，到期会请求取消进程树。

## shell_control

对当前 agent run 内已有句柄执行 wait、send 或 stop。`session_id` 是不透明句柄，不是 OS PID，不承诺跨用户轮次保留。精确 schema 见[shell_control 输入](../../shared/schemas/shell_control.input.schema.json)。

| action | 参数和默认值 |
| --- | --- |
| `wait` | 必填 session_id；wait_ms 默认 10000，整数范围 10000 至 300000 |
| `send` | 必填 session_id；需要非空 data 或 eof=true；wait_ms 默认 500，整数范围 500 至 60000 |
| `stop` | 只接受 action 和 session_id，立即发起取消，不接受 wait_ms |

已结束进程立即返回。wait 不因一条进度立即返回，也不因观察到期终止进程。同一句柄拒绝重叠 wait，但允许 wait 期间发出 send 或 stop。

send 要求启动时选择 pipe，精确传递字符串，不 trim 或自动添加换行。最多 65536 UTF-8 字节。EOF 永久关闭 stdin，不等于终止或 Ctrl+C。`accepted` 只证明交付，不证明程序处理；`unknown` 时不能自动重发。两种询问模式下每次 send 都需要批准。

stop 最多等待内部 5000 ms 确认清理。`stopping` 表示尚未确认全部后代停止；后续 wait 可取得最终状态。清理失败会保留未确认状态并阻止继续执行。重复 stop 不延长原确认期限。

## shell 结果与输出

结构化结果精确定义见[共用结果 schema](../../shared/schemas/shell.result.schema.json)。

| 字段 | 含义 |
| --- | --- |
| `kind` | `session` 或 `error` |
| `status` | session 的 running、stopping、completed、failed、cancelled 或 timed_out |
| `session_id` | 同一 run 内可使用的句柄 |
| `output` | 本次新增的结构化输出 |
| `wake_reason` | exit、wait_limit、user_steer、stop_unconfirmed 或 cleanup_failed |
| `wall_time_seconds` | 本次调用耗时，单位秒，不含审批，不是累计进程寿命 |
| `exit_code`、`signal` | 终态的真实退出信息 |
| `termination_reason`、`cleanup` | 取消或超时的原因与清理确认状态 |
| `truncated`、`truncation`、`output_file` | 结构化输出是否省略、原因和保存路径 |
| `input` | 输入交付状态，错误结果可能为 accepted、not_sent 或 unknown |
| `error.code`、`error.message` | 工具调用失败原因；不同于进程正常非零退出 |

| 输出层 | 限制及截断方式 |
| --- | --- |
| 直接给模型的文本 | 本次增量末尾最多 2000 行或 50 KiB，先触及的限制生效 |
| CodeMode 接收的结构化 shell 数据 | 独立 1 MiB，超过后保留头尾并标注省略 |
| CodeMode 交给模型的脚本输出 | 使用自身输出预算，当前默认 10000 tokens |

后续 wait 只返回新的输出，不补发之前省略的内容。截断时保存完整日志或运行中的不可变完整前缀快照，可用 read 的 offset/limit 补读。登记的文本输出支持分段读取超过 64 MiB 的文件，授权在文件身份变化或运行实例结束后失效，恢复历史不恢复授权。

CodeMode 脚本结束不代表嵌套进程结束。脚本需检查 `kind` 和 `status`，也要处理参数校验造成的 reject。整个 agent run 结束、中断或 runtime 退出会清理持续进程。

## 动态工具

`WebSearch` 仅在搜索开关和协议可用时注册，输入为非空 `query`，最多 4000 字符，见[搜索指南](../guides/web-search.md)。MCP 工具由实际服务发现，遵守过滤和[暴露配置](mcp-config.md)。这些动态工具不属于七个固定内建工具的生成清单。
