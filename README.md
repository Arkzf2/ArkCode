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

首次打开目录时选择是否信任。全局配置目录的 `AGENTS.md` 始终加载；信任后加载 Git 根到 workspace 的祖先规则，以及 workspace 内递归发现的 `AGENTS.md`，并允许项目 MCP 配置连接服务器和启动本地进程。没有 Git 根时只加载 workspace 及其子目录。ArkCode 不加载项目扩展、插件或 `.pi` 设置。

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
| `settings.json` | 默认模型、推理等级、权限、可信目录、项目指令总字节预算 |
| `AGENTS.md` | 全局工作规则，不受项目目录信任状态影响 |
| `models.json` | Pi 格式的模型及端点配置 |
| `auth.json` | Pi 的凭据存储 |
| `mcp.json` | 用户级 MCP 服务器、工具过滤及自动批准规则 |
| `mcp-auth.json`、`mcp.log` | MCP OAuth 凭据及服务日志，随 `--home` 隔离 |
| `sessions/` | Pi JSONL 历史，按真实工作区分组 |
| `runs/` | 运行结束与中断标记，不保存第二份对话 |

自定义模型配置遵循 [Pi models 文档](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/models.md)。模型配置属于用户可信配置，Pi 支持的凭据命令也可以执行。

## 权限

| 模式 | 实际行为 |
| --- | --- |
| Always Ask (`always-ask`) | 内建 Read/Grep/Glob、独立的 `ls` 及已获会话批准的相同操作自动允许；其余动作和 MCP 调用需要批准 |
| Ask When Needed (`ask-when-needed`) | 普通 Write/Edit/Bash 自动允许，高危命令询问；MCP 默认询问，用户级 `autoApproveTools` 中的工具可自动批准，服务标记为 destructive 的工具仍询问 |
| Never Ask (`never-ask`) | 使用当前用户的 OS 权限执行，内建工具和 MCP 不等待调用审批；仍遵守服务器启用状态、工具过滤、viewer 和恢复保护 |

六个内建工具 `Read`、`Write`、`Edit`、`Grep`、`Glob`、`Bash` 在所有模式中常驻。MCP 工具由已连接服务器的当前目录动态注册，名称为 `mcp__<server>__<tool>`，清洗或超长名称加 hash。权限切换不会改变工具 schema。原 `find` 改名为 `Glob`，原 `ls` 工具删除；目录列表使用 Bash。Windows 默认执行 PowerShell，因此 `Bash` 是工具名，实际 shell 由环境上下文提供。Always Ask 也允许独立的 `Get-ChildItem`；重定向、管道、命令替换和串联命令不属于列表豁免。

未信任目录跳过项目 AGENTS.md，保留全局规则，默认 Always Ask；显式 CLI 权限仍生效。可通过 `/permissions` 或 `--permissions always-ask/ask-when-needed/never-ask` 选择。旧 `ask`、`full-access` 和 `--full-access` 仍映射到相应新模式；旧 `read-only` 配置及 `--read-only` 会报错，要求明确选择新模式。

Ask When Needed 采用 Kimi 的普通动作自动批准、有限高危规则优先询问的机制。规则覆盖关机/重启、磁盘格式化、写入设备的 `dd`、递归强制删除等，并检查命令包装、命令替换与嵌套 shell。无通配、变量和 `..` 的 `/tmp`、`/temp` 删除目标有例外。PowerShell 使用原生 AST，增加对应 Windows 命令规则。POSIX 使用 `bash-parser` 在独立解析进程中检查；超时、解析失败及尚不支持的 heredoc 视为无法分析，在 Ask When Needed 中自动允许，在 Always Ask 中询问。它不检查任意脚本或所有副作用，例如 `git push`、`git reset --hard` 和 Python 脚本不会仅因该有限规则要求批准。

会话授权绑定完整工具参数、shell 和目录。停止、切换权限或切换会话撤销旧审批，恢复历史不会恢复批准记录；已知高危命令优先于会话授权，每次仍询问，Never Ask 跳过此检查。拒绝当前调用会返回工具错误，不创建持久黑名单。文件工具保留工作区、受保护路径、symlink 和文件大小限制。Bash 命令使用当前用户权限，并可访问工作区之外的路径。

MCP 会话授权还绑定原始 server/tool、配置来源、配置与 schema 指纹、连接身份及完整参数，不能沿用到重连后的同名服务。`readOnlyHint` 不自动授予权限；服务的 destructive 标记在两种询问模式中优先于自动批准和会话批准。MCP 的执行权限与工具是否暴露分别管理。外部服务不受 ArkCode 文件工具的工作区限制，MCP roots 也不是 OS 沙箱。

同一真实工作区只有一个 writer。第二个宿主进入 Read-only viewer，不能运行 agent 或修改历史。历史恢复不重放工具、草稿或队列；中断不会回滚文件。上一宿主在执行期间崩溃时，恢复显示 Execution unconfirmed，需要检查现有文件和残留命令。

强制结束宿主不能保证所有子进程已退出。启动时发现该配置目录下的 active 运行标记后，工作区限制为文件检查，新会话也不能绕过。工具仍常驻，写入和 shell 在执行入口拒绝；这是恢复状态，不是第四种权限模式。确认旧命令已结束后，才能手动将对应 `runs/` 标记改为 `interrupted`，补上 `endedAt` 时间戳并去掉 `pid`，然后重启。不同 `--home` 共享 writer 锁，但不共享运行标记；不要用换配置目录绕过恢复检查。

首次执行还未创建会话历史时，带工作区路径的运行标记也会触发上述保护。如果宿主在创建或回收 writer 锁时崩溃，CLI 可能保持 viewer。启动消息给出残留锁文件的完整路径。确认没有进程持有或正在恢复该工作区后，才能手动清理残留锁文件。程序不自动清理无法确认归属的锁。

## MCP

在用户配置目录创建 `mcp.json`，或在可信工作区创建 `.arkcode/mcp.json`。同名项目服务器完整覆盖用户配置，不继承用户自动批准规则。未信任工作区不加载项目 MCP；viewer、执行恢复未确认或历史写入失败时不启动新连接。连接本地服务本身会启动配置中的进程，调用审批发生在具体工具执行前。

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["D:/tools/my-mcp-server.mjs"],
      "enabledTools": ["read_*", "search_*"],
      "disabledTools": ["read_secret"],
      "autoApproveTools": ["read_public"]
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "MY_MCP_TOKEN"
    }
  }
}
```

将示例命令、路径和 URL 换成实际服务。支持 stdio 和 Streamable HTTP；`transport` 可省略，或明确填写 `stdio` / `http`。stdio 可设置 `cwd`、`env`，HTTP 可设置 `headers`、`bearerTokenEnvVar`。`env` 和 `headers` 中的 `${ENV_NAME}` 在连接时读取环境变量，缺失时报错。相对 stdio cwd 以当前工作区为基准。stdout 用于 MCP 协议，stdio stderr 由 transport 缓冲；连接失败时状态显示经过凭据脱敏的 stderr 尾部。

`enabled` 默认 true。`enabledTools` 省略时暴露全部工具，空数组表示不暴露；`disabledTools` 优先排除工具，二者按服务原始工具名称匹配，支持 glob。`autoApproveTools` 仅允许在用户级配置中设置，且只在 Ask When Needed 中使用。连接超时 `startupTimeoutMs` 默认 60000，最大 300000；调用超时 `toolTimeoutMs` 默认 30000，最大 300000。首次通过 npx/uvx 启动还包含包下载时间，网络较慢时可提高启动超时或预先安装包。npx 可使用 `-y` 避免安装确认，Pi transport 已处理 Windows `.cmd` 启动。

`/mcp` 打开临时管理子菜单，非交互模式输出状态。工具列表可滚动，Esc 或 Ctrl+C 逐级返回并保留原选择；关闭后恢复聊天与草稿，查询内容不进入 TUI 消息、输入历史或 session。底部只显示简短操作提示，配置路径与完整命令说明通过 Help 或 `/mcp help` 查看。connected 状态为绿色，disconnected 为淡灰色。支持 `/mcp status`、`/mcp tools <server>`、`/mcp reload`、`/mcp reconnect [server]`、`/mcp enable <server>` 和 `/mcp disable <server>`。reconnect 重新读取配置，指定服务器时只重建该连接，不指定时重载全部服务器。启停保存到定义服务器的配置文件；文件已被外部修改时要求先 reload。更改连接需要空闲状态，状态和工具列表可在执行期间查看。补全包含子命令和当前服务器名。

启动以及新建、恢复或切换会话时，composer 等待全部已启用且允许连接的 MCP 完成连接和工具发现，等待期间不接收对话输入，Ctrl+C 可退出。单个服务失败不阻止其他服务连接，但交互模式会停留在失败处理页，明确选择重试或使用当前可用工具继续后才开放 composer；非交互模式直接报错，不发送工具不完整的首轮请求。禁用、viewer 或恢复保护阻止的连接不参与等待。服务器的 tools/list_changed 更新目录，禁用或删除后旧工具不可调用；断线后 SDK 可在下次调用时重新连接，并对新连接重新审批。审批期间 schema 改变会取消旧调用。新建、恢复、fork 和退出会等待旧连接关闭；历史恢复不重放调用或恢复旧授权。中断发送协议取消请求，但外部服务未必能撤销已发生的副作用。普通失败和超时不自动重放工具；SDK 对服务器明确返回 session expired 的请求可重建会话后再尝试一次，仍需经过新连接的授权检查。

MCP 使用 Pi 1.2.0 的高层扩展，负责连接、OAuth、工具命名、目录更新和结果转换。`exposure` 默认 `codemode`，工具只在脚本中按需发现；设为 `direct` 可直接声明给模型，`deferred` 通过 `tool_search` 加载，`hidden` 隐藏。`toolExposure` 可按原始工具名或 Pi 的 `*` 模式覆盖单项，`enabledTools` / `disabledTools` 始终优先过滤。使用 `/mcp exposure <server> <codemode|deferred|direct|hidden>` 保存并应用模式。

`/mcp login <server>` 使用 SDK 的 OAuth 自动发现和动态客户端注册。交互界面显示授权链接，浏览器回调完成后自动重连，也可粘贴回调 URL。`/mcp logout <server>` 删除对应凭据并断开服务。中断或退出会取消登录。菜单只在远程服务器要求 OAuth 时显示 Sign in，有已存 OAuth token 时显示 Sign out；stdio 和已有 header / bearer token 服务不显示这些动作。

文本、图片、工具错误和结构化结果由 SDK 转换。CodeMode 获得完整 MCP 结果对象，可读取 `result.structuredContent`；直接调用以服务提供的文本内容为主。SDK 对大文本输出截断并保存临时文件，宿主只允许本会话的 Read 读取已登记的输出文件，文件被替换或切换会话后失效，不放开整个临时目录。MCP resources/prompts 和旧式 HTTP+SSE 尚未开放；资源工具在扩展与模型白名单中均关闭，待补上逐服务器资源审批后再接入。`pi mcp add` 属于 Pi CLI，不会自动变为 `arkcode mcp add`，当前通过配置文件接入。

## CodeMode 与基础工具

官方 `codemode` 工具常驻，使用 QuickJS 执行 JavaScript，可调用六个基础工具和已允许的 MCP 工具。脚本内用 `searchTools()`、`describeTool()` 发现工具，用 `tools.<name>(...)` 调用；`text()` 输出，`store()` / `load()` 在会话分支中保存 JSON 数据。当前模式为 `on`，六个工具仍可直接调用。没有额外的 exec/wait 后台单元机制。

脚本没有直接 Node、文件系统或网络能力，模型子调用也已关闭。每个嵌套调用经过与直接调用相同的审批和恢复保护。基础工具及 MCP 工具声明为顺序执行，`Promise.all` 不会同时弹出多个审批。中断信号传入嵌套调用，会话历史保存嵌套调用的名称、参数和状态；恢复不重放操作，compact 继续跟踪其文件路径。

Read、Write、Edit、Grep、Glob、Bash 复用 Pi SDK 工具定义，宿主仅保留路径保护、审批和进程管理适配。Read 支持图片，文本采用 SDK 输出格式。Edit 使用 `edits: [{oldText,newText}]`，SDK 仍接受旧的单段参数。Grep 使用 rg 的正则及 gitignore 行为，排除元数据、凭据与依赖目录，跳过超过 2 MiB 的文件。Glob 保留安全目录遍历，超过 10000 个文件明确报错并要求缩小路径。Bash 在 Windows 实际运行 PowerShell，取消调用的工具退出码为 130，原始进程退出码保留在 receipt 中。

安装、开发、检查及构建时会运行固定版本的 [SDK 接入补丁](scripts/pi-sdk-patch/README.md)。补丁补充宿主生命周期、审批、凭据目录和搜索限制接口，校验 SDK 版本与文件 SHA-256，遇到不匹配立即失败。升级 Pi 时需要审查并删去上游已提供的补丁。源码分层与验证入口见 [架构说明](ARCHITECTURE.md)。

## 模型上下文

完整机制、刷新规则和实现入口见 [静态与动态上下文说明](CONTEXT.md)。

静态 system prompt 定义任务范围、工具使用、保留用户改动、遵守拒绝、验证和沟通要求。动态信息不写入此静态文本。每次对话模型请求准备时，包括工具续跑，宿主读取工作目录、平台/OS、实际 shell、日期/时区、Git 分支、执行恢复状态、全局 AGENTS.md 和可信项目的 AGENTS.md。

项目规则按 Git 根到 workspace 的祖先顺序加载，再按目录名排序深度优先扫描 workspace 子目录。每份规则只约束所在目录及后代，更具体规则在其范围内优先，同级目录规则互不影响。仅识别 `AGENTS.md`，不读取 override 或备用名称。项目文件共享默认 32 KiB 的原始内容预算，可在 `settings.json` 设置 `"projectDocMaxBytes": 65536`；全局文件全量读取且不占项目预算。空文件跳过，超限文件保留前缀并提示，预算耗尽后停止。递归不进入 `.git`，目录链接只在 workspace 内跟随，并按真实路径去重以避免循环。详见 [上下文机制说明](CONTEXT.md)。

首次注入完整上下文，随后仅在值变化时追加差量；跨日只追加新日期，AGENTS.md 修改或删除时追加当前指令集合的替换声明。消息转换为 `user` role，并以隐藏消息保存到 Pi 历史，TUI 转录与恢复视图不显示。权限模式不写入动态上下文，审批由工具执行入口处理。

新会话、恢复和 fork 在首次请求重新读取当前信息。compact 后按模型实际保留的消息确定基线；完整上下文锚点被压缩掉时，下一次对话请求重新注入完整上下文。未变化的 system、tools 和历史消息前缀保持一致，便于供应商复用 prompt cache；compact、模型切换和供应商缓存策略仍可能影响命中，不保证缓存命中率。

## 操作

Enter 发送任务。运行时 Enter 提交 steer，在当前工具完成后交付；Tab 排队下一轮。Ctrl+J 或支持该键位的终端中的 Shift+Enter 换行。粘贴不会发送任务或批准工具。输入 `@` 自动列出当前工作区的文件和目录，Tab 补全所选路径；`@path` 和 `@"path with spaces"` 添加文件内容，单个文件最多 128 KiB。

`!command` 执行用户命令，经过相同权限检查，结果加入会话。运行中提交 `!command` 会排队到当前模型循环结束。

| 入口 | 行为 |
| --- | --- |
| `/help` | 命令与快捷键 |
| `/model`、`/connect` | 模型选择、端点配置 |
| `/permissions`、`/status` | 权限与实际运行配置 |
| `/mcp` | MCP 状态、工具列表、启停及重连 |
| `/new` | 新会话，保留旧历史和工作区文件 |
| `/resume`、`/resume <id>`、`/rename`、`/fork [id]` | 打开会话列表、按当前项目 ID 恢复、重命名、分支 |
| `/compact` | Pi 上下文压缩，保留原始历史 |
| `/copy`、`/init` | 复制完整回答、生成 AGENTS.md |
| `/exit` | 停止执行并退出 |

TUI 遵循原生设计 demo 的 `prism/instrument-deepfield`，使用固定 Prism 配色、完整输入框和六字段底栏。底栏依次显示模型、推理等级、目录、权限、Git 分支和上下文用量。审批与选择面板替换输入框，关闭后恢复草稿。工具显示实际目标与执行状态，默认预览最多三行终端输出，失败命令保留退出码。模型提供的推理内容默认收起。

空闲且输入框为空时按左方向键，或输入 `/resume`，打开跨项目会话列表。Tab/Shift+Tab 切换状态筛选，`g` 按项目或状态分组，`/` 搜索，方向键与 PgUp/PgDn 移动，Enter 打开，`n` 在选中项目新建，Esc 返回。宽终端显示会话详情，窄终端显示单列。恢复会话时显示当前分支的完整历史，包括压缩前的消息。列表只把当前进程中实际运行的会话标为 Working 或 Needs you；历史会话标为 Inactive，未确认的运行标记为 Unconfirmed。切换到未信任项目时需要重新选择信任级别，原项目的权限不会自动延续。打开失败会保留原会话与草稿。

旧 `settings.json` 中的 `theme` 和 `statusline` 可读取，下一次保存时移除。文件差异可在 IDE 或外部 Git 工具中查看。代码审查可直接作为普通任务提交。

Esc 中断 agent；面板中的 Esc 返回。Ctrl+C 运行时中断，空闲时退出。Ctrl+D 在空输入区退出。Ctrl+T 展开工具转录及模型提供的推理内容，Ctrl+O 复制最近完整回答，Ctrl+R 搜索提示历史，Ctrl+G 使用 `VISUAL` 或 `EDITOR` 编辑草稿。Ctrl+L 仅清理视图。Shift+Left 编辑未消费队列输入。空输入区双 Esc 编辑上一条提示并创建分支，不回滚文件。

Goal、多代理、skills、插件、持久 Plan、学习式记忆、云执行和媒体输入后置。已知后置 slash 命令显示不可用，未知命令不会发送给模型。

## 单轮与验证

```powershell
arkcode --print --permissions always-ask "Explain this project"
arkcode --json --permissions ask-when-needed "Fix the test and run it"
npm run check
npm test
```

非交互模式默认拒绝需要审批的动作。`--approve` 显式批准这些动作；`--permissions never-ask` 使用完整权限。JSON 输出包含模型流、工具事件、审批和最终运行状态，隐藏动态上下文不会作为 UI 消息输出。

测试使用本地 OpenAI 兼容服务驱动真实 Pi SDK，并执行真实文件操作、Git 和本机 shell。真实 DeepSeek 调试另见 [验收记录](docs/implementation/VERIFICATION.md)。Windows 已验证子进程树取消；macOS/Linux 实机、不同终端的中文 IME、系统剪贴板和外部编辑器尚未完整验收。
