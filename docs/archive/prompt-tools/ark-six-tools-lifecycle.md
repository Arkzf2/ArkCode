# 六个常驻工具与上下文生命周期

分析日期为 2026-10-13。本轮只写报告，未改应用代码、依赖或配置。目标按本轮决定记录：常驻工具为 `Read`、`Write`、`Edit`、`Grep`、`Glob`、`Bash`，删除 `ls`，原 `find` 改为 `Glob`；没有 OS sandbox；审批采用三种 Kimi 风格模式。它们尚未实现，当前源码仍为七个小写工具及旧权限模式。

## 1. 当前资源的读取时机

`createResources(cwd,trusted)` 在创建时读取 AGENTS，并把结果保存在闭包 `agentsFiles`。`getAgentsFiles()` 返回这份快照；只有调用该 loader 的 `reload()` 才重新读取。读取根目录到 cwd 的各级 `AGENTS.md`，单文件最多 64 KiB，总计 128 KiB。未信任工作区返回空列表，cwd 下更深目录的 AGENTS 不在扫描范围。[实现](D:/ArkCode/src/config.ts:206)、[资源 loader](D:/ArkCode/src/config.ts:235)

Ark 每次 `replaceSession` 都创建新的 loader，传给 Pi SDK。SDK 仅在没有自定义 loader 时创建和 reload 默认 loader，Ark 不走该分支。现有 loader 自身的构造读取已经足够初始化。[Ark 接入](D:/ArkCode/src/runtime.ts:187)、[SDK 默认 loader 分支](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:78)

| 事件 | AGENTS 是否从磁盘重读 | system 和工具行为 |
|---|---|---|
| 首次启动新会话 | 是，创建 Ark loader 时 | 按当前 customPrompt、cwd、可信 AGENTS、显式工具构建 |
| `/new` | 是，替换整个 session | 新历史，重新建立 system 与声明 |
| `/resume` 和启动参数 resume | 是，替换整个 session | 旧历史恢复；当前 loader 的 section 和当前工具在下一请求通过差异更新 |
| `/fork` 和启动参数 fork | 是，替换整个 session | Pi 复制非 header entries 到新 session；仍用当前 Ark loader 和显式工具 |
| 手动 `/compact` | 否 | 保存当前完整 system/tools 状态，重建模型上下文 |
| 自动 compact，阈值或 overflow | 否 | 同样保存并重插当前 system/tools 状态，再按条件继续 |
| 现有普通 prompt 或 `setActiveToolsByName` | 否 | 重新构造 system options，但 getter 返回的仍是 AGENTS 快照 |
| Pi `session.reload()` | 是，会调用 Ark loader.reload | 重建 runtime、registry 和 system options；现有 Ark 没有这个命令入口 |

new/resume/fork/compact 路由见 [Ark commands](D:/ArkCode/src/runtime.ts:606)，启动恢复见 [startup](D:/ArkCode/src/runtime.ts:118)，fork 复制规则见 [SessionManager.forkFrom](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1374)，reload 见 [Pi](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2936)。现有 slash 清单没有 `/reload`。[命令集合](D:/ArkCode/src/runtime.ts:569)

例如 `/init` 写入 AGENTS 后，当前 loader 没有自动更新。新建、恢复或 fork 会读取这个新文件；同会话内接着发 prompt 或 compact 都不会读取新版本。[init](D:/ArkCode/src/runtime.ts:623)、[闭包 reload](D:/ArkCode/src/config.ts:250)

## 2. 压缩究竟保留什么

Pi 的 system 是带命名 sections 的历史状态。`_rebuildSystemPrompt` 从 loader 取 customPrompt、AGENTS、skills，并复制到 base options；`_preparePromptAndToolLoadout` 把新 sections 与历史中已生效的 sections 比较，只写差异。每次新的 assistant 响应前也会按当前 active tools 校正声明。[构建](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1267)、[section 差异](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1306)、[下一响应边界](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:532)

手动 compact 和自动 compact 均调用 `appendCompaction`。它先取得 `getCurrentSystemMessage(buildSessionProjection().messages)`，把完整 system sections 和完整 toolsAdded 当前集合保存为 compaction entry 的 `systemMessage`。恢复模型上下文时，compaction entry 展开成 `[systemMessage, summary]`，再加近期保留消息。压缩范围内旧 system delta 不再重复加入，因为 snapshot 已包含最终状态。[手动压缩](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2235)、[自动压缩](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2524)、[snapshot](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:880)、[恢复](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:187)、[保留消息选择](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:203)

这里有三个不同动作。

- 保留是把已经生效的 system/tools 当前状态保存到 compaction entry。
- 重插是把该 snapshot 放进新的模型上下文，避免 system 和 schema 被摘要替代。
- 刷新是重新读取磁盘文件或查询当前 host 状态，再构造新的上下文。compact 本身不执行这个动作。

因此不能声称“compact 后 AGENTS 自动刷新”，也不需要为防止丢失而每次手工追加相同 AGENTS 全文。当前 Pi 已保留 system，真正的问题是磁盘快照过时。`_refreshFinalizedContext()` 只做 session projection，不是 resource reload。[projection](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:571)

当前 Ark customPrompt 生成 `preamble`，AGENTS 生成 `project_context`，cwd 生成 `cwd`；skills 为空。提供 customPrompt 后 Pi 不自动生成默认 tools/rules/docs 段。当前也没有日期、OS、审批模式段，不能说这些现有内容会被压缩保留，因为它们尚未加入。[system 构造](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:78)、[Ark loader](D:/ArkCode/src/config.ts:238)

## 3. 建议的刷新与重插策略

| 信息 | 初始化或 resume/fork | 普通请求 | compact 后 |
|---|---|---|---|
| 静态基础 system 与六个 schema | 用当前版本构建 | 不随审批切换改动 | 依靠 Pi snapshot 保留，不重复追加 |
| cwd、OS、真实 shell、无 sandbox 事实 | 从当前 host 取值，补新 section | 只有真实状态变更才更新 | 已有 section 重插；压缩本身不要求重新探测 |
| 当前日期与时区 | 查询当前 host 日期 | 跨日或时区变化才追加新的 runtime fact | 查询当前值，补一份事实，避免摘要里的旧日期继续生效 |
| 当前审批模式、policyVersion | 保存在宿主 state，不发给模型 | 只影响执行策略，不发送模式名称和 policyVersion | 保留宿主 state，不能依赖摘要恢复权限；不补发模式 |
| 独立执行限制 | 宿主 enforce | 影响任务继续执行时只报告一次实际限制 | 限制仍由宿主执行，不因压缩取消 |
| AGENTS | new/resume/fork 按当前信任状态读取 | 本版不引入每请求 watcher；进入子目录按适用规则检查文件 | 成功后重新读取并更新 project_context；内容相同不重复全文 |
| skill 目录和全文 | 未来目录初始化，正文按需 | 目录变化时更新；按需读正文 | 目录保留或重建；必要正文按任务重新加载，不当成全部永久 system |

日期事实可以使用 host 生成的 custom runtime message，Pi 会映射成 user message；它是运行事实，不是权限凭证。本版按最新决定不发送审批模式名或 policyVersion，稳定 system 只保留通用审批准则。[前一方案](D:/ArkCode/research/prompt-tools/feasibility-plan.md:106) 中发送模式的建议已被此决定替代。当前 Pi `sendCustomMessage` 可在 idle 追加不触发模型的消息；流式中会排队，下一响应前即时刷新需要在实际响应边界接入，而非以一次 host event 监听假装已送达。[custom 消息](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1771)、[消息映射](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js:89)

本版确定在 new/resume/fork 和 compact 成功后刷新 AGENTS。删除文件也必须移除其旧内容；未信任工作区仍不能加载。目录变化提醒和刷新失败应明确记录，不能静默把旧快照当作当前文件。每个安全请求边界检查内容 fingerprint 是可选后续能力，当前不要求引入 watcher。

不要直接把完整 `session.reload()` 当成每次 AGENTS 检查。它还关闭旧 extension runner、reload settings、重建 registry 和 runtime。更小的接入是刷新 Ark 管理的 instruction snapshot，再在边界重建 base sections。具体可用 SDK hook 或 resource 接口需实现阶段选定；当前 `setActiveToolsByName` 能触发 `_rebuildSystemPrompt`，但不能在 ongoing run 的 `_runSystemPromptOptions` 仍引用旧 snapshot 时宣称立即生效。[reload 范围](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2936)、[active tool 更新](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1110)、[run options 选择](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:544)

兼容 provider 会把所有 system sections 合并到开头。AGENTS 真正变化时前缀变化合理；为保留缓存而使用过期项目指令不合适。日期事实可以追加在历史尾部，减少无关稳定前缀变化。压缩后对话长度与前缀本身有变化，不能承诺缓存不断。[system collapse](D:/ArkCode/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js:96)

### 可等待的接入点

当前 Ark loader 的 extensions 为空，要使用以下 hooks 需由 Ark 注册一个内置 extension，不能假定用户插件已提供它。

| 接入点 | 可以做什么 | 边界 |
|---|---|---|
| `session_compact` | manual、threshold、overflow 成功后 await 检查并读取 AGENTS，保存当前 snapshot 或 dirty 状态 | 已有 compaction entry 此时已经持久化。hook 执行不直接改已保存 systemMessage |
| `before_agent_start` | 在新用户 prompt 前把 `event.systemPromptOptions.contextFiles` 替换成当前 snapshot，Pi 随后生成可持久化的 section delta | 自动 compact 后同一 run 的 continue 不会重新触发此事件，不能作为唯一接入点 |
| `context_with_system` | 每次模型请求前 await，包含自动继续与 retry；可以在 provider projection 中替换最终 project_context | 返回的是请求投影，不是历史持久化。必须明确维护 host snapshot，并在下一正常 prompt 将 section delta 保存，否则 transcript 与请求可能暂时不同 |
| `Agent.prepareNextTurnWithContext` | 可在 Pi 已安装的边界函数之后，读取 fresh snapshot 并返回附加 system section patch，进入下一 turn pending messages | 属于较低层 adapter。必须保留原函数结果、工具关联和模型设置；还需同步 base/run options，避免 Pi 下一轮再次覆盖成旧 snapshot |

`session_compact` 在 manual/auto 中都被 await，位置早于 `compaction_end` 通知。`before_agent_start` 类型明确允许修改 systemPromptOptions。`context_with_system` 在普通 context hooks 之后执行，其返回消息直接用作请求，普通 `context` hook 不能替换 system。[await compact hook](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2243)、[自动 compact hook](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2532)、[mutable options 类型](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:708)、[两阶段 context](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:999)、[Pi next-turn wrapper](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:532)

最小可落地方案是内置 extension 在 `session_compact` await 刷新 snapshot，`before_agent_start` 更新持久 sections，并用 `context_with_system` 确保自动继续的实际请求先获得 fresh project_context。该方案需要接受并记录短期“请求投影已更新，持久 section 等下一用户 prompt 更新”的区别。如果要求自动继续时历史也立即同步，应集中实现 next-turn adapter，或对 Pi 增加明确的刷新接口；本次没有找到能直接调用的 public `refreshSystemPrompt(contextFiles)` 方法。不能通过修改私有 `_runSystemPromptOptions` 来隐藏这项接入成本。

Ark UI 的 `compaction_end` 订阅只是通知链，异步 listener 的 Promise 不等于 Pi await 的 hook。用它触发异步 reread 后立刻自动继续会产生竞态。上述 hooks 的异常处理也会记录 extension error 后继续，所以读取失败的处理必须由 Ark 明确定义，不能仅依赖 throw 保证模型请求阻断。[UI 事件](D:/ArkCode/src/runtime.ts:314)、[extension emit 异常处理](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:813)

## 4. 大写六工具对 Pi 的具体影响

### 注册和激活

Pi 注册、allowlist、调用名称匹配区分大小写。普通 SDK `tools` 列表可以含任意 custom 名称，不要求来自 builtin 名称常量。把列表和 custom definitions 都改为六个大写名可以正常通过选择逻辑；六个 lowercase builtins 会因 allowlist 不匹配而被过滤，而不是被大写名覆盖。[SDK validation/选择](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:145)、[validation](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js:45)、[名称 matcher](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js:19)、[registry 构造](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2815)

必须同时更新 definition.name、label、authorize request.tool、工具选择列表、UI 分类与展示、user shell 请求名、文档和测试夹具。只改 `tools` 列表会把原小写 custom tools 过滤掉；只改 definition 则 allowlist 不允许新工具。Ark 当前 readTools 判定还是审批自动放行入口，必须改为 explicit policy，而非顺手把任何大写都放行。[Ark 注册](D:/ArkCode/src/runtime.ts:196)、[工具 request](D:/ArkCode/src/tools.ts:226)、[UI 分类](D:/ArkCode/src/ui.ts:472)、[user shell](D:/ArkCode/src/runtime.ts:403)

保持六工具常驻还意味着移除现有 read-only 模式用 `setActiveToolsByName(readTools)` 裁剪 schema 的行为。只读或 writer 丢失等限制若继续需要，应由执行阶段拒绝 Write/Edit/Bash 的副作用，不能用“常驻”推导它们获得执行许可。当前 unconfirmed 保护也会裁剪工具；重构应保留其实际执行拒绝效果。[当前 read-only 与 unconfirmed](D:/ArkCode/src/runtime.ts:228)、[旧 broker](D:/ArkCode/src/approval.ts:13)

### Prompt 与 skill 兼容

当前 customPrompt 不使用 Pi 默认规则，工具改名不会自动补足 Ark 的工具选择说明。拟议 system 和工具 description 必须明确使用 `Read/Grep/Glob/Bash`，特别是 Glob 仅查文件名、Bash 根据真实 shell 执行。[customPrompt 分支](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:78)

Pi `buildRules` 只检查小写 `bash/powershell/grep/find/ls`，未来若撤去 customPrompt，默认 fallback 准则也不能识别这组大写名。更隐蔽的是 Pi skills section 只把小写 `read` 或 `bash` 当作正文读取工具；仅大写 `Read/Bash` 会导致非空 skill catalog 也不生成默认 skills section。当前 Ark skills 为空，所以现在没有可见故障，未来启用时必须由 Ark 显式生成 catalog section 或使用支持自定义 reader 名称的适配。[规则](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:41)、[skills reader 门控](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:102)

### 压缩文件追踪

Pi compaction 文件追踪的 switch 只接受 `read/write/edit`。`Read/Write/Edit` 仍会出现在待摘要对话中，模型也可能自行总结，但宿主自动生成的 `read-files`、`modified-files` 以及 compaction details 不会记录这些大写调用。[extractFileOps](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js:36)、[清单写入摘要](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:710)

建议用 Ark 内置的 `session_before_compact` hook 适配此 tracker，不公开 lowercase aliases，不改 node_modules。该 hook 的 `event.preparation.fileOps` 是可变 Set 集合，manual/auto 两条路径都 await hook 后把同一个 preparation 交给默认 compact。hook 扫描 `messagesToSummarize` 和 `turnPrefixMessages` 的规范大写调用，把 path 加入相应 Set，不返回自定义 compaction，即可继续使用 Pi 原摘要、retry 和 token 逻辑。旧小写追踪及前次 compaction 的文件清单继续保留，不需要清空。[hook 类型](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:588)、[preparation 类型](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.d.ts:118)、[await handler](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:813)、[默认摘要读取 fileOps](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:710)

这条可变 preparation 接入依据安装版源码和公开类型，实施时需要验证 manual、threshold、overflow 三条路径；不是已实现功能。不能在 `session_compact` 之后只修改 event.compactionEntry，期待已写入磁盘的 JSONL 自动改变。

本轮直接调用安装版纯函数验证，无模型请求、无文件操作执行：小写 read/write/edit 正常生成清单，大写三个名称均返回空清单；skills catalog 在小写 read/bash 下生成 skills section，在大写 Read/Bash 下不生成；六个大写 allowlist 匹配 `Read` 而不匹配 `read`。这证明具体大小写兼容问题，不是性能评测。

### 旧会话恢复

Ark storage schema 允许任意非空 toolCall name 和 toolResult toolName，旧 lowercase 历史可以继续读取，不必批量重写 JSONL。[storage schema](D:/ArkCode/src/storage.ts:119)

Ark 始终显式传 SDK tools。Pi 构造 session 时只在 `initialActiveToolNames === undefined` 才从 transcript 恢复 active tool set；当前 SDK 显式选择路径已经提供该集合，因此旧历史不会把新六工具自动变回旧七工具。下一请求比较旧声明与当前可执行集合，生成 toolsRemoved 旧七名和 toolsAdded 新六名。它们是历史协议记录，不是新增七个 active tools。[Pi constructor](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:209)、[tool 差异](D:/ArkCode/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:218)、[工具状态比较](D:/ArkCode/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js:126)

历史 assistant toolCall/toolResult 不会因为读取恢复而再次执行。若模型在新的响应里继续调用旧 `find`/`ls`，严格执行入口返回 tool not found；下一次可见的 canonical schema 必须只有新六名。可在恢复的 runtime fact 里简短说明工具版本迁移，避免旧摘要示例误导。provider 对旧历史关联与新声明的兼容需要实现阶段验证，不能由内部 registry 推断所有 API 都支持这种历史。[严格调用匹配](D:/ArkCode/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:482)、[历史原样传递](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js:110)

已有 UI 的 exploration 分组、bash 回执、折叠判定按小写名称分支，修改时要同时兼容 old history display 和新大写名，而执行 registry 只支持 canonical 六名。显示旧名字不等于给模型重新声明 aliases。[UI shell](D:/ArkCode/src/ui.ts:456)、[exploration](D:/ArkCode/src/ui.ts:472)、[历史折叠](D:/ArkCode/src/ui.ts:722)

## 5. 删除 ls 后的目录浏览与 Always Ask

当前 `find` 只收集普通文件，忽略符号链接，不返回空目录。仅改名为 `Glob` 不会补回 `ls` 能力，`Glob("*")` 也不是浅层目录列举。[collect/find](D:/ArkCode/src/tools.ts:283)、[ls](D:/ArkCode/src/tools.ts:277)

在六工具约束内有两种可行契约。

| 方式 | 行为 | 对 Always Ask 的影响 |
|---|---|---|
| Glob 保持文件查找，目录通过 Bash | 用真实 shell 的浅层列举命令；批量列出本轮所需的少量目录 | 每个新 Bash 命令由 host UI 审批；相同精确命令可用本会话授权，无需模型再问一遍 |
| Glob 同时支持 typed `list` 和 `search` | `list` 返回直接子条目及类型，`search` 按模式查文件；数量/depth/链接策略分别明确 | 同为 dedicated read-only 工具，可按 Kimi manual 的读取豁免直接执行；schema 更复杂，必须明确扩展语义 |

优先采用第一种，保持与 Kimi/MiniMax 的 Glob 职责一致。低摩擦来自浅层初始目录概览、聚合一次必要的列举，以及 host 审批中的精确会话授权，而不是悄悄自动批准任意 Bash。当前 Ark session grant 绑定工具名、cwd 和完整 description，command 或参数变化会重新询问；采用新 policyVersion 后还应绑定该版本。[现有 grant](D:/ArkCode/src/approval.ts:17)

Always Ask 按 Kimi 风格仍可以豁免 `Read/Grep/Glob`，不等于每个工具调用都弹窗。Bash 可以读写、启动进程、执行替换和重定向，不能把名字中出现 `ls`、`Get-ChildItem` 或 `find` 当成完整只读证明。若后续目标要求目录列举绝不弹窗，应选择上表第二种受控专用参数，或独立做经过解析的命令政策；不要用字符串前缀白名单制造隐式审批绕过。[Kimi 风格边界](D:/ArkCode/research/prompt-tools/kimi-permission-followup.md)、[前一审批方案](D:/ArkCode/research/prompt-tools/feasibility-plan.md:139)

具体 shell 由 host 提供：Windows 默认 PowerShell，Unix 当前 `/bin/sh`。拟议 Bash description 应继续注明真实 executable。目录命令应只返回相关路径和类型，并设置结果截断信息，避免递归完整树占用上下文；无 sandbox 不影响这种输出约束。[ManagedShell](D:/ArkCode/src/tools.ts:44)、[当前 Bash description](D:/ArkCode/src/tools.ts:331)

## 6. 实现前需要确定的接口

- 工具名使用 canonical 六名贯穿注册、policy、UI 和新历史；旧历史保留原文，显示层兼容旧名。
- AGENTS 的重新读取与 system section 更新形成一个边界操作；snapshot 重插不称为 refresh。
- 日期从 host 查询，初始化/恢复/跨日/压缩后补事实；审批模式与 policyVersion 只保存在宿主，不发给模型。执行限制影响任务时只报告一次实际事实。
- 适配 Pi 文件追踪；未来 skills section 不依赖小写 read/bash 的内置门控。
- Glob 是否只查文件需要明确。本报告推荐只查文件，必要目录浏览使用 Bash 的审批 UI。

以上是分析与拟议接入点，本轮未实施。父报告可据此更新旧“保留七个”的建议，用户已选择六个，差异应体现在目录浏览契约与 Pi 兼容适配中。
