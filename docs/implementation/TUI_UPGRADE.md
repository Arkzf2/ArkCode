# TUI rendering upgrade

2026-10-15，Windows，Node 24.18.0，Pi SDK 1.2.0。

## 已实现

- 工具调用改用亮绿色实心圆点，失败使用红色。命令按程序名、参数、字符串、变量、路径和操作符分色。中间说明与助手回答使用正常文字亮度，普通工具输出统一为灰色。只有真实文件 diff 使用增删色，避免把输出中的 `+`、`-`、`PASS` 误当作变更。
- 默认预览三行工具输出，点击 `+N lines` 展开当前工具，点击 `Show less` 收起。Ctrl+T 控制全部工具及推理详情，Esc 退出展开状态。相邻文件查询分别保留结果，使每个工具都能独立查看。
- Edit 透传 SDK 已有的编号 diff；Write 在 SDK 文件写入队列内取得实际写入前后的文本并计算 diff。显示增删统计、行号及八行预览，长行按终端单元格宽度换行。Write 的预览限于新旧文本合计不超过 256 KiB，超限仍正常写入并显示执行结果。会话恢复继续展示已保存的 diff。
- 底栏模型名称隐藏供应商前缀。上下文使用 SDK 的当前模型窗口和 token 估算，靠右显示已用/总量、百分比及宽度允许时的进度条，不显示 `Context` 标签和剩余量。70% 提示、90% 红色。点击显示完整数字；压缩后未知用量显示 `?`，模型切换后使用新窗口。JSON status 的 `context` 改为结构化 `{ tokens, contextWindow, percent }`，不可用时为 `null`。
- 消息、运行状态和工具统一使用同尺寸的实心圆点。`/permissions` 保存选择的权限模式，重启后恢复；显式 CLI 参数可覆盖当次权限，未信任目录仍默认 Always Ask。
- 滚轮、PgUp/PgDn 浏览历史，End 返回最新内容。鼠标命中按 SDK 的实际 viewport 映射，支持窗口缩放。退出和启动外部编辑器时关闭鼠标报告。按住 Shift 可使用终端文字选择。

## 参考与取舍

参考本机 `E:/Github Programs/codex/codex-rs/tui/src/exec_cell/render.rs`、`render/highlight.rs`、`bottom_pane/footer.rs`，以及 `E:/Github Programs/kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts`、`chrome/footer.ts`。沿用 ArkCode 的 Pi 组件和 Prism 输入框，借鉴命令高亮、输出预览、编号 diff 和带 token 数字的上下文读数。

保留 Ctrl+T 的键盘入口。普通工具结果按灰色文本输出，文件变更使用 SDK 的真实 diff，不根据输出文本猜测 diff。上下文估算以 `~` 明示，完整数字在详情页显示。

## 验证

`npm run check`、`npm run build`、`npm test` 均通过，全量测试 178 项。补充验证三种权限模式从其他模式切换后保存、重启恢复、CLI 当次覆盖，以及 40/80/120 列底栏右对齐和点击详情。

新增 `@xterm/headless` 开发依赖，在真实 ANSI 终端缓冲区中检查颜色、单条展开/收起、全局展开、缩放后的点击、中文换行、历史滚动、上下文详情、模型窗口及用量提示。集成测试使用本地模型服务驱动真实 Pi SDK，覆盖 Write/Edit diff、会话恢复和模型切换。

首次不限并发的全量测试触发两个 POSIX shell 检查进程的 1 秒启动超时，单独复跑与串行全量 173 项测试均通过。测试命令改为最多 4 个测试文件并行，保留生产解析器的原有超时。

以下图片由运行中的终端缓冲区单元格导出，内容为演示场景，不是实时模型任务的日志。

- [默认预览](assets/tui-compact.png)
- [单条展开](assets/tui-expanded.png)
- [上下文详情](assets/tui-context.png)

Windows 原生终端、SSH、tmux 的实机组合尚未逐一验收；不支持 SGR 鼠标的终端可继续使用 Ctrl+T 和 PgUp/PgDn。

## 后续建议

- Read 显示代码行号与语言高亮，Grep 按文件组织匹配项；批量读取可用可展开的文件分组，同时保留进入单条结果的入口。
- 长工具输出增加单独查看和复制入口；MCP 的结构化结果可按 JSON 树或表格展示，并保留原始文本入口。

这两项需要按工具的结果类型设计交互，未混入本轮通用渲染改动。
