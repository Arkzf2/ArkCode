# 工具模式与生效时机

[English](../../en/reference/tool-modes.md) | 简体中文 | [文档首页](../README.md)

工具模式决定模型怎样调用七个内建工具，不决定执行权限。`WebSearch` 遵循相同内建模式策略，MCP exposure 独立配置。

| toolMode | 直接调用内建工具 | 通过 CodeMode 调用 |
| --- | --- | --- |
| `direct` | 是 | 否 |
| `codemode` | 是 | 是，默认模式 |
| `codemode-only` | 否 | 是 |

CodeMode 使用 QuickJS 执行 JavaScript。脚本通过 `searchTools()`、`describeTool()` 发现工具，通过 `tools.NAME()` 调用，`text()` 输出，`store()` 和 `load()` 保存分支内 JSON 数据。它没有独立访问操作系统的接口，也没有额外 exec/wait 后台脚本单元机制。

## MCP exposure

| exposure | 行为 |
| --- | --- |
| `codemode` | 默认，在脚本内按需发现 |
| `deferred` | 通过 tool_search 加载 |
| `direct` | 直接声明给模型 |
| `hidden` | 隐藏 |

内建 codemode-only 不会隐藏单独配置为 direct 的 MCP 工具。工具搜索不能绕过内建模式。服务端工具目录更新仍可在会话中发生，不因快照固定 schema。

## 设置何时应用

| 情况 | 使用的策略 |
| --- | --- |
| 新会话、首次模型请求前 | 最新保存的配置，可以反复更改 |
| 已经请求过模型的会话 | 当前分支策略，新的选择显示为待生效 |
| resume、fork | 起点分支的策略和是否已请求模型的状态 |
| 手动或自动 compact 成功 | 应用最新工具模式及 MCP exposure，并写入检查点 |
| compact 取消或失败 | 保留旧策略 |
| reload、reconnect、enable | 已请求会话保留当前 exposure，新增服务器等待策略边界 |
| disable、删除配置、工具过滤 | 立即阻止实际执行 |

策略快照不复制凭据、请求头或启动命令，也不恢复旧审批。配置与 schema 会在实际执行边界重新检查。更改审批模式立即生效，不需要 compact。

`/web-search on` 和 off 从下一次任务应用。真实 MCP 目录撤销、连接身份变化和工具停用仍会立即影响可调用性。模式生效不承诺供应商 prompt cache 命中。
