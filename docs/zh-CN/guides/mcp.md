# 连接 MCP 工具

[English](../../en/guides/mcp.md) | 简体中文 | [文档首页](../README.md)

## 添加服务器

在 ArkCode 配置目录创建 `mcp.json`。以下是用户级配置示例，需要替换命令、文件路径、工具名称和 URL：

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/path/to/server.mjs"],
      "enabledTools": ["read_*", "search_*"],
      "disabledTools": ["read_secret"]
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "MY_MCP_TOKEN"
    }
  }
}
```

连接本地服务会执行配置中的命令。项目共享配置放到工作区 `.arkcode/mcp.json`，并信任该工作区。同名项目条目完整覆盖用户条目。

运行 `/mcp reload`，用 `/mcp status` 查看状态、`/mcp tools local` 查看工具。首次启动、新建或恢复会话会等待启用服务器完成工具发现。交互模式遇到失败时，选择重试或使用当前可用工具继续；非交互启动失败会报错。

## 管理连接

`/mcp` 打开临时菜单，可查看工具、重连、启停和更改暴露方式。Esc 或 Ctrl+C 逐级返回，保留聊天和草稿。状态与工具列表可在运行期间查看，修改连接需要空闲。

`/mcp reconnect local` 重新读取配置并重建指定服务器；不指定名称则重载全部。启停写回定义服务器的配置文件，外部修改冲突时先 reload。

## 完成 OAuth 授权

服务器要求 OAuth 时运行 `/mcp login remote`，按界面链接完成浏览器授权，必要时粘贴回调 URL。成功后自动重连。`/mcp logout remote` 删除凭据并断开服务。中断或退出取消登录。

本地 stdio、已有 header 或 bearer token 的服务不显示 OAuth 登录动作。登录和登出是否可用由服务器挑战及已存凭据决定。

## 选择工具暴露方式

默认 `codemode` 让模型在脚本内按需发现工具。可用 `/mcp exposure local direct` 保存其他方式。首次模型请求之后，暴露方式修改要在新会话或成功压缩后应用；停用、删除和过滤工具立即阻止实际调用。

暴露不等于批准调用。MCP 遵守[权限规则](permissions.md)，自动批准及全部字段见[MCP 配置参考](../reference/mcp-config.md)。连接诊断见[故障排查](../troubleshooting.md)。
