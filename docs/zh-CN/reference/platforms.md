# 平台与功能范围

[English](../../en/reference/platforms.md) | 简体中文 | [文档首页](../README.md)

## 运行依赖

| 项目 | 要求 |
| --- | --- |
| Node.js | 至少 22.19.0 |
| Windows shell | 自动发现 Git Bash，找不到时回退 PowerShell，优先 PowerShell 7 |
| macOS、Linux shell | `/bin/sh` |
| Git | 用于分支状态和 Git 工作区边界发现 |
| 模型 | 有效凭据、端点以及可用的工具调用能力 |

每个会话创建时固定 shell。Windows 发现会检查 PATH 对应 Git 安装和常见系统、用户安装位置。工具名仍为 bash，模型提示和 `/status` 显示实际解释器。失败不自动更换解释器。

## 验证范围

Windows 下已有真实 SDK、本地模型与 MCP 协议服务、文件操作、TUI 渲染及子进程树取消测试。它们不代表所有远程供应商或原生终端体验均已验收。

macOS/Linux 的进程组清理实机验证，以及不同终端的中文 IME、系统剪贴板、外部编辑器和浏览器 OAuth 回调仍需在对应环境检查。使用前按自己的平台确认这些操作。

## 当前产品边界

ArkCode 支持多会话并发，不提供多代理编排。Goal、插件、持久 Plan、学习式记忆、云执行、RPC、公开 SDK 和 app-server 未作为产品接口开放。代码审查可以作为普通任务提交，完整 Git diff 使用外部 Git 工具查看。

ArkCode 基于 Pi SDK，但使用自己的配置目录、权限、项目资源发现和压缩策略。Pi 的全部 CLI、扩展、prompt 模板、主题或自动缓存续热不自动可用。上游参考见[Pi 文档](https://pi.dev/docs/latest)。
