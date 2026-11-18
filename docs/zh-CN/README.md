# ArkCode 文档

[English](../en/README.md) | 简体中文

这里说明 ArkCode `0.1.0` 的使用方式、配置和接口。首次使用从[快速开始](quickstart.md)进入。

基准测试成绩见[项目首页](../../README-CN.md#基准测试)。

## 日常使用

| 任务 | 文档 |
| --- | --- |
| 配置模型、密钥或兼容端点 | [模型配置](guides/models.md) |
| 输入任务、处理队列和查看输出 | [终端操作](guides/terminal.md) |
| 同时处理多个任务、恢复或分支 | [会话管理](guides/sessions.md) |
| 选择审批模式和项目信任 | [权限与信任](guides/permissions.md) |
| 给项目设置长期规则 | [使用 AGENTS.md](guides/instructions.md) |
| 选择和管理可复用工作流 | [使用 Skills](guides/skills.md) |
| 连接外部工具 | [使用 MCP](guides/mcp.md) |
| 检查和使用供应商网页搜索 | [使用 Web Search](guides/web-search.md) |
| 在脚本或 CI 中执行任务 | [脚本使用](guides/scripting.md) |

## 查阅接口

| 内容 | 参考 |
| --- | --- |
| 启动参数、子命令、退出码 | [CLI](reference/cli.md) |
| slash 命令和快捷键 | [交互命令](reference/commands.md) |
| 配置目录、settings、模型与环境变量 | [配置文件](reference/configuration.md) |
| MCP transport、过滤、认证和覆盖规则 | [MCP 配置](reference/mcp-config.md) |
| Skill 格式、发现与读取规则 | [Skills 参考](reference/skills.md) |
| 工具参数、shell 控制和输出限制 | [工具参考](reference/tools.md) |
| CodeMode 和配置生效时机 | [工具模式](reference/tool-modes.md) |
| 非交互 JSON 格式 | [JSON 事件](reference/json-events.md) |
| 摘要生成的精确指令 | [压缩提示参考](reference/compaction-prompts.md) |
| 系统依赖、平台验证和功能范围 | [平台与限制](reference/platforms.md) |

## 理解行为与排查问题

- [会话生命周期](concepts/session-lifecycle.md)解释会话、运行、句柄和历史的关系。
- [上下文与压缩](concepts/context-and-compaction.md)解释模型实际看到的内容，以及压缩后如何继续工作。
- [故障排查](troubleshooting.md)覆盖模型连接、MCP、viewer、执行未确认、shell 和压缩问题。

开发与文档校验见[贡献指南（英文）](../../CONTRIBUTING.md)。
