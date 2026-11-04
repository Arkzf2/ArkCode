# ArkCode

[English](README.md) | 简体中文 | [文档首页](docs/zh-CN/README.md)

ArkCode 是终端中的 AI 编码助手，可以读取项目、修改文件、运行命令，并在多个会话间继续工作。

ArkCode 提供交互式终端界面、工具审批、会话恢复与分支、输入队列、Skills、MCP 和脚本输出。模型接入和工具循环基于 Pi SDK；权限、项目上下文、持续命令控制和压缩策略由 ArkCode 管理。

## 开始使用

需要 Node.js 22.19 或更新版本。Windows 优先使用 Git Bash，找不到时使用 PowerShell；macOS 和 Linux 使用 `/bin/sh`。依赖与验证范围见[平台支持](docs/zh-CN/reference/platforms.md)。

在源码仓库根目录安装并启动：

```powershell
	npm install
	npm run build
	npm start
```

首次启动选择工作区信任级别，再通过 `/connect` 配置模型和凭据。提交一个任务，例如：

```text
	查看这个项目，说明入口文件和测试命令，先不要修改文件。
```

需要从其他目录使用 `arkcode` 时，在源码仓库执行 `npm link`：

```powershell
	arkcode -C "D:\my-project"
	arkcode resume --last
```

完整的首次运行步骤见[快速开始](docs/zh-CN/quickstart.md)。

## 文档

[文档语言](docs/README.md)：English、简体中文。

| 任务 | 入口 |
| --- | --- |
| 配置供应商、自定义端点和默认模型 | [模型配置](docs/zh-CN/guides/models.md) |
| 输入任务、排队、复制和中断 | [终端操作](docs/zh-CN/guides/terminal.md) |
| 新建、切换、恢复和分支 | [会话管理](docs/zh-CN/guides/sessions.md) |
| 选择审批模式和信任项目 | [权限与信任](docs/zh-CN/guides/permissions.md) |
| 设置项目规则与可复用工作流 | [AGENTS.md](docs/zh-CN/guides/instructions.md)、[Skills](docs/zh-CN/guides/skills.md) |
| 连接外部工具或使用网页搜索 | [MCP](docs/zh-CN/guides/mcp.md)、[Web Search](docs/zh-CN/guides/web-search.md) |
| 在脚本中运行并处理 JSON 输出 | [脚本使用](docs/zh-CN/guides/scripting.md) |
| 查询命令、配置、工具和限制 | [文档首页](docs/zh-CN/README.md)、[故障排查](docs/zh-CN/troubleshooting.md) |

当前版本为 `0.1.0`。开发与文档维护见[贡献指南（英文）](CONTRIBUTING.md)。
