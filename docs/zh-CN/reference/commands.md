# 交互命令与快捷键

[English](../../en/reference/commands.md) | 简体中文 | [文档首页](../README.md)

命令目录的实际注册结果见[生成目录](generated/commands.md)。未知 slash 命令会报错并保留草稿，不当作普通提示发送给模型。

## slash 命令

| 命令 | 行为和生效范围 |
| --- | --- |
| `/help` | 查看命令与常用按键 |
| `/model [provider/id]` | 选择模型及可用推理等级，保存默认值 |
| `/connect` | 配置供应商或自定义端点，需要空闲 |
| `/permissions [mode]` | 立即切换审批模式，保存默认值并撤销旧授权 |
| `/tool-mode [mode]` | 保存内建工具模式，需要空闲；生效见[工具模式](tool-modes.md) |
| `/web-search [status或check或on或off]` | 搜索状态、真实检查和持久开关，需要空闲 |
| `/mcp` | 打开服务器管理菜单；子命令见下表 |
| `/skills` | 打开 Skills 菜单；子命令为 `list`、`reload`、`enable NAME_OR_PATH`、`disable NAME_OR_PATH` |
| `/status` | 打印模型、工作区、会话、权限、shell 和累计用量 |
| `/new` | 创建并切换到独立会话，后台会话继续运行 |
| `/sessions [id]` | 跨项目列表；提供 ID 时打开当前项目的对应历史 |
| `/rename [name]` | 重命名当前会话；省略时显示输入框 |
| `/fork [id]` | 分支当前或当前项目指定的已保存会话 |
| `/compact [instructions]` | 执行 ArkCode 压缩，可传摘要补充要求，需要空闲 |
| `/copy` | 复制最近完整回答 |
| `/init` | 根据项目生成 AGENTS.md，已有文件不覆盖，需要空闲 |
| `/exit` | 停止本终端拥有的全部会话并退出 |

viewer 可以查看 help、status、copy、sessions、MCP 与 Skills 列表，使用 `/new` 或 `/fork` 创建独立会话；不能修改原会话、连接或偏好。Skills 写操作还要求无待消费的 steer 或 follow-up，MCP 写操作受连接和恢复状态约束。

Goal、多代理、插件、学习式记忆、持久 Plan 和云执行命令当前不可用。

## MCP 子命令

| 形式 | 行为 |
| --- | --- |
| `/mcp help`、`/mcp status` | 查看帮助或状态 |
| `/mcp tools SERVER` | 查看工具目录 |
| `/mcp reload` | 重新读取配置 |
| `/mcp reconnect [SERVER]` | 读取配置后重建指定连接，省略时重载全部 |
| `/mcp enable SERVER`、`/mcp disable SERVER` | 保存并应用启停状态 |
| `/mcp exposure SERVER MODE` | 保存 `codemode`、`deferred`、`direct` 或 `hidden`，遵守策略生效边界 |
| `/mcp login SERVER`、`/mcp logout SERVER` | OAuth 登录或清除凭据并断开 |

## 快捷键

| 按键或输入 | 上下文与行为 |
| --- | --- |
| Enter | 空闲时提交，运行中发送 steer |
| Tab | 补全候选存在时接受候选，运行中可排队 follow-up |
| Shift+Left | 编辑未消费队列输入 |
| Left | 空输入框打开会话列表 |
| Esc | 面板返回，已有选区时清除选区，否则中断任务 |
| 双 Esc | 空输入框编辑上一条提示并创建分支 |
| Ctrl+C | 有选区时复制，否则运行中中断、空闲退出 |
| Ctrl+D | 空输入框退出 |
| Ctrl+T | 展开或收起工具和推理详情 |
| Ctrl+O | 复制最近完整回答 |
| Ctrl+R | 搜索提示历史 |
| Ctrl+G | 使用 `VISUAL` 或 `EDITOR` 编辑草稿 |
| Ctrl+L | 清理视图，保留历史 |
| PgUp、PgDn、End | 浏览历史、返回最新内容 |
| `@`、`@skill:` | 文件与 Skill 补全、仅 Skill 补全 |
| `!COMMAND` | 在当前会话 shell 中执行用户命令 |

会话列表中 Tab/Shift+Tab 选择状态筛选，`g` 分组，`/` 搜索，`n` 新建，Enter 打开。审批与管理面板优先处理自己的按键，不套用聊天输入语义。
