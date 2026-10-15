# 工具调用模式与会话配置

更新于 2026-10-16。实现使用 Pi SDK 1.2.0 官方 CodeMode、工具搜索、MCP 扩展和工具调度。

## 配置与命令

用户 `settings.json` 的 `toolMode` 默认为 `codemode`。`/tool-mode` 打开临时菜单，仅在该菜单显示 Current 和有差异时的 Pending。支持 `/tool-mode direct`、`/tool-mode codemode`、`/tool-mode codemode-only`。命令与菜单不写入聊天、模型上下文或输入历史，不增加底栏字段。

| 模式 | 六个基础工具直接声明 | 脚本调用 | Pi exposure |
| --- | --- | --- | --- |
| direct | 是 | 否 | model-only |
| codemode | 是 | 是 | direct |
| codemode-only | 否 | 是 | codemode，保持未激活 |

范围由 `TOOL_NAMES` 定义。MCP exposure 独立配置，因此基础工具 only 不代表整个会话只有一个入口。保留官方 CodeMode `on`，不使用会同时隐藏 MCP direct 工具的全局 `only`。官方 `tool_search` 的候选访问器排除基础工具，避免搜索绕过 only。CodeMode 和工具搜索只按当前策略需要启用。

## 生效边界

| 操作 | 策略来源 |
| --- | --- |
| 新会话、/new | 最新配置 |
| 当前对话、resume | 当前分支快照 |
| fork | fork 起点的快照 |
| 手动／自动 compact 成功 | 最新配置，同时更新基础工具与 MCP exposure |
| compact 失败／取消 | 旧快照 |
| reload／reconnect／enable | 保留当前会话 exposure |
| disable、配置删除、工具过滤 | 立即阻止实际执行 |

`SessionToolSettings` 保存带版本号的 `arkcode-tool-settings` custom entry。快照只有基础工具模式、按 scope／规范化来源路径／服务器名定位的 exposure 和逐工具覆盖，不复制凭据、请求头、启动命令或完整配置 fingerprint。读取当前分支，不从会话文件任意取最后一项。旧会话缺少快照时基础工具使用原有 hybrid 行为，MCP 使用当前可信配置完成一次初始化。

`session_compact` 是可等待的扩展事件，早于下一次模型请求。事件中更新注册、按需要重载 MCP 并保存快照。请求准备检查应用失败状态，阻止使用不完整策略发出请求。若进程在 compact 写入后、策略快照写入前终止，恢复时识别该 compact 并完成边界初始化。Pi JSONL 没有跨条目事务或 fsync 保证。

## MCP 运行时目录

模式策略不冻结真实 schema。deferred 搜索可在会话内加载工具，服务端目录通知可增加、撤销和更新工具。SDK 保持对应路由与 schema 校验，撤销工具重新注册为 hidden；宿主追加隐藏的不可用通知。模型再次调用旧名称时也不能执行。

模式变更只保存配置，重连时合并快照。新配置服务器在既有会话中使用 hidden exposure，下一次成功 compact 或新会话再按最新配置暴露。连接、凭据、信任和实际启停状态不从快照恢复；审批前后重新检查 enabled、过滤和配置删除，拒绝被撤销的调用。

协议序列化复用 Pi：模型明确支持时追加工具声明，否则更新顶层工具列表。当前 Responses／Chat Completions 的增量路径遇到移除或同名重定义会回退完整列表，不人为保留可调用的旧定义。工具停用通知不能代替执行层拒绝。当前 DeepSeek Flash 的 Pi API 为 `openai-completions`，未开启中途工具追加能力。不承诺缓存始终命中。

## 并行与权限

六个基础工具移除 ArkCode 的 sequential 覆盖，沿用 SDK 默认并行调度。Write/Edit 使用 SDK 共享的同文件修改队列，不同文件可以并行。自定义 Write 的旧内容读取、写入和 diff 均在 SDK 队列内执行。Bash 不受该文件队列保护，有依赖或冲突的操作仍需顺序调用。MCP 保留官方执行策略。

`ApprovalBroker` 将需要人工审批的请求排队，界面只展示一个。批准后调用可以并行执行。取消使当前和排队请求所属 generation 失效，忽略迟到授权；session 授权只对相同操作有效。direct 和 CodeMode 子调用复用同一执行入口，权限规则不因工具模式改变。

## 验证

回归使用真实 Pi SDK、本地模型协议服务、HTTP／stdio MCP 和文件／进程效果，不依赖远程模型。覆盖三模式调用范围、搜索不可绕过 only、并行 shell、审批取消、pending 在 resume／fork 中保留、手动／自动 compact 应用、失败 compact、分支快照、缺失 compact 后快照恢复、MCP 目录撤销及审批期间禁用／过滤／删除。

协议检查覆盖普通顶层工具列表及支持增量扩展的 Chat Completions 请求。Responses 和 Anthropic 的序列化继续由 SDK 实现；没有宣称对远程供应商缓存命中率作过实测。
