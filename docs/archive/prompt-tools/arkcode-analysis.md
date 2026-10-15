# Ark Code 提示词与工具现状

分析日期：2026-10-11。对象：Ark Code 0.1.0，HEAD `820fbceb384d947e4a592728c2e7458e92e909bf`；实际安装的 `@earendil-works/pi-coding-agent`、`pi-ai` 均为 1.1.0。本文只分析当前实现，不改运行代码、测试或配置。

## 1. 谁负责构造请求

Ark Code 提供资源加载器、用户输入处理、工具实现、权限与 TUI。Pi 负责模型协议适配、agent 循环、工具调用、会话树、历史恢复和压缩。这种分工见 [README](D:/ArkCode/README.md:3)、[会话初始化](D:/ArkCode/src/runtime.ts:187)、[Pi SDK](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:253)。

构造链路：

```text
settings / CLI 参数 / 工作区信任 / writer 状态
  → ArkHost.replaceSession
  → createResources + createTools
  → createAgentSession
  → Pi 注册并覆盖同名工具，应用工具白名单
  → buildSystemPromptSections
  → system section patch + tool declarations + 当前分支历史
  → convertToLlm
  → 所选 provider 转成 API messages / input / tools
  → 模型 → tool call → Ark 权限与执行 → tool result → 下一次请求
```

这里的 system、tool、skill 是不同对象。system 规定行为；tool 包含模型可调用的名称、描述、参数 schema 和执行器；skill 是额外工作说明，通常在命中后再读取内容。当前 Ark Code 有 system 和 tools，资源加载器返回的 skills 始终为空。

## 2. 完整基础 system prompt

原文位于 [config.ts:238](D:/ArkCode/src/config.ts:238)。

```text
You are ArkCode, a terminal coding agent. Inspect the project before making changes. Follow project instructions. Keep changes focused, verify the result, and report what changed and what was checked. Never claim a command succeeded without its result. Tool permissions are enforced by the host. Do not bypass a denied tool action.
```

内容对应：终端编码身份；修改前调查项目；遵守项目指令；保持改动集中；验证和说明改动及检查；没有命令结果不得声称成功；权限由宿主执行；不得绕过已拒绝动作。

它没有显式规定中文回复、计划更新、长任务进度、优先使用哪些工具、测试选择、Git 操作、当前时间、操作系统、上下文不足时如何处理，也没有按模型选择不同模板。工具 schema 和项目 AGENTS 文本可能补充这些信息，但基础 prompt 自身没有。

### 实际最终 system

当前 `D:\ArkCode` 及 `D:\` 均无 `AGENTS.md`。在无项目指令、无 skill 的默认构造下，实际文本是基础 prompt 加上：

```xml
<cwd>
D:/ArkCode
</cwd>
```

完整输出已保存在 [arkcode-system-default.txt](D:/ArkCode/docs/archive/prompt-tools/arkcode-system-default.txt)。它由当前安装的 Pi `buildSystemPrompt` 直接生成，而非手写模拟。

关键分支见 [Pi system-prompt.js:78](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:78)：有 `customPrompt` 时只设置 preamble；默认 `tools`、`rules`、`docs` 三段位于 `else` 中，所以不会加入 Ark Code 的 system。其后仍会追加 addendum、project_context、skills、cwd 中满足条件的部分。

因此，Ark 工具的 `promptSnippet: description` 虽被注册收集，却不会在当前自定义 system 下自动形成工具说明段。描述和参数仍通过 API tools 传给模型。Ark 的自定义工具也没有 `promptGuidelines`，Pi 同名内置工具原有的指南不会自动合并。见 [Ark 工具定义](D:/ArkCode/src/tools.ts:216)、[Pi 同名定义覆盖](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2831)。

### 可信项目指令

[readInstructions](D:/ArkCode/src/config.ts:206) 从盘符根目录向当前 cwd 依次读取祖先目录和 cwd 的 `AGENTS.md`。单文件最多 64 KiB，总计 128 KiB，超长时带截断提示。只有 trusted 才读取；`CLAUDE.md`、`AGENTS.override.md`、当前 cwd 下面尚未访问的子目录指令不在这个扫描器中。

Pi 用以下格式放进 system 的 `project_context` 段，见 [renderProjectContext](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:25)：

```xml
<project_context>
Project-specific instructions and guidelines:

<project_instructions path="D:\project\AGENTS.md">
实际文件内容
</project_instructions>
</project_context>
```

上面是格式示例，不是当前项目的实际指令。祖先先读，近目录后读，但加载器没有单独编写近目录覆盖远目录的冲突规则。祖先也可能先耗尽总字节预算。

资源加载器提供 `reload()`，但 Ark Host 当前没有调用 session 资源重载的入口。AGENTS 是创建资源加载器时读取的快照；在本轮工具写入或修改 AGENTS 后，不应假定下次模型请求已自动刷新。新建或重新打开会话会重新创建资源。见 [createResources](D:/ArkCode/src/config.ts:235)、[replaceSession](D:/ArkCode/src/runtime.ts:195)。

### skill、模板、扩展

[createResources](D:/ArkCode/src/config.ts:239) 明确返回空 extensions、skills、prompts、themes，以及空 appendSystemPrompt。Ark 使用自定义 ResourceLoader 和 in-memory SettingsManager，绕过 Pi 的 DefaultResourceLoader、项目 `.pi` 设置和默认资源发现。Pi 支持 skill/MCP/扩展，并不表示 Ark 已启用。见 [SDK 默认加载器分支](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:78)。

当前无技能目录摘要、SKILL.md 按需读取流程、`/skill` 路由、MCP 工具发现、插件 prompt 注入。`goal/agent/mcp/plugins/memories/plan/cloud` 是显式后置功能。模型仍可以自然语言列计划，但没有相应持久状态工具。见 [unsupported](D:/ArkCode/src/runtime.ts:29)。

## 3. 用户 prompt、历史和压缩

| 内容 | 实际构造 | 来源 |
| --- | --- | --- |
| 普通输入 | trim 后经 prepareMentions，调用 `session.prompt(text, { images })` | [runtime.ts:320](D:/ArkCode/src/runtime.ts:320)、[runtime.ts:366](D:/ArkCode/src/runtime.ts:366) |
| 运行中 Enter | 交付 `session.steer` | [runtime.ts:336](D:/ArkCode/src/runtime.ts:336) |
| 运行中 Tab | 交付 `session.followUp` | 同上 |
| slash 命令 | Ark Host 自己路由，通常不发给模型 | [runtime.ts:325](D:/ArkCode/src/runtime.ts:325) |
| `/init` | 发送专用用户 prompt，要求基于实际构建、测试、风格创建简洁 AGENTS，不修改其他文件 | [runtime.ts:623](D:/ArkCode/src/runtime.ts:623) |
| `!command` | 宿主执行；结果用 custom message 加入历史，下一次请求转成 user 消息；不立刻触发模型轮次 | [runtime.ts:401](D:/ArkCode/src/runtime.ts:401)、[Pi messages.js:89](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js:89) |
| 工具结果 | 正常 toolResult，而非拼入基础 system | [工具 result](D:/ArkCode/src/tools.ts:207)、[Pi messages.js:114](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js:114) |
| 会话恢复 | Pi 当前分支历史重新构造上下文；不是重放工具 | [README](D:/ArkCode/README.md:68)、[SDK 恢复上下文](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:84) |
| `/compact` | `session.compact(argument)`，argument 作为额外压缩指令 | [runtime.ts:619](D:/ArkCode/src/runtime.ts:619) |
| 自动压缩 | enabled=true，由 Pi 触发和保留近期消息；原始历史仍在会话树中 | [runtime.ts:192](D:/ArkCode/src/runtime.ts:192) |

### `@文件` 当前行为与文档不同

[prepareMentions](D:/ArkCode/src/mentions.ts:16) 最多处理 8 个引用。文本文件和目录只检查路径，原始 `@path` 文本保留，**没有把文本文件内容附加到 prompt**。图片则检测 MIME、必要时 BMP 转 PNG、缩放，然后以 image 内容送给支持图片的模型；不支持时拒绝。

README 仍说 `@path` 添加文件内容、单文件 128 KiB，并把媒体输入列为后置。这与现代码不一致。`7ae9bf1` 的提交主题为 `fix(cli): preserve mentions and image model capabilities`，当前分析以该实现为准。见 [README 操作说明](D:/ArkCode/README.md:75)、[mentions.ts](D:/ArkCode/src/mentions.ts:16)。

### 压缩使用另一套 system

Pi 的压缩 system 原文见 [utils.js:146](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js:146)：

```text
You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

摘要作为包裹于 `<summary>` 的 user 消息送回主循环。Pi 默认 `reserveTokens=16384`、`keepRecentTokens=20000`，Ark 只覆盖 enabled。压缩序列化工具结果时还有单结果 2000 字符的截断。这里的字节限制、字符限制和 token 预算不可混为一谈。见 [compaction.js:54](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:54)、[utils.js:81](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js:81)、[messages.js:103](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js:103)。

### 协议中的 role

Ark 的逻辑 system 不是保证在所有供应商中都叫 `system`。当前 Pi OpenAI Completions 与普通 Responses 适配器根据 `model.reasoning` 和 `supportsDeveloperRole` 选择 system 或 developer；Responses 转进 input/messages，Anthropic 则使用 system 和 tools 字段。OpenAI Codex 专用适配器另有 instructions 字段，此路径不能用来解释普通 OpenAI Responses，也不能代表参考仓库 Codex Rust 的请求构造。见 [Completions](D:/ArkCode/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:899)、[Responses](D:/ArkCode/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:125)、[Anthropic](D:/ArkCode/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:862)。

Pi 当前使用结构化 system sections 和工具增删声明，在请求前计算差异并写进 system message，再由供应商适配器投影为实际 API。不是每一轮简单拼一个完全独立的新字符串。见 [section patch](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1303)、[工具声明](D:/ArkCode/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:210)。

Git 分支、TUI 状态栏中的推理等级和权限、启动提示等显示信息没有自动全部变成模型上下文；不要把 UI 上看到的信息视作模型已收到。

## 4. 全部模型工具

7 个工具全部由 [createTools](D:/ArkCode/src/tools.ts:223) 创建，返回列表见 [tools.ts:346](D:/ArkCode/src/tools.ts:346)。同名覆盖 Pi 内置实现。完整机器可读 schema 已保存为 [arkcode-tools.json](D:/ArkCode/docs/archive/prompt-tools/arkcode-tools.json)。

| 名称 | 参数 | 行为和边界 | 权限 |
| --- | --- | --- | --- |
| `read` | `path`；可选 `offset`、`limit` | 文本文件；1-based offset；默认 500 行，limit 最大 2000；带行号和续读提示；文件最大 2 MiB；输出最大 128 KiB | 三模式可用 |
| `grep` | `pattern`；可选 `path`、`ignoreCase` | JS RegExp 搜索，返回文件与行号；最多 500 匹配或到输出字节预算；最多遍历 10000 文件 | 三模式可用 |
| `find` | `pattern`；可选 `path` | minimatch glob；返回工作区相对路径；最多 500 结果、遍历最多 10000 文件 | 三模式可用 |
| `ls` | 可选 `path` | 列目录，默认 cwd；最多 1000 项；标注目录和 symlink | 三模式可用 |
| `write` | `path`、`content` | 创建或覆盖 UTF-8 文本；自动建父目录；最大 2 MiB；整文件写入 | Ask 审批，Full Access 自动 |
| `edit` | `path`、`oldText`、`newText` | 精确替换唯一匹配；oldText 非空；零匹配或多匹配拒绝；不是 patch 或 replace-all | Ask 审批，Full Access 自动 |
| `bash` | `command`；可选 `timeout` | 原生 shell；Windows 为 powershell.exe，其他为 /bin/sh；可选超时 1–600 秒；未提供则无该超时计时器；返回状态、exit code、截断信息 | Ask 审批，Full Access 自动 |

名称为 `bash`，不代表 Windows 实际运行 Bash。工具描述会把实际 shell 名放进 schema。工具未提供 cwd 参数，使用当前工作区 cwd；shell 的 OS 文件访问能力不限于该目录。

### 文件和输出约束

文件工具限制真实工作区内路径，拒绝 symlink 越界，保护 `.git`、`.arkcode`，读取时拒绝 `.env` 和 `.env.*`，但直接读取 `.env.example` 允许。find/grep 的目录遍历更粗，跳过所有 `.env` 开头项、symlink、node_modules、`.git`、`.arkcode`。见 [workspacePath](D:/ArkCode/src/tools.ts:161)、[collect](D:/ArkCode/src/tools.ts:283)。

这些搜索不是 ripgrep，也没有读取 `.gitignore` 的通用忽略语义；`dist`、构建缓存等不在固定跳过集合中。指定路径查找时，glob 匹配针对工作区相对路径。shell 不受同一文件路径限制，当前项目明确没有 OS sandbox。见 [README 权限](D:/ArkCode/README.md:54)。

输出移除终端控制字符。shell 输出保存在受管 receipt，累计预算 128 KiB，超出截断；本实现没有另一个模型工具读取完整溢出日志。所有工具声明 `executionMode: "sequential"`，包括只读搜索。见 [cleanOutput](D:/ArkCode/src/tools.ts:14)、[shell output](D:/ArkCode/src/tools.ts:81)、[define](D:/ArkCode/src/tools.ts:216)。

输出预算并非所有工具统一执行。`grep` 先放入完整匹配行，再检查累计字节，因此 128 KiB 是停止阈值，不是硬输出上限；一个很长的匹配行就可能远超阈值。`find` 和 `ls` 只有条数上限，没有该字节截断。`read` 虽截断正文，但续读 offset 仍按原先选中的行数生成，可能跳过被字节截断而没有返回的内容；单条超长行也没有列偏移续读。见 [grep 累计顺序](D:/ArkCode/src/tools.ts:323)、[read 续读计算](D:/ArkCode/src/tools.ts:243)。这些是当前输出恢复能力的实际边界，尚未修改。

### 权限、可见性与执行是两道检查

正常创建时，Read Only 暴露 `read/grep/find/ls`，Ask 与 Full Access 暴露全部 7 项；Ask 每次写、编辑、shell 都通过 ApprovalBroker。session 许可按工具、cwd 和完整参数说明计算摘要；换会话、停止或换权限时撤销旧许可。见 [runtime.ts:196](D:/ArkCode/src/runtime.ts:196)、[approval.ts:13](D:/ArkCode/src/approval.ts:13)。

writer viewer 不能运行 agent，不能修改会话；虽然会话对象中可以有只读 loadout，但不是可用的第二个只读 agent。见 [runtime.ts:326](D:/ArkCode/src/runtime.ts:326)。

### 已确认的权限切换问题

以 Read Only 创建会话时，`tools: readTools` 在 Pi 中同时变成 allowedToolNames。Pi 在注册时把 write/edit/bash 过滤掉。`/permissions ask` 或 `/permissions full-access` 后只调用 `setActiveToolsByName`，无法恢复这些未注册工具。

用真实安装的 Pi SDK 创建了两个 in-memory 会话，没有发模型请求，也没有执行工具，结果保存在 [arkcode-sdk-inspection.json](D:/ArkCode/docs/archive/prompt-tools/arkcode-sdk-inspection.json)：

| 创建时 loadout | 请求激活全部 7 项之后 | 结果 |
| --- | --- | --- |
| 4 项只读 | `read, grep, find, ls` | 仍然只有 4 项 |
| 全部 7 项 | 全部 7 项 | 正常 |

链路证据：[Ark 初始 tools 参数](D:/ArkCode/src/runtime.ts:196) → [SDK 将参数变成注册白名单](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:153) → [customTools 注册过滤](D:/ArkCode/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2821) → [切换仅激活](D:/ArkCode/src/runtime.ts:603)。在以新权限重新创建会话后才会有完整注册集。此次只记录，不修复。

## 5. 工具之外的用户入口

`!command` 是用户 shell 入口；`/compact`、`/init`、`/new`、`/resume`、`/fork`、`/model`、`/permissions` 是宿主命令。它们没有对应的同名模型 function schema，不能算进“模型可用工具”。Git 分支显示也只是宿主调用 Git。当前没有默认 web_search、fetch_url、apply_patch、后台进程管理、PTY stdin、todo/plan、ask_user、goal、subagent、MCP、skill、image-reader 等模型工具。Full Access 下 shell 可自行运行 curl/git 等程序，但这不等于项目提供了这些专门工具。

## 6. 为什么呈现这样的设计

直接证据：README 和实施计划把项目定位为“聚焦的 Pi 终端编码 agent”，明确把模型循环和会话树交给 Pi，后置其他能力，并要求真实命令回执、权限审批、进程中断和历史恢复。见 [实施定义](D:/ArkCode/docs/implementation/PLAN.md:11)、[权限约定](D:/ArkCode/docs/implementation/PLAN.md:31)。

从实现可推导的效果：

- 专用 read/find/grep/ls 让只读模式仍能调查代码；若只保留 shell 就无法在当前“shell 整体禁用”的只读策略下查询。这是工具拆分的直接运行效果。
- write 与精确唯一 edit 分离，既支持新文件，又把局部修改的歧义变成显式错误。相比批量 patch，表达多文件修改更啰嗦。
- shell 兜底覆盖构建、测试和 Git 等任务，减少专用工具数量；与此同时，可见性、取消、审批和 OS 访问都要在宿主管理。
- 工具输出限制控制上下文大小，但硬截断可能丢失错误尾部或关键文件；搜索数量限制也不等于搜索完整。
- 串行执行简化审批与共享文件操作的时序，但也串行化了独立只读操作。
- 固定的短 system 更容易审查，且适配多个供应商；当前缺少模型差异、任务模式和工具工作规则。

这些是工程效果与权衡分析，不能据此宣称作者当初选择每个数字或命名的真实动机。当前 git 记录和文档没有逐项说明 2 MiB、128 KiB、10000、500 等阈值的历史理由。

## 7. 下一阶段值得讨论的事项

1. 先澄清真实能力与文档，尤其 `@文本/图片` 和工具权限切换，同时检查被截断输出是否仍能完整恢复。
2. 让模型上下文中的运行环境、模式和实际工具 loadout 可检查；定义哪些信息属于稳定基础、项目指令、每轮动态上下文。
3. 审视自定义 system 覆盖掉 Pi 默认工具规则后的空缺；不要误以为添加 promptSnippet 已生效。
4. 明确祖先/子目录 AGENTS 的优先级与刷新时机，再设计 skill。skill 内容、目录摘要与执行工具要分别建模。
5. 按用户需求选择工具扩展：搜索过滤和输出续读、受管后台进程、提问与计划、网络查询、多代理。参考项目工具多并不构成全部照搬的理由。

本文不提出已经实施的改动，也不把参考项目的能力当作 Ark Code 当前能力。
