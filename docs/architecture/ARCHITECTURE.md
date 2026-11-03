# ArkCode 开发结构

Pi 管理模型请求、agent 循环、历史格式、MCP 协议和 CodeMode。ArkCode 管理压缩策略与检查点、工作区信任、权限、受管进程、会话所有权和终端交互。

| 路径 | 职责 |
| --- | --- |
| `src/cli.ts` | CLI 启动入口，构建后仍为 `dist/cli.js` |
| `src/app/` | 参数、宿主编排和 UI/权限事件类型 |
| `src/config/` | 用户设置、模型连接及 SDK 资源装配 |
| `src/context/` | 静态提示、项目指令、动态上下文、工具停用通知与文件提及 |
| `src/compaction/` | 真实输入来源、20k 用户文本保留、请求预算、摘要重试、检查点提交与恢复 |
| `src/integrations/mcp/` | 配置边界和官方 MCP 扩展的宿主适配 |
| `src/integrations/skills.ts` | `.agents/skills` 发现、Pi 解析、启停持久化、正文快照与参考文件读取 |
| `src/integrations/web-search.ts`、`web-search-usage.ts` | 原生搜索、辅助模型 usage、搜索次数与额外费用统计 |
| `src/permissions/` | 三种权限策略、审批状态和 shell 风险分析 |
| `src/session/` | session writer 锁、会话检查、运行标记与分支工具策略快照 |
| `src/tools/index.ts` | 五个 SDK 文件工具适配及两个 shell 工具注册 |
| `src/tools/mode.ts`、`src/tools/loadout.ts` | 基础工具模式、官方 CodeMode／搜索装配及 compact 后应用策略 |
| `src/tools/workspace.ts` | 路径、symlink、敏感目录和大小限制 |
| `src/tools/shell.ts` | 运行期 shell 会话、观察、输入、执行期限和进程树取消 |
| `src/tools/output.ts` | 终端控制字符清理 |
| `src/tools/output-files.ts` | SDK 大结果文件的会话级精确只读授权 |
| `src/ui/` | TUI、补全、slash 命令目录及 Git 状态 |
| `src/ui/mcp.ts` | MCP 临时子菜单、逐级返回和服务操作选择 |
| `src/ui/tool-mode.ts` | 临时工具模式菜单，显示当前和待生效配置 |
| `src/ui/skills.ts`、`src/ui/colors.ts` | Skills 临时菜单、复选启停和共用 Prism 配色 |
| `scripts/pi-sdk-patch/` | 固定版本 SDK 补丁的声明、片段和校验清单 |
| `test/` | 真实 SDK 会话、本地 HTTP/stdio 服务、文件系统和 shell 回归 |

`ArkHost` 管理多个常驻 `SessionRuntime`，只路由当前会话的输入。每个 runtime 拥有自己的 Pi AgentSession、运行标记、审批、shell、工具设置、SkillsManager 及 MCP。`SessionView` 保存每个 runtime 的输出和草稿，切换时重放当前视图；后台交互等待聚焦，取消仅影响所属会话。打开会话列表时也暂停当前会话的交互展示，避免审批盖住列表。关闭宿主会停止并清理所有 runtime。

`SessionLease` 按 session ID 在系统临时目录独占创建锁文件。独立 session 可在同一目录运行；同一 session 的其他宿主只读，不持久化 SDK 初始化产生的条目，也不连接 MCP。viewer 轮询有效 JSONL，遇到尚未写完的条目等待下一次读取。重新打开会话时重新尝试取得输入权，取得后再读取最新磁盘历史。恢复限制来自该 session 自己的运行标记，不扫描整个 workspace 的活动运行。

edit/write 继续由 Pi SDK 的模块级文件队列排序，宿主不另建版本检查或合并机制。该队列只覆盖同一进程的同一 SDK 模块实例，不保证跨终端进程排序，也不约束任意 shell 写入。

增加基础工具时，在 `src/tools/index.ts` 定义能力并加入 `TOOL_NAMES`；该集合同时控制白名单和非 MCP 模式范围。审批放在实际执行边界，直接与 CodeMode 调用共用；不能仅通过 UI 或模型提示控制权限。审批 UI 排队展示请求，取消使整代等待请求失效。七个基础工具使用 Pi 默认并行调度，write/edit 复用 SDK 同文件修改队列；MCP 保留 SDK 的执行策略。

`SessionToolSettings` 从当前分支读取模式、MCP exposure 快照与首次模型请求状态，新会话使用最新配置；旧会话缺少快照时沿用原有 hybrid 行为。`createToolLoadout()` 保留官方 CodeMode `on`，按基础工具 exposure 实现局部 direct/hybrid/only，并限制官方 `tool_search` 不加载基础工具。尚未请求 LLM 时，首次 run 准备阶段重新应用最新选择。首次请求后，工具策略由 ArkCode compact 暂存并与完整替换历史一起提交，提交前失败恢复旧策略，提交后激活异常阻止请求直到恢复。resume/fork 优先读取当前分支的 ArkCode 检查点策略；仅 legacy 检查点保留原先的初始化兼容路径。

`CompactionController` 在每次模型请求前检查完整预算，手动、阈值及实际 overflow 共用同一路径。当前有效历史与已交付用户原文用于摘要，尚未交付的新 query 单独保存。检查点持久化完整模型投影、来源片段、上下文基线和工具策略。原 JSONL 历史保留；用于摘要重试的大工具结果裁剪只修改临时副本。压缩失败而旧请求仍可容纳时警告继续，否则暂停并允许原会话恢复。历史检索与近期 assistant/tool 原文尾部不在首版范围。

MCP 的 `McpManager` 仅将 ArkCode 配置和权限接到 `createMcpExtension()`。它不创建 MCP client，不维护连接池，也不转换工具结果。SDK controller 负责状态、等待启动、按名称重载、取消和关闭。项目配置需经过工作区信任检查，自动批准规则只能来自用户配置。授权绑定配置、工具元数据和实际连接身份；等待授权期间发生变化时拒绝旧调用。

exposure 修改只保存配置；重载时合并当前会话的 exposure 快照。compact 只重载策略发生变化的服务器。服务端目录更新使用 SDK 的真实声明与执行路由；停用工具不再可执行，宿主在后续请求追加隐藏通知。配置中 enabled、工具过滤和删除状态在审批前后重新检查，不能执行审批期间已撤销的调用。

CodeMode 通过 SDK 的嵌套工具管线调用这些工具。它不会绕过白名单，也没有独立访问操作系统的接口。MCP resources 未接入逐服务审批，因此明确禁用；模型子调用同样禁用。

SDK 截断 MCP/CodeMode 输出时会保存临时文件；ArkCode 的 bash/shell_control 在需要时导出完整日志前缀的不可变快照。宿主从这些可信工具的 `fullOutputPath` 元数据登记文件，记录真实路径与文件身份，允许本会话的 read 按 offset/limit 读取；write/edit 和其他工作区外文件仍被拒绝。文件被替换或修改后授权失效，授权不随历史恢复。普通文件保留 2 MiB 上限，已登记文本结果采用有界流式读取，可读取超过 64 MiB 文件中的相关行；二进制辅助读取仍保留 64 MiB 上限。

`ManagedShell` 在当前 agent run 中持有会话，支持跨直接调用与 CodeMode 脚本的 wait/send/stop。观察到期不终止进程；可选 timeout 是独立执行期限。增量位置包含已经省略的输出，后续 wait 不回放。直接预览为 2000 行/50 KiB 尾部，结构化输出为独立 1 MiB 头尾数据；外层 CodeMode 配置不变。运行结束清理进程并使句柄过期，清理未确认时阻止继续执行。`shell-contract.ts` 与 `shell-tools.ts` 定义工具，`shell-output.ts` 与 `shell-context.ts` 管理日志和上下文。完整契约及生成的 schema 见 [shell 控制](shell-control/README.md)。

普通回答明确返回 `length` 时保留原始停止原因和已有输出，宿主在原有工具结果之上最多续写两次，不重放工具。续写仍耗尽时运行和持久标记均为 failed，CLI 返回 1。用户取消时立即停止续写，余额不足和网络错误沿用已有错误及重试路径。空回答和短回答本身不作为截断依据。

原生 WebSearch 的完整 provider usage 通过工具顶层 `usage` 纳入 Pi 累计统计；嵌套调用由 SDK 汇总到外层 CodeMode 结果，不额外写入相同的模型 usage。已收到 usage 的搜索失败也保留消耗，手动 `/web-search check` 则单独写入一次 usage 条目。主模型上下文只接收摘要和链接。

搜索次数及费用以 `arkcode-web-search-usage` 自定义条目保存，在 `/status` 的 `Usage.webSearch` 中显示，恢复和 compact 后仍可统计。Anthropic 优先采用 `server_tool_use.web_search_requests`，没有 provider 次数时按已完成的搜索 ID 去重。官方 HTTPS API 端点按 [OpenAI](https://developers.openai.com/api/docs/pricing#tools) 和 [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#usage-and-pricing) 于 2026-11-03 核对的 $0.01/次单独估算；代理及自定义端点标为未知。`cost` 保持 SDK 的模型费用口径，额外搜索费用使用 `estimatedSearchFeesUSD` 和 `unknownFeeRequests` 单列，不换算为 tokens，也不把未知费用当成免费。连接中断且 provider 尚未返回 usage 时无法补算实际用量；废弃 compact 摘要尝试的补记仍未纳入。

`npm install` 会安装 SDK 补丁，`npm run check`、`npm test`、`npm run build` 会再次核对补丁。构建清理旧输出再编译，避免移动模块后发布遗留文件。发布包保留安装补丁和必要说明，不能使用忽略安装脚本的方式部署未经补丁的 SDK。

验证顺序：类型检查，相关行为测试，完整回归，构建及 CLI 冒烟。涉及 MCP 的改动还应检查冷启动、真实服务握手、工具目录更新、授权等待时的连接/schema 变化、中断和退出。测试不依赖远程模型；浏览器 OAuth 与不同操作系统的手工验证单独记录，不能由模拟服务测试替代。
