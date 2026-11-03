# ArkCode

ArkCode 是基于 Pi SDK 的终端编码 agent。模型调用、工具循环、会话历史和上下文压缩由 Pi 管理。ArkCode 提供原生 TUI、工具审批、受管命令、输入队列、多会话并发、会话恢复和 Git 分支状态。

当前使用 Pi SDK 1.5.0，版本适配及行为变化见 [升级记录](docs/implementation/PI_SDK_1_5_UPGRADE.md)。

## 启动

需要 Node.js 22.19 或更新版本。Windows 自动寻找 Git Bash，优先从 PATH 中的 Git 安装定位，也检查系统和用户的常见安装目录；找不到时回退 PowerShell，优先使用 PowerShell 7。macOS 和 Linux 使用 `/bin/sh`。Git 用于显示当前分支。

每个会话在创建时固定 shell，执行失败不会自动更换解释器。如果实际配置发生意外变化，下一次模型请求会同步更新 shell 提示词、环境信息和工具描述，包括同一轮内的工具执行后续请求。已经发送的请求无法追溯修改。

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

首次打开目录时选择是否信任。全局配置目录的 `AGENTS.md` 和用户 `~/.agents/skills` 始终可用；信任后加载项目 AGENTS.md、`.agents/skills`，并允许项目 MCP 配置连接服务器和启动本地进程。AGENTS.md 覆盖 Git 根到 workspace 的祖先及 workspace 子目录；项目 Skills 仅发现 Git 根到 cwd 各级 `.agents/skills`。没有 Git 根时，Skills 只读取 cwd 下的来源。ArkCode 不加载项目扩展、插件或 `.pi` 设置。

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
| `skills.json` | 按实际 manifest 路径保存的 Skill 禁用偏好 |
| `mcp-auth.json`、`mcp.log` | MCP OAuth 凭据及服务日志，随 `--home` 隔离 |
| `sessions/` | Pi JSONL 历史，按真实工作区分组 |
| `runs/` | 运行结束与中断标记，不保存第二份对话 |

自定义模型配置遵循 [Pi models 文档](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/models.md)。模型配置属于用户可信配置，Pi 支持的凭据命令也可以执行。

## 权限

| 模式 | 实际行为 |
| --- | --- |
| Always Ask (`always-ask`) | 内建 read/grep/glob、独立的 `ls` 及已获会话批准的相同操作自动允许；其余动作和 MCP 调用需要批准 |
| Ask When Needed (`ask-when-needed`) | 普通 write/edit/bash 自动允许，高危命令询问；MCP 默认询问，用户级 `autoApproveTools` 中的工具可自动批准，服务标记为 destructive 的工具仍询问 |
| Never Ask (`never-ask`) | 使用当前用户的 OS 权限执行，内建工具和 MCP 不等待调用审批；仍遵守服务器启用状态、工具过滤、viewer 和恢复保护 |

七个内建工具 `read`、`write`、`edit`、`grep`、`glob`、`bash`、`shell_control` 在三种权限模式中都可使用，暴露形式由 `/tool-mode` 决定。MCP 工具由已连接服务器的当前目录动态注册，名称为 `mcp__<server>__<tool>`，清洗或超长名称加 hash。权限切换不会改变工具 schema。原 `find` 改名为 `glob`，原 `ls` 工具删除；目录列表使用 bash。`bash` 是固定工具名，Windows 优先运行 Git Bash，否则运行 PowerShell。工具描述、系统提示词和环境上下文同步提供实际 shell 及对应语法；恢复会话时以当前发现结果为准。Always Ask 对当前 shell 的独立目录列表提供豁免，Bash 使用 `ls`，PowerShell 使用 `Get-ChildItem` 或其 `ls` 别名；重定向、管道、命令替换和串联命令不属于列表豁免。

未信任目录跳过项目 AGENTS.md，保留全局规则，默认 Always Ask；显式 CLI 权限仍生效。通过 `/permissions` 选择的模式会保存，下次启动自动恢复；`--permissions always-ask/ask-when-needed/never-ask` 可覆盖当次启动的模式。旧 `ask`、`full-access` 和 `--full-access` 仍映射到相应新模式；旧 `read-only` 配置及 `--read-only` 会报错，要求明确选择新模式。

Ask When Needed 采用 Kimi 的普通动作自动批准、有限高危规则优先询问的机制。规则覆盖关机/重启、磁盘格式化、写入设备的 `dd`、递归强制删除等，并检查命令包装、命令替换与嵌套 shell。无通配、变量和 `..` 的 `/tmp`、`/temp` 删除目标有例外。PowerShell 使用原生 AST，增加对应 Windows 命令规则。POSIX 使用 `bash-parser` 在独立解析进程中检查；超时、解析失败及尚不支持的 heredoc 视为无法分析，在 Ask When Needed 中自动允许，在 Always Ask 中询问。它不检查任意脚本或所有副作用，例如 `git push`、`git reset --hard` 和 Python 脚本不会仅因该有限规则要求批准。

会话授权绑定完整工具参数、shell 和目录。停止、切换权限或切换会话撤销旧审批，恢复历史不会恢复批准记录；已知高危命令优先于会话授权，每次仍询问，Never Ask 跳过此检查。拒绝当前调用会返回工具错误，不创建持久黑名单。文件工具保留工作区、受保护路径、symlink 和文件大小限制。bash 命令使用当前用户权限，并可访问工作区之外的路径。

MCP 会话授权还绑定原始 server/tool、配置来源、配置与 schema 指纹、连接身份及完整参数，不能沿用到重连后的同名服务。`readOnlyHint` 不自动授予权限；服务的 destructive 标记在两种询问模式中优先于自动批准和会话批准。MCP 的执行权限与工具是否暴露分别管理。外部服务不受 ArkCode 文件工具的工作区限制，MCP roots 也不是 OS 沙箱。

同一终端可以保持多个 agent session 同时运行。`/new` 新建会话，`/sessions` 或在空输入框按 Left 打开会话列表。切换只改变当前显示，原会话的模型请求、工具与队列继续执行。输出、草稿、审批、shell 和 MCP 连接各自独立；后台需要审批时显示提示，切回该会话后才展示审批。Ctrl+C 中断当前会话，`/exit` 或终端退出会停止本终端拥有的全部会话及其受管进程。

可以在多个终端同时打开同一工作区，运行不同会话。同一个 session 同时只有一个可写宿主，其他终端恢复该 session 时进入 Read-only viewer，定期刷新已保存的历史，不能发送、steer、改名或修改该会话设置。viewer 可以 `/new` 或 `/fork` 创建独立会话。原宿主退出后，在 viewer 中用 `/sessions` 重新打开该会话，即可重新尝试取得输入权。会话锁按 session ID 管理，不按 workspace 或 `--home` 划分。

edit/write 沿用 Pi 的同文件修改队列。同一进程内不同会话、不同 cwd 访问同一个实际文件时，SDK 会让这些文件修改依次执行。队列不跨独立终端进程，也不覆盖 shell、MCP 或外部编辑器；完整 write 仍可覆盖旧内容。这与 Pi 原生行为一致，没有额外的版本检查或自动合并。

历史恢复不重放工具、草稿或队列，中断不会回滚文件。恢复某个 session 时发现其 active 运行标记，会显示 Execution unconfirmed，并限制该会话进行文件检查。其他 session 的运行标记不会阻止新会话或正常并发任务。强制结束宿主不保证所有子进程已退出；确认旧命令已结束后，才能手动将对应 `runs/` 标记改为 `interrupted`，补上 `endedAt` 并去掉 `pid`，然后重新打开该会话。

如果宿主在创建或回收 session 锁时崩溃，CLI 可能保持 viewer。启动消息给出残留锁的完整路径。确认没有进程持有或正在恢复该 session 后，才能手动清理残留锁文件。程序不自动清理无法确认归属的锁。

## Skills

用户 Skills 位于 `~/.agents/skills`，项目 Skills 位于 Git 根到当前 cwd 各级 `.agents/skills`。仅发现 `SKILL.md`，不读取 `.pi/skills`、`~/.arkcode/skills` 或普通散装 Markdown。`--home` 和 `ARKCODE_HOME` 只改变 ArkCode 配置位置，不改变用户 Skills 来源。项目来源需要工作区信任。同名时距离 cwd 最近的项目项优先，随后是祖先项目项和用户项；禁用高优先级项后可使用仍启用的同名项。

`/skills` 打开 List skills、Enable/Disable Skills、Reload skills 和来源诊断菜单。List skills 选择后加入草稿，不会直接提交。启停页支持输入过滤、方向键与翻页，Space 或 Enter 切换，Esc／Ctrl+C 返回。更改立即保存到 ArkCode 配置目录的 `skills.json`。Skill 使用紫色，文件与来源使用青色，启用使用绿色，禁用使用灰色，管理标题使用暖黄色。

输入 `@` 搜索文件和已启用 Skill，也可用名称或描述搜索。选择 Skill 后插入 `@skill:name`；输入 `@skill:` 只搜索 Skills。支持在一条消息中选择多个 Skill，也支持 `/skill:name 任务描述`。宿主在提交或入队时读取所选正文并固定快照；普通请求只包含名称、描述和路径，模型按需使用 read 加载正文及参考文件。`disable-model-invocation: true` 的 Skill 只供用户明确选择。

也可直接使用 `/skills list`、`/skills reload`、`/skills enable <name 或完整 SKILL.md 路径>` 和 `/skills disable <name 或完整 SKILL.md 路径>`。同名项的启停必须使用完整路径。重新扫描和启停要求当前会话空闲且无待消费队列，viewer 只可查看。禁用影响新输入和后续可用目录，历史正文与已入队快照保留。新增目录后用 reload 或打开新会话发现；无需重建 MCP 连接。完整的发现、上下文与读取规则见 [Skills 机制](docs/architecture/SKILLS.md)。

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

启动、新建或首次恢复会话时，composer 等待全部已启用且允许连接的 MCP 完成连接和工具发现，等待期间不接收对话输入，Ctrl+C 可退出。单个服务失败不阻止其他服务连接，但交互模式会停留在失败处理页，明确选择重试或使用当前可用工具继续后才开放 composer；非交互模式直接报错，不发送工具不完整的首轮请求。禁用、viewer 或恢复保护阻止的连接不参与等待。服务器的 tools/list_changed 更新目录，禁用或删除后旧工具不可调用；断线后 SDK 可在下次调用时重新连接，并对新连接重新审批。审批期间 schema 改变会取消旧调用。新建、恢复、fork 和退出会等待旧连接关闭；历史恢复不重放调用或恢复旧授权。中断发送协议取消请求，但外部服务未必能撤销已发生的副作用。普通失败和超时不自动重放工具；SDK 对服务器明确返回 session expired 的请求可重建会话后再尝试一次，仍需经过新连接的授权检查。

MCP 使用 Pi 1.5.0 的高层扩展，负责连接、OAuth、工具命名、目录更新和结果转换。`exposure` 默认 `codemode`，工具在脚本中按需发现；设为 `direct` 可直接声明给模型，`deferred` 通过 `tool_search` 加载，`hidden` 隐藏。`toolExposure` 可按原始工具名或 Pi 的 `*` 模式覆盖单项，`enabledTools` / `disabledTools` 始终优先过滤。使用 `/mcp exposure <server> <codemode|deferred|direct|hidden>` 保存模式，在首次 LLM 请求前、新会话或成功 compact 后应用；首次请求后，reload、reconnect 和 enable 保留当前会话的 exposure。disable、配置删除和工具过滤会立即阻止实际调用。没有启用的 MCP 模式时不拼接 MCP 指南。

`/mcp login <server>` 使用 SDK 的 OAuth 自动发现和动态客户端注册。交互界面显示授权链接，浏览器回调完成后自动重连，也可粘贴回调 URL。`/mcp logout <server>` 删除对应凭据并断开服务。中断或退出会取消登录。菜单只在远程服务器要求 OAuth 时显示 Sign in，有已存 OAuth token 时显示 Sign out；stdio 和已有 header / bearer token 服务不显示这些动作。

文本、图片、工具错误和结构化结果由 SDK 转换。CodeMode 获得完整 MCP 结果对象，可读取 `result.structuredContent`；直接调用以服务提供的文本内容为主。SDK 对大文本输出截断并保存临时文件，宿主只允许本会话的 read 读取已登记的输出文件，文件被替换或会话运行实例结束后失效，不放开整个临时目录。MCP resources/prompts 和旧式 HTTP+SSE 尚未开放；资源工具在扩展与模型白名单中均关闭，待补上逐服务器资源审批后再接入。`pi mcp add` 属于 Pi CLI，不会自动变为 `arkcode mcp add`，当前通过配置文件接入。

## CodeMode 与基础工具

官方 `codemode` 工具使用 QuickJS 执行 JavaScript。脚本内用 `searchTools()`、`describeTool()` 发现工具，用 `tools.<name>(...)` 调用；`text()` 输出，`store()` / `load()` 在会话分支中保存 JSON 数据。没有额外的 exec/wait 后台单元机制。

`/tool-mode` 打开临时子菜单，仅在这里显示 Current 和有变化时的 Pending。支持 `direct`（七个基础工具仅直接调用）、`codemode`（直接与脚本调用，默认）、`codemode-only`（仅脚本调用）；也可用 `/tool-mode <mode>` 保存设置。菜单和命令不进入聊天或输入历史。MCP exposure 独立配置，基础工具的 only 模式仍可保留 MCP direct 工具。只有基础工具和当前 MCP 策略需要时才声明 CodeMode／工具搜索入口。

新会话首次 LLM 请求前可反复修改模式，首次请求使用最新选择并同步拼接 system prompt。首次请求后，模式修改在新会话或手动、自动 compact 成功后生效。resume 和 fork 保留所在分支的策略及是否请求过 LLM 的状态；fork 后成功 compact 可应用最新设置。compact 取消或失败保留已请求会话的旧策略。策略快照只保存工具模式和 MCP exposure，不保存凭据或执行命令；首次请求状态另行保存，两者都不发送给模型。MCP 按需发现及真实服务端工具目录变化仍可在会话内发生。新增声明复用 Pi 的协议能力；工具卸载同时停止执行并追加隐藏通知，不承诺所有协议都能保留缓存。

`WebSearch` 使用当前模型供应商的服务端搜索，支持官方入口和兼容的自定义端点。OpenAI Responses 发送 `web_search`；Anthropic Messages 发送基础版本 `web_search_20250305`，并优先查看模型详情中的 `capabilities.server_tools.web_search.supported`。搜索由独立模型请求执行，只发送查询，不上传当前对话或本地文件。普通 Chat Completions 和其他协议不声明此工具。

搜索遵循 `/tool-mode`：`direct` 仅直接调用，默认 `codemode` 同时支持直接和脚本调用，`codemode-only` 仅脚本调用。支持 `Promise.all` 并行查询，每次调用都经过相同的权限与取消处理。搜索摘要、来源链接和请求用量保存为工具结果，resume 不会重放搜索；嵌套请求用量在工具详情中记录，不计入 Pi 主对话的用量统计。

`/web-search status` 查看当前模型的验证状态，`/web-search check` 发出一次真实搜索验证，可能产生供应商费用；`on` / `off` 保存启停设置，并在下次对话生效。默认启用，可在 `settings.json` 设置 `"webSearch": false`。兼容端点在首次实际搜索时验证，必须返回成功的服务端搜索记录，不能只返回普通文本。能力记录仅保留在当前进程中，按端点、协议、模型及凭据身份区分；明确不支持后隐藏工具，可用 `check` 重新验证。限流、鉴权、超时和服务端执行错误不会被记作永久不支持。搜索格式被代理接受不代表它支持所有其他内置工具。

七个基础工具复用 Pi 的并行调度；write/edit 对同一文件的修改排队，不同文件可以并行。审批界面逐项展示，通过后的独立调用可并行执行。读后编辑、同仓库 Git 修改等有依赖的操作仍应按顺序调用；bash 不受文件工具的同文件队列保护。

脚本没有直接 Node、文件系统或网络能力，模型子调用也已关闭。每个嵌套调用经过与直接调用相同的审批和恢复保护；`Promise.all` 中需要审批的调用也会逐项展示审批。中断信号传入嵌套调用，会话历史保存嵌套调用的名称、参数和状态；恢复不重放操作，compact 继续跟踪其文件路径。

read、write、edit、grep、glob 复用 Pi SDK 工具定义，宿主保留路径保护和审批。read 支持图片；授权的大输出文本文件支持按行分段读取。edit 使用 `edits: [{oldText,newText}]`，SDK 仍接受旧的单段参数。grep 使用 rg 的正则及 gitignore 行为，排除元数据、凭据与依赖目录，跳过超过 2 MiB 的文件。glob 保留安全目录遍历，超过 10000 个文件明确报错并要求缩小路径。

bash 和 shell_control 由 ArkCode 管理持续进程，沿用所选 Pi shell 的基础描述。bash 默认观察 10 秒，可设 10–60 秒；仍运行时返回短 session_id 和明确的继续等待提示。shell_control 的 wait 默认 10 秒，可设 10–300 秒；send 默认观察 0.5 秒，可设 0.5–60 秒；stop 无等待参数，立即请求进程树取消，由宿主短暂确认清理。提前结束会提前返回，已完成会话立即返回，观察到期不停止进程。`wall_time_seconds` 仅表示本次调用实际耗时，单位秒；到期提示中的毫秒数表示请求的观察窗口。后续结果只包含新增输出；直接文本最多保留最后 2000 行或 50 KiB，截断时提供完整日志的不可变快照路径。CodeMode 的结构化数据和脚本输出各自遵守独立上限。会话跨工具调用和脚本保留，当前 agent run 结束时清理。结果保留真实退出码与信号，不合成 130。输入默认关闭，需要后续输入时显式选择 `stdin: "pipe"`；send 的审批独立于启动审批。详见 [工具契约与 schema](docs/architecture/shell-control/README.md)。

安装、开发、检查及构建时会运行固定版本的 [SDK 接入补丁](docs/development/PI_SDK_PATCH.md)。补丁补充宿主生命周期、审批、凭据目录和搜索限制接口，校验 SDK 版本与文件 SHA-256，遇到不匹配立即失败。升级 Pi 时需要审查并删去上游已提供的补丁。源码分层与验证入口见 [架构说明](docs/architecture/ARCHITECTURE.md)，全部项目文档见 [文档目录](docs/README.md)。外部项目研究按主题保存在被 Git 忽略的 `research/`。

## 模型上下文

完整机制、刷新规则和实现入口见 [静态与动态上下文说明](docs/architecture/CONTEXT.md)。

静态 system prompt 定义任务范围、工具使用、保留用户改动、遵守拒绝、验证和沟通要求。动态信息不写入此静态文本。每次对话模型请求准备时，包括工具续跑，宿主读取工作目录、平台/OS、实际 shell、日期/时区、Git 分支、执行恢复状态、全局 AGENTS.md 和可信项目的 AGENTS.md。

项目规则按 Git 根到 workspace 的祖先顺序加载，再按目录名排序深度优先扫描 workspace 子目录。每份规则只约束所在目录及后代，更具体规则在其范围内优先，同级目录规则互不影响。仅识别 `AGENTS.md`，不读取 override 或备用名称。项目文件共享默认 32 KiB 的原始内容预算，可在 `settings.json` 设置 `"projectDocMaxBytes": 65536`；全局文件全量读取且不占项目预算。空文件跳过，超限文件保留前缀并提示，预算耗尽后停止。递归不进入 `.git`，目录链接只在 workspace 内跟随，并按真实路径去重以避免循环。详见 [上下文机制说明](docs/architecture/CONTEXT.md)。

首次注入完整上下文，随后仅在值变化时追加差量；跨日只追加新日期，AGENTS.md 修改或删除时追加当前指令集合的替换声明。消息转换为 `user` role，并以隐藏消息保存到 Pi 历史，TUI 转录与恢复视图不显示。权限模式不写入动态上下文，审批由工具执行入口处理。

新会话、恢复和 fork 在首次请求重新读取当前信息。compact 后按模型实际保留的消息确定基线；完整上下文锚点被压缩掉时，下一次对话请求重新注入完整上下文。未变化的 system、tools 和历史消息前缀保持一致，便于供应商复用 prompt cache；compact、模型切换和供应商缓存策略仍可能影响命中，不保证缓存命中率。

## 操作

Enter 发送任务。运行时 Enter 提交 steer，在当前工具完成后交付；Tab 排队下一轮。Ctrl+J 或支持该键位的终端中的 Shift+Enter 换行。粘贴不会发送任务或批准工具。输入 `@` 自动列出文件、目录和已启用 Skill，Tab 补全所选项。`@path` 和 `@"path with spaces"` 保留文件路径供模型通过 read 读取；图片由支持图片输入的模型接收。`@skill:name` 则随请求加载所选 Skill 正文。

`!command` 执行用户命令，经过相同权限检查，结果加入会话。运行中提交 `!command` 会排队到当前模型循环结束。

| 入口 | 行为 |
| --- | --- |
| `/help` | 命令与快捷键 |
| `/model`、`/connect` | 模型选择、端点配置 |
| `/permissions`、`/status` | 权限与实际运行配置 |
| `/mcp` | MCP 状态、工具列表、启停及重连 |
| `/skills` | Skills 列表、启停、重新发现与来源诊断 |
| `/tool-mode [direct\|codemode\|codemode-only]` | 基础工具调用方式，下次成功 compact 或新会话生效 |
| `/new` | 新会话，保留旧历史和工作区文件 |
| `/sessions`、`/sessions <id>`、`/rename`、`/fork [id]` | 打开会话列表、按当前项目 ID 恢复、重命名、分支 |
| `/compact` | Pi 上下文压缩，保留原始历史 |
| `/copy`、`/init` | 复制完整回答、生成 AGENTS.md |
| `/exit` | 停止执行并退出 |

TUI 使用 Prism 配色和完整输入框。工具调用使用醒目的绿色圆点，失败时变红；命令中的程序名、参数、字符串和路径分色。工具结果为灰色，中间说明与回答使用正常文字亮度。终端输出默认预览三行，点击 `+N lines` 单独展开，点击 `Show less` 收起；Ctrl+T 控制全部详情。edit 和 write 显示真实文件变更、行号及增删数量，默认预览八行；write 的变更预览限于新旧内容合计不超过 256 KiB 的文本，较大文件仍正常写入并显示执行结果。失败命令保留退出码。模型提供的推理内容默认收起。

底栏显示模型名称、推理等级、目录、权限和 Git 分支，模型名称不带供应商前缀。上下文另起一行靠右显示当前模型的已用/总 token 和百分比，空间足够时附带进度条。用量达到 70% 和 90% 时分别使用提示色和红色。点击上下文查看完整 token 数字；`~` 表示估算值，压缩后等待模型返回新用量时显示 `?`。模型切换后使用新模型的上下文窗口。`--json` 的 status 事件中，`context` 为 `{ tokens, contextWindow, percent }`，无法取得上下文时为 `null`。

滚轮或 PgUp/PgDn 浏览历史，End 回到最新内容。用鼠标左键拖动选择会话文字，选区高亮，松开后自动复制到剪贴板。有选区时 Ctrl+C 复制，Esc 清除选区；支持中文、emoji 和跨行选择。Shift+拖动仍可使用终端自身的选择功能。审批与选择面板替换输入框，关闭后恢复草稿。

输入 `/sessions` 打开跨项目会话列表。空输入框按左方向键也可打开。Tab/Shift+Tab 切换状态筛选，`g` 按项目或状态分组，`/` 搜索，方向键与 PgUp/PgDn 移动，Enter 打开，`n` 在选中项目新建，Esc 返回。宽终端显示会话详情，窄终端显示单列。恢复会话时显示当前分支的完整历史，包括压缩前的消息。列表只把当前进程中实际运行的会话标为 Working 或 Needs you；历史会话标为 Inactive，未确认的运行标记为 Unconfirmed。切换到未信任项目时需要重新选择信任级别，原项目的权限不会自动延续。打开失败会保留原会话与草稿。

旧 `settings.json` 中的 `theme` 和 `statusline` 可读取，下一次保存时移除。完整 Git 差异可在 IDE 或外部 Git 工具中查看。代码审查可直接作为普通任务提交。

Esc 中断 agent；面板中的 Esc 返回。Ctrl+C 运行时中断，空闲时退出。Ctrl+D 在空输入区退出。Ctrl+T 展开工具转录及模型提供的推理内容，Ctrl+O 复制最近完整回答，Ctrl+R 搜索提示历史，Ctrl+G 使用 `VISUAL` 或 `EDITOR` 编辑草稿。Ctrl+L 仅清理视图。Shift+Left 编辑未消费队列输入。空输入区双 Esc 编辑上一条提示并创建分支，不回滚文件。

Goal、多代理、插件、持久 Plan、学习式记忆和云执行后置。已知后置 slash 命令显示不可用，未知命令不会发送给模型。

## 单轮与验证

```powershell
arkcode --print --permissions always-ask "Explain this project"
arkcode --json --permissions ask-when-needed "Fix the test and run it"
npm run check
npm test
```

非交互模式默认拒绝需要审批的动作。`--approve` 显式批准这些动作；`--permissions never-ask` 使用完整权限。JSON 输出包含模型流、工具事件、审批和最终运行状态，隐藏动态上下文不会作为 UI 消息输出。

测试使用本地 OpenAI 兼容服务驱动真实 Pi SDK，并执行真实文件操作、Git 和本机 shell。真实 DeepSeek 调试另见 [验收记录](docs/implementation/VERIFICATION.md)。Windows 已验证子进程树取消；macOS/Linux 实机、不同终端的中文 IME、系统剪贴板和外部编辑器尚未完整验收。
