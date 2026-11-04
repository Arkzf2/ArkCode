# MCP 配置参考

[English](../../en/reference/mcp-config.md) | 简体中文 | [文档首页](../README.md)

配置文件为严格 JSON，根对象只包含 `mcpServers`，文件最多 1 MiB。每个服务器名称由字母、数字、点、下划线和连字符组成，以字母或数字开头。服务器条目未知字段会导致该条目诊断失败。

## 来源与覆盖

先读取用户 `<home>/mcp.json`，再读取可信工作区 `.arkcode/mcp.json`。同名项目服务器整体替换用户服务器，不合并字段，也不继承自动批准。未信任项目跳过项目配置。

`autoApproveTools` 只允许用户配置设置非空规则。项目条目包含非空自动批准规则时，该服务器不加载，不回退使用被覆盖的用户条目。

## 共用字段

| 字段 | 类型、默认和约束 |
| --- | --- |
| `enabled` | 布尔，默认 true |
| `description` | 可选字符串 |
| `exposure` | codemode、deferred、direct、hidden，默认 codemode |
| `toolExposure` | 可选对象，按原始工具名或 Pi 的 `*` 模式指定 exposure |
| `enabledTools` | 可选非空字符串数组；省略表示全部候选，空数组表示没有工具 |
| `disabledTools` | 字符串数组，默认 []，优先排除 |
| `autoApproveTools` | 字符串数组，默认 []，只允许用户级配置；仅 Ask When Needed 使用 |
| `startupTimeoutMs` | 正整数，默认 60000，最大 300000，包含启动和工具发现等待 |
| `toolTimeoutMs` | 正整数，默认 30000，最大 300000 |

`enabledTools`、`disabledTools` 和 `autoApproveTools` 按服务原始工具名匹配 glob。过滤优先于暴露和批准。`readOnlyHint` 不自动授予调用权限；`destructiveHint` 在两种询问模式下始终要求批准。

## stdio 字段

| 字段 | 类型、默认和约束 |
| --- | --- |
| `transport` | 省略或 `stdio` |
| `command` | 必填非空字符串 |
| `args` | 字符串数组，默认 [] |
| `cwd` | 可选非空路径；相对路径以当前工作区为基准 |
| `env` | 字符串键值对象，默认 {}；值中的 `${NAME}` 在连接时读取环境变量 |

连接即启动配置命令，不等待模型工具审批。stdout 用于 MCP 协议；服务日志应写 stderr。Windows 的 `.cmd` 启动由传输层处理。npx 或 uvx 首次下载也占启动预算。

## Streamable HTTP 字段

| 字段 | 类型、默认和约束 |
| --- | --- |
| `transport` | 省略或 `http` |
| `url` | 必填 HTTP(S) URL，不得内嵌凭据 |
| `headers` | 字符串键值对象，默认 {}；支持 `${NAME}` |
| `bearerTokenEnvVar` | 可选环境变量名，连接时读取 bearer token |

缺失的环境变量导致连接失败。OAuth 凭据独立保存在 `<home>/mcp-auth.json`，通过 `/mcp login` 和 `/mcp logout` 管理，不手工编辑 token 文件。

## 生效与调用

`exposure` 和 `toolExposure` 的生效边界见[工具模式](tool-modes.md)。服务器关闭、配置删除和工具过滤立即阻止实际调用。连接重建或 schema 改变后，旧审批不能复用。

模型工具名称使用 `mcp__SERVER__TOOL` 形式，名称清洗、超长和冲突处理可能加 hash。不能通过构造名字调用未发现或已过滤的工具。

普通失败和超时不自动重放工具。服务明确报告 session expired 时，运行时可能重建会话并重试一次，仍经过新连接授权。取消请求不保证外部副作用已撤销。

当前未开放 MCP resources/prompts 管理、旧式 HTTP+SSE、跨客户端配置导入或文件 watcher。配置变更使用 reload 或 reconnect，操作见[MCP 指南](../guides/mcp.md)。
