# ArkCode

ArkCode 是基于 Pi SDK 的终端编码 agent。模型调用、工具循环、会话历史和上下文压缩由 Pi 管理。ArkCode 提供原生 TUI、工具审批、受管命令、输入队列、会话恢复和 Git 分支状态。

## 启动

需要 Node.js 22.19 或更新版本。Windows 使用 PowerShell，macOS 和 Linux 使用 `/bin/sh`。Git 用于显示当前分支。

```powershell
npm install
npm run build
npm start
```

在开发时运行 `npm run dev`。需要直接使用 `arkcode` 命令时，执行 `npm link`。

```powershell
arkcode -C "D:\my-project" --model openai/gpt-4.1
arkcode "Inspect this project and fix the failing test"
arkcode resume --last
arkcode resume <session-id>
arkcode fork <session-id>
```

首次打开目录时选择是否信任。信任后加载该目录及祖先目录的 `AGENTS.md` 文本。ArkCode 不加载项目扩展、插件或 `.pi` 设置。

## 配置模型

在 TUI 中使用 `/connect` 选择 Pi 内置供应商和模型。Pi 提供模型的图片能力、上下文长度等元数据。可在 TUI 中输入 API key，密钥由 Pi 保存到 `auth.json`，也可以通过供应商环境变量提供密钥。

```powershell
$env:OPENAI_API_KEY = "your-key"
arkcode config --provider openai --model gpt-4.1
```

自定义端点需要明确指定协议和模型能力。支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
Anthropic Messages 的 base URL 使用 API 根地址，Pi 会追加 `/v1/messages`。

```powershell
arkcode config --provider local --model my-model --base-url http://localhost:1234/v1 --api openai-completions --context-window 32768 --max-tokens 4096 --input text --reasoning false --api-key-env LOCAL_API_KEY
arkcode models
arkcode --model local/my-model
```

`/connect` 可以使用现有凭据、环境变量，或输入隐藏显示的 API key。`/model` 选择模型及推理等级。默认配置目录为 `~/.arkcode`，可用 `ARKCODE_HOME` 或 `--home` 指定。
首次交互启动会要求从可用模型中选择一个，并保存为默认模型。`--print` 模式需要 `--model` 或已保存的默认模型。

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 默认模型、推理等级、权限、可信目录 |
| `models.json` | Pi 格式的模型及端点配置 |
| `auth.json` | Pi 的凭据存储 |
| `sessions/` | Pi JSONL 历史，按真实工作区分组 |
| `runs/` | 运行结束与中断标记，不保存第二份对话 |

自定义模型配置遵循 [Pi models 文档](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/models.md)。模型配置属于用户可信配置，Pi 支持的凭据命令也可以执行。

## 权限

本版没有 OS sandbox，`--sandbox` 只接受 `none`。

| 模式 | 实际行为 |
| --- | --- |
| Read Only | 仅暴露 read、find、grep、ls，无 shell 或写工具 |
| Ask for approval | 每次文件写入、编辑或 shell 命令都需要批准 |
| Full Access | 使用当前用户的 OS 权限执行，不等待工具审批 |

未信任目录默认 Read Only。可通过 `/permissions` 或 `--permissions read-only/ask/full-access` 选择。会话授权绑定完整工具参数和目录。停止、切换权限或切换会话撤销旧审批。文件工具限制在工作区，禁止访问 `.git`、`.arkcode`，拒绝 symlink 越界及读取 `.env`。这不是 OS 隔离；批准的 shell 可以使用当前用户权限访问其他路径。

同一真实工作区只有一个 writer。第二个宿主进入 Read-only viewer，不能运行 agent 或修改历史。历史恢复不重放工具、草稿或队列；中断不会回滚文件。上一宿主在执行期间崩溃时，恢复显示 Execution unconfirmed，需要检查现有文件和残留命令。

强制结束宿主不能保证所有子进程已退出。启动时发现该配置目录下的 active 运行标记后，工作区保持 Read Only，新会话也不能绕过。确认旧命令已结束后，才能手动将对应 `runs/` 标记改为 `interrupted`，补上 `endedAt` 时间戳并去掉 `pid`，然后重启。不同 `--home` 共享 writer 锁，但不共享运行标记；不要用换配置目录绕过恢复检查。

首次执行还未创建会话历史时，带工作区路径的运行标记也会触发上述保护。如果宿主在创建或回收 writer 锁时崩溃，CLI 可能保持 viewer。启动消息给出残留锁文件的完整路径。确认没有进程持有或正在恢复该工作区后，才能手动清理残留锁文件。程序不自动清理无法确认归属的锁。

## 操作

Enter 发送任务。运行时 Enter 提交 steer，在当前工具完成后交付；Tab 排队下一轮。Ctrl+J 或支持该键位的终端中的 Shift+Enter 换行。粘贴不会发送任务或批准工具。输入 `@` 自动列出当前工作区的文件和目录，Tab 补全所选路径；`@path` 和 `@"path with spaces"` 添加文件内容，单个文件最多 128 KiB。

`!command` 执行用户命令，经过相同权限检查，结果加入会话。运行中提交 `!command` 会排队到当前模型循环结束。

| 入口 | 行为 |
| --- | --- |
| `/help` | 命令与快捷键 |
| `/model`、`/connect` | 模型选择、端点配置 |
| `/permissions`、`/status` | 权限与实际运行配置 |
| `/new` | 新会话，保留旧历史和工作区文件 |
| `/resume`、`/resume <id>`、`/rename`、`/fork [id]` | 打开会话列表、按当前项目 ID 恢复、重命名、分支 |
| `/compact` | Pi 上下文压缩，保留原始历史 |
| `/copy`、`/init` | 复制完整回答、生成 AGENTS.md |
| `/exit` | 停止执行并退出 |

TUI 遵循原生设计 demo 的 `prism/instrument-deepfield`，使用固定 Prism 配色、完整输入框和六字段底栏。底栏依次显示模型、推理等级、目录、权限、Git 分支和上下文用量。审批与选择面板替换输入框，关闭后恢复草稿。工具显示实际目标与执行状态，默认预览最多三行终端输出，失败命令保留退出码。模型提供的推理内容默认收起。

空闲且输入框为空时按左方向键，或输入 `/resume`，打开跨项目会话列表。Tab/Shift+Tab 切换状态筛选，`g` 按项目或状态分组，`/` 搜索，方向键与 PgUp/PgDn 移动，Enter 打开，`n` 在选中项目新建，Esc 返回。宽终端显示会话详情，窄终端显示单列。恢复会话时显示当前分支的完整历史，包括压缩前的消息。列表只把当前进程中实际运行的会话标为 Working 或 Needs you；历史会话标为 Inactive，未确认的运行标记为 Unconfirmed。切换到未信任项目时需要重新选择信任级别，原项目的权限不会自动延续。打开失败会保留原会话与草稿。

旧 `settings.json` 中的 `theme` 和 `statusline` 可读取，下一次保存时移除。文件差异可在 IDE 或外部 Git 工具中查看。代码审查可直接作为普通任务提交。

Esc 中断 agent；面板中的 Esc 返回。Ctrl+C 运行时中断，空闲时退出。Ctrl+D 在空输入区退出。Ctrl+T 展开工具转录及模型提供的推理内容，Ctrl+O 复制最近完整回答，Ctrl+R 搜索提示历史，Ctrl+G 使用 `VISUAL` 或 `EDITOR` 编辑草稿。Ctrl+L 仅清理视图。Shift+Left 编辑未消费队列输入。空输入区双 Esc 编辑上一条提示并创建分支，不回滚文件。

Goal、多代理、MCP、插件、持久 Plan、学习式记忆、云执行和媒体输入后置。已知后置 slash 命令显示不可用，未知命令不会发送给模型。

## 单轮与验证

```powershell
arkcode --print --read-only "Explain this project"
arkcode --json --permissions ask --approve "Fix the test and run it"
npm run check
npm test
```

非交互模式默认拒绝需要审批的动作。`--approve` 显式批准这些动作；`--full-access` 使用完整权限。JSON 输出包含模型流、工具事件、审批和最终运行状态。

测试使用本地 OpenAI 兼容服务驱动真实 Pi SDK，并执行真实文件操作、Git 和本机 shell。真实 DeepSeek 调试另见 [验收记录](docs/implementation/VERIFICATION.md)。Windows 已验证子进程树取消；macOS/Linux 实机、不同终端的中文 IME、系统剪贴板和外部编辑器尚未完整验收。
