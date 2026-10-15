# MCP 首期接入与权限决策

日期：2026-10-14。SDK：Pi 1.2.0。当前修改未提交 commit。

## 已实现

- 使用 pi-mcp 公开 SDK，直接依赖精确 1.2.0；协议传输不复制进 ArkCode。
- 用户 `<home>/mcp.json` 与可信项目 `.arkcode/mcp.json`，同名项目条目完整覆盖用户条目；保留实际配置来源。
- `/mcp` 状态和选择面板，status/tools/reload/reconnect/enable/disable，以及子命令和当前服务器名补全。
- stdio 和 Streamable HTTP，静态 headers、环境变量 bearer token、env/header 的 `${VAR}` 引用。
- 会话工具白名单由原来的六工具扩展为六工具 + `mcp__*`。只有 ArkCode 内联 MCP 适配器从已连接服务发现并按 enabledTools/disabledTools 过滤的工具才会注册，未开放任意项目 extension。
- direct 工具暴露，保留原始 server/tool 与模型名称映射、名称长度限制和冲突检测。过滤使用服务原始名称，支持 glob，disabledTools 优先。
- tools/list_changed 更新模型工具目录，断线/删除/禁用时将旧定义转 hidden，执行入口同时检查连接和 schema 身份。
- 文本、图片、structuredContent、工具错误及进度转交 Pi。协议失败和调用超时提示执行可能已经发生，不自动重放。
- 审批拒绝前不调用 callTool；审批期间 schema 变化使旧调用失效。连接重建、新会话、恢复和权限切换均不沿用旧 MCP 授权。
- 中断传递 AbortSignal 和协议取消；退出及会话替换等待 MCP 连接关闭。viewer 和 execution-unconfirmed 不启动 MCP。

实现入口：[配置解析](/D:/ArkCode/src/mcp-config.ts)、[连接与工具适配](/D:/ArkCode/src/mcp.ts)、[宿主接线](/D:/ArkCode/src/runtime.ts)、[审批](/D:/ArkCode/src/approval.ts)。使用说明在 [README](/D:/ArkCode/README.md)。

## 三种 permission 的分配

| 模式 | MCP 行为 |
| --- | --- |
| always-ask | 默认询问全部 MCP 调用，包括 readOnlyHint 工具。已批准的相同调用可使用会话授权；destructiveHint 为 true 时每次仍询问。用户 autoApproveTools 不生效。 |
| ask-when-needed | 默认询问未知 MCP 调用。只有用户级 mcp.json 的 autoApproveTools 匹配时自动批准，或已有同身份/参数的会话授权。destructiveHint 为 true 时优先询问，不被上述批准绕过。 |
| never-ask | 跳过 MCP 调用审批。仍受服务器开关、工具暴露过滤、viewer、停止、历史失败和执行恢复保护约束。 |

autoApproveTools 只允许用户配置授予；项目配置中的非空规则拒绝加载该服务器。同名项目覆盖不会继承用户的规则。会话授权身份包含原始 server/tool、来源、配置指纹、连接身份、工具定义指纹及完整参数。

选这个默认值的原因是内建 Bash 有本地有限危险规则，未知 MCP 没有同等可验证的副作用模型。直接把现有 ask-when-needed 的“没有危险 shell 证据则允许”应用到 MCP，会把未知外部写入当作普通动作。服务的 readOnlyHint 是提示，不能作为免审批保证；destructiveHint 可以保守地增加审批。用户仍可通过 autoApproveTools 或 Never Ask 明确选择自动执行。

这与 Kimi 的 Ask When Needed 自动批准 MCP 并不完全相同，是 ArkCode 本次明确采用的保守规则。原有六工具的 permission 行为不变，切换模式不改变 MCP schema。MCP 授权不是“工具是否暴露”的白名单，也不是 OS 沙箱。

## 必要改造与后续范围

本次已经完成开放命令之外的必要改造：动态 registry、集中授权、原始身份记录、配置来源/信任、取消、异步关闭、旧工具撤下、UI 展示和补全。不只解除 unsupported 限制。

尚未实现：OAuth login/logout、legacy HTTP+SSE、deferred/tool search、MCP resources/prompts 管理、配置 watcher、大结果附件分页、音视频/二进制原件持久化、跨客户端配置导入。首期直接暴露全部启用工具可能增加上下文；服务器多时通过 enabledTools 缩小范围。

外部 MCP 服务不受 workspacePath 文件保护约束，roots 只声明工作区。协议取消不保证撤销服务端效果；强制杀死宿主也不能保证 stdio 子孙进程全部退出。初版没有 OS 沙箱或自动副作用回滚。

后续已经补充 Windows 上真实 Playwright 与 Bing Search 的握手、工具发现、reconnect 及模型请求暴露验证，并修复 10 秒启动等待不足、隐藏 stderr 和 reconnect 不重新读取配置的问题。详见 [连接问题与 Pi 对照](CONNECTION_DIAGNOSIS.md)。OAuth、实际浏览器/搜索调用和 macOS/Linux 的 MCP 子进程树关闭仍需后续实机验证。

## 验证

首期全量 `npm test` 127 项通过，后续连接修复增加 5 项回归，最终标准 `npm test` 132 项全部通过；`npm run check`、`npm run build`、`git diff --check` 通过。构建后的 CLI help/version 和首期 MCP/终端专项 19 项也已验证。

专项行为包括：三种权限、服务标记不能冒充内建 Read、准确参数/连接身份授权、拒绝零外部调用、审批中 schema 改变、工具目录替换、结构化/错误结果、环境变量认证、失败服务隔离、startup timeout、忙时拒绝管理写操作、in-flight 取消、viewer/unconfirmed/untrusted 不连接、真实 stdio 退出和终端显示。

测试入口：[MCP 配置与补全](/D:/ArkCode/test/mcp.test.ts)、[宿主端到端](/D:/ArkCode/test/runtime.test.ts)、[终端验证](/D:/ArkCode/test/ui.test.ts)。
