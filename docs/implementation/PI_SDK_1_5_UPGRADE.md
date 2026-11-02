# Pi SDK 1.5.0 升级

2026-11-02，Windows，Node.js 24.18.0，npm 11.16.0。ArkCode 将 `@earendil-works/pi-ai`、`pi-coding-agent`、`pi-mcp` 和 `pi-tui` 从 1.2.0 同步升级并精确锁定至 1.5.0。锁文件中的 `pi-agent-core`、`pi-codemode` 和 `pi-telemetry` 同步升级，新增 `pi-schema`。最低 Node.js 要求保持 22.19.0。

升级改动集中在依赖、SDK 补丁及回归验证，应用 `src/` 无需为此次升级修改。

| ArkCode 获得的改进 | 作用与边界 |
| --- | --- |
| 大工具调用的流式处理 | pi-ai 增量解析工具参数，减少大段 write/edit 参数在流式接收时的重复 JSON 解析。未测量性能提升倍数 |
| 中文工具搜索 | 官方 tool_search / CodeMode searchTools 改进非 ASCII 查询分词、工具名匹配及排序 |
| Markdown 与终端显示 | Pi Markdown 复用已渲染块，改善中文标点附近的粗体/斜体、换行及终端控制序列处理。ArkCode 的自定义工具行仍由宿主渲染 |
| 会话保存与恢复 | SessionManager 在追加写入失败时回滚内存，修复 Windows 路径大小写比较，并减少 fork 的重复文件打开。官方会话格式仍为 v3，ArkCode checkpoint 保持 v1 |
| 多会话 CodeMode 调度 | 进程内共享 worker 额度，满额后排队。默认同时存活两个 worker，等待名额最长 60 秒，可通过正整数 `PI_CODEMODE_MAX_WORKERS` 调整额度 |
| MCP 参数校验 | pi-schema 统一校验普通 JSON Schema 与 TypeBox 参数，包括数字字符串转数字、单值转数组。审批使用转换后的实际调用参数 |
| Provider 与 MCP OAuth | 继承新版模型目录、请求协议和错误处理修复，以及 OAuth 注册与授权 URL 处理改进。实际收益取决于使用的 provider 与授权服务 |

上游变更以 [v1.5.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.5.0) 及提交 `f9a26365568127461c47a07a37dcb42c140a3ac5` 为准，参见 [coding-agent 变更记录](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/CHANGELOG.md)、[pi-ai 变更记录](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/ai/CHANGELOG.md) 和 [Pi TUI 变更记录](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/tui/CHANGELOG.md)。

ArkCode 继续使用 TypeBox 工具定义，不需要整体改用 pi-schema。项目没有使用新版不再支持的 TypeBox Refine、BigInt、Undefined、codec 或自定义 Format 校验。`kimi-coding` 从 1.3.0 起改用 Chat Completions；自行覆盖其 `models.json` 配置时，baseUrl 应包含 `/v1`。此次升级不读取或改写用户的模型认证配置。

保留全部 14 个宿主补丁文件。`AgentSession` 导入匹配增加 `getCurrentTools`，并适配移除 `toolResults` 参数后的 `_checkCompaction()` 签名。原生 MCP 实时客户端授权、凭证与日志目录、工具过滤、连接状态检查、Grep 限制、动态提示词 section provider 和宿主压缩/checkpoint 逻辑继续使用原有实现。新的 manifest 依据发布包原文件及补丁结果重新核对 SHA-256；原文件和补丁结果都未变的文件保留旧补丁升级记录。安装测试从 manifest 读取模拟 SDK 版本。维护方式见 [Pi SDK 补丁维护](../development/PI_SDK_PATCH.md)。

新增回归通过真实 ArkHost、Pi SDK、本地模型协议服务和 HTTP MCP 验证两种调用模式的参数转换。模型传入 `{ limit: "7", tags: "one" }`，审批和服务器接收 `{ limit: 7, tags: ["one"] }`；非法数字在审批前失败，后续被拒绝的合法参数不会发送。多会话回归占满两个 worker，取消正在排队的会话，再确认后续会话可在 worker 释放后执行。

`npm run check`、`npm run build`、编译后 CLI 的 `--version` / `--help` 均通过。`npm test` 完整运行 313 项，全部通过，零失败、取消或跳过，其中包括新增的两条 MCP 参数转换用例和一条多会话 worker 用例。补丁回归覆盖全新文件、重复应用、部分应用恢复、旧补丁升级和拒绝异常修改。依赖树和锁文件核对确认八个 Pi 包均为 1.5.0。

发布包检查使用 `.audit/runtime/pi-150-upgrade/package-smoke.mjs`，在项目外的全新临时目录安装 `npm pack` 产物，然后运行已安装 CLI 的版本、帮助、真实 Read 工具调用和 `resume --last`。安装后先检查全部 14 个 SDK 文件的补丁 SHA-256，确认 `postinstall` 自动生效，再验证重复应用。它同时检查随包升级文档和八个 Pi 依赖版本，并将结果、包 SHA-256 与实际会话数量保存到 `package-smoke-result.json`。完整日志保存在 Git 忽略的 `.audit/runtime/pi-150-upgrade/`。

这些检查使用 Windows 和本地协议服务。真实远程模型、外部 OAuth 登录以及 macOS/Linux 实机不属于此次验收。官方 CLI 自更新、扩展更新日志和原生摘要输出策略不会自动成为 ArkCode 的功能。
