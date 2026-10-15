# MCP 连接问题与 Pi 高层集成对照

日期：2026-10-14。依据 ArkCode 安装的 Pi 1.2.0 SDK，未以本地 Pi main 的新增接口替代 release 接口。

## 复现与修复

读取用户 `~/.arkcode/mcp.json`，未修改原配置。Playwright 使用 `npx @playwright/mcp@latest`；Bing Search 使用 `cmd /c npx -y bing-cn-mcp`，与该服务 README 的 Windows 示例一致。

执行 `.audit/runtime/mcp-repro.ts --reconnect`，旧实现中 Bing 首次连接与重连均为 `failed (MCP connection closed)`。Playwright 在该次复现中发现 25 个工具，未复现为永久失败。

相同命令通过 Pi McpClient/StdioTransport，等待 60 秒，Bing 在约 55 秒连接成功，发现 2 个工具。过程中 stderr 出现 npm 安装依赖的警告，进程树仍在运行 npx。ArkCode 原先 10 秒的整体启动定时器会提前终止它；重连又重复同样的限制。这不是 Windows `.cmd` 无法执行，Pi transport 使用 cross-spawn 处理该场景。

修复默认 startupTimeoutMs 为 60000，与 Pi 高层默认请求超时一致；允许显式设置到 300000。保留整体启动截止时间及超时后清理进程，不重放调用。状态错误明确说明 Startup timed out，并附脱敏后的 stderr 尾部；同时保留传输错误。先脱敏再截断，避免截断长凭据后留下凭据片段。reconnect 重新读取配置，指定服务器时仅重建该连接，已删除的服务器撤下工具。

Playwright 用独立空 npm 缓存和原始不带 `-y` 的命令也连接成功，不能认定缺少 `-y` 是此次失败原因。文档建议使用 `-y` 避免安装确认，但实现不擅自改写用户命令。Playwright 初次失败的历史 stderr 不存在，不能追溯性证明每一次失败都来自同一原因。

修复后原配置的首次连接与 reconnect 都成功。真实 ArkHost 使用临时配置目录、本地模型协议服务验证 `/mcp status`、`/mcp reconnect` 与模型请求；25 个 Playwright 工具、2 个 Bing 工具和 6 个内建工具进入模型请求，共 33 个。该验证在 Always Ask 下进行，仅验证握手、目录与暴露，未调用浏览器或实际搜索。

新增回归覆盖超过 10 秒的真实 HTTP 初始化、明确超时提示、stdio 失败 stderr、长凭据脱敏、修改配置后的定向重连与删除服务器。

## pi mcp add 的真实行为

通过安装的 Pi 1.2.0 CLI，在临时 PI_CODING_AGENT_DIR 运行：

```text
pi mcp add playwright -- npx -y @playwright/mcp@latest
```

命令只将 `{command: "npx", args: ["-y", "@playwright/mcp@latest"]}` 写入该目录的 mcp.json，并提示 `pi mcp list` 检查。流程为解析参数、构造 stdio/HTTP 配置、validateMcpServerConfig、addMcpServerConfig。不是按 `playwright` 名称查询安装市场；该名称是配置的 server key。包下载发生在 npx/uvx 启动时。`--local` 使用项目 `.pi/mcp.json`，`--url` 配置 HTTP，`--env`/`--header` 等选项写入对应字段。

将相同用户配置复制进临时 Pi 目录，运行 `pi mcp list --json`，两个服务均 connected，分别 25 和 2 个工具，默认 exposure 为 codemode。该验证使用 Pi 高层连接管理实现，不代表把 createMcpExtension 嵌入 ArkCode 的完整审批/UI 验证已经完成。

ArkCode 目前提供 slash 管理命令，尚无 `arkcode mcp add` 或 `/mcp add`。直接执行 pi 命令会写 Pi 配置目录，不会自动配置 ArkCode。

## 当前实现与建议

当前复用公开 pi-mcp 的 McpClient、StdioTransport、StreamableHttpTransport 和 toLlmContent；ArkCode 实现配置、连接生命周期、direct 动态注册及审批。没有使用 coding-agent 的 createMcpExtension。

两者底层协议相同。当前适配器便于接入 ArkCode 的三种 permission、trusted workspace、viewer/recovery 保护、用户配置目录与自有 TUI。但 Pi 高层已经提供后台连接、OAuth、按需重连、HTTP 暂时性故障重试、resources、codemode/deferred/direct/hidden 暴露，以及超过 20 KiB 的模型文本截断和完整输出文件保存。重建这些能力会持续增加 ArkCode 的维护成本。此次 timeout 与 stderr 问题也是自行管理连接的实际代价，不能说当前方案整体比 Pi 高层更好。

长期建议采用 Pi 高层 MCP 加 ArkCode 薄适配层，保留 ArkCode 的权限与宿主保护。本轮修复连接缺陷，不同时替换后端。

迁移不能仅增加一行 createMcpExtension：

- 用 loadConfig/updateConfig 对接 ArkCode 的路径、项目信任及配置来源；阻止 viewer/recovery 状态启动进程。
- 初期指定 direct，防止 Pi 默认 codemode 与现有白名单不匹配。若开放 deferred/resources，需要明确加入 tool_search 和资源入口，并应用同样的审批行为。
- 通过 tool_call 等执行钩子接入 ApprovalBroker，保留配置/schema/连接变化后的授权失效规则；MCP 名称映射与原始身份需要可靠元数据。
- 对接 ArkCode 的 `/mcp` UI、状态、取消、退出与 session replacement。Pi 高层内部管理器和 CLI 辅助函数没有完整公共导出。
- OAuth credential store 的类型在内部模块，默认凭据目录来自 Pi getAgentDir，不能假设 session.agentDir 自动改变它。应补齐上游的公开凭据构造/目录和连接状态接口，避免依赖内部 dist 路径或修改进程级环境变量。

实现难度中等，主要工作在宿主适配与权限回归，而非协议。迁移时沿用当前三种 permission 行为；Pi 高层不替 ArkCode 自动决定权限策略。

## 验证记录

MCP 新增回归 5 项全部通过；真实 ArkCode 与 Pi CLI 对照均连接成功。`npm run build`、`npm run check` 通过。

第一轮全量测试与第三方 npm 探测同时运行，3 个原有 shell 权限测试失败；它们的解析子进程设有 1 秒超时，单独复测全部通过。停止外部探测后，最终标准 `npm test` 全量 132 项通过，0 失败，日志为 `.audit/runtime/mcp-tests.log`。临时探测脚本与日志位于忽略的 `.audit/runtime/`，不进入发布产物。

参考：安装 SDK 的 `dist/extensions/mcp/cli.js`、`runtime.js`、`index.d.ts`、`tools.js`；[Bing 服务 README](https://github.com/yan5236/bing-cn-mcp-server)；[Playwright MCP README](https://github.com/microsoft/playwright-mcp)。
