# 选择权限与信任级别

[English](../../en/guides/permissions.md) | 简体中文 | [文档首页](../README.md)

## 选择审批模式

使用 `/permissions` 选择模式，保存为下次启动的默认值。CLI 的 `--permissions` 可覆盖当次启动。

| 模式 | 自动允许 | 仍需询问 |
| --- | --- | --- |
| Always Ask，`always-ask` | 内建 read、grep、glob；当前 shell 的独立目录列表；shell wait 和 stop；符合身份与参数的已有普通会话授权 | 其他写入、命令、shell send 和 MCP 调用 |
| Ask When Needed，`ask-when-needed` | 普通内建动作、shell wait 和 stop；匹配用户级 MCP 自动批准规则的普通工具 | 有限高危 shell 规则、shell send、MCP destructive 工具及其他未获批准的 MCP 调用 |
| Never Ask，`never-ask` | 不等待工具调用审批 | 服务器启用、过滤、文件边界、viewer 和恢复保护仍然生效 |

Always Ask 的目录列表豁免只适用于单独的 `ls`，PowerShell 也支持 `Get-ChildItem`。管道、重定向、命令替换和串联命令不属于该豁免。

审批面板可允许本次、允许同一会话的相同操作，或拒绝。授权绑定完整参数、目录和 shell；MCP 还绑定配置、schema 与连接身份。停止、权限切换和历史恢复不沿用旧审批。高危命令、shell send 和 destructive MCP 调用在两种询问模式下每次仍需批准。

## 理解风险检查范围

Ask When Needed 检查关机、格式化、写设备、递归强制删除等有限规则，也检查部分命令包装和嵌套 shell。它不分析任意脚本或所有副作用。`git push`、`git reset --hard` 和 Python 脚本不会仅因这些有限规则而要求审批。

POSIX 命令解析失败、超时或遇到未支持的 heredoc 时，Ask When Needed 自动允许，Always Ask 询问。无变量、通配符和 `..` 的 `/tmp`、`/temp` 删除目标有规则例外。因此，Ask When Needed 不等于只执行无副作用的命令。

文件工具有工作区、敏感路径、symlink 和大小限制。shell 按当前用户的系统权限执行，可以访问工作区外。MCP 操作由外部服务执行，MCP roots 不构成操作系统沙箱。

## 信任项目

首次打开目录时选择是否信任，或使用 `--trust` 显式信任。信任允许加载项目 AGENTS.md、项目 Skills 和 `.arkcode/mcp.json`。连接 stdio MCP 会启动项目配置的命令，发生在具体工具调用审批之前。

未信任目录保留全局 AGENTS.md 和用户 Skills，跳过项目资源，默认 Always Ask；显式 CLI 权限仍然生效。用户级配置始终属于用户可信配置。

MCP 自动批准只能在用户 `mcp.json` 设置，见[MCP 配置](../reference/mcp-config.md)。审批与工具暴露相互独立，见[工具模式](../reference/tool-modes.md)。
