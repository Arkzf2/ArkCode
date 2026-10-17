# Skills 机制

ArkCode 使用 Pi SDK 1.2.0 的 `Skill` 类型、`loadSkills()`、`formatSkillsForPrompt()`、`stripFrontmatter()` 和会话接口。发现来源、启停配置、`@` 选择与 TUI 由宿主管理，不启动 Pi CLI，也不使用 SDK 私有的 Skill 命令展开方法。

## 发现与优先级

| 来源 | 范围 | 信任要求 |
| --- | --- | --- |
| 用户 | `~/.agents/skills` | 始终发现，与 `--home` 无关 |
| 项目 | 最近 Git 根到会话 cwd 各级 `.agents/skills` | 当前工作区已信任 |

`.git` 可以是目录或 worktree 文件。找不到 Git 根时，项目来源只有 cwd 下的 `.agents/skills`，不扫描无关父目录。不会为了发现项目来源递归 workspace 子目录，也不读取 `.pi/skills`、ArkCode 配置目录下的 `skills/`、插件或包来源。

每个来源内部递归寻找 `SKILL.md`。发现 manifest 后停止进入该 Skill 的子目录，参考文件留待按需读取。遍历跳过点目录和 `node_modules`，通过真实路径消除链接循环，最多深入 8 层，每个来源最多访问 2000 个目录。仅将已发现的 manifest 路径交给 Pi 解析，不让 SDK 再扫描默认目录。超过 2 MiB 的 manifest 跳过并记录诊断。Pi 解析和格式诊断、扫描问题可在来源菜单或 `/skills list` 查看。

距离 cwd 越近的项目来源优先，之后是祖先项目来源，最后是用户来源。来源内部按目录名排序遍历。同一实际 manifest 只登记一次；不同文件同名时保留所有管理项，首个已启用项用于调用，其余显示为 shadowed。禁用首项后仍启用的同名项可以生效。同名管理必须指定完整 manifest 路径，避免误改。

## 目录、正文与读取

默认 system prompt 只包含名称、描述和 manifest 路径。`disable-model-invocation: true` 的项从自动目录排除，但仍可在 `@` 或 List skills 中由用户选择。名称含有无法用于 mention 的分隔符时跳过并显示诊断。

每次 agent run 的 `before_agent_start` 更新 Pi system prompt 的 skills 段，当前目录替换此前目录。正文不预加载到该段。模型根据描述自行选择后，通过 ArkCode 的 Read 加载 `SKILL.md` 和所需参考文件。CodeMode 模式中仍通过现有工具发现与调用路径读取，不新增执行接口。

用户输入 `/skill:name 任务` 或 `@skill:name` 时，宿主在提交或入队时读取所选正文，去除 frontmatter，并为每个 Skill 生成 `User activated the skill "...". Follow the loaded skill instructions.` 和 `<skill-loaded name="...">` 正文块。原始用户输入放在所有正文块之后，可一次选择多个 Skill，同名重复提及只加载一次。提示要求直接遵循已加载正文，不再为激活而重复读取同一 `SKILL.md`；其他适用 Skill 通过当前可用工具接口加载。宿主提前展开是为了支持多项 `@` 选择、明确报错和固定队列快照；SDK 的私有单项展开方法没有被调用。未知、禁用或已丢失的项会报错，不向模型提交不完整请求。行内代码和围栏代码中的 mention 不触发加载。界面隐藏激活说明和正文块，旧会话的 `<skill>` 块仍支持隐藏。

一条输入最多选择 8 个不同 Skill，单个正文和参考文件最多 2 MiB。目录元信息没有额外的 token 或总字节预算，沿用 Pi 的格式化行为。目录很多时会增加每轮 system prompt 长度。

已登记且启用的 Skill 根目录内文件可由 Read 只读访问，包括用户目录和 cwd 外的祖先项目 Skill。读取前重新验证根目录与 manifest 的真实路径，资源链接不得越出已登记根目录，`.git`、`.arkcode` 与 `.env*` 文件不开放。Write/Edit 和其他工具继续遵循原有工作区与审批检查。Skills 不授予 shell、MCP 或额外工具权限；这不是操作系统沙箱。

## 会话中的变化

| 操作 | 行为 |
| --- | --- |
| `/skills reload` | 重扫来源，更新当前 runtime 的目录与补全，不重建 SDK 会话或 MCP |
| enable / disable | 按实际 manifest 路径保存偏好，更新后续可用目录与新输入校验 |
| 已加载正文被禁用 | 历史保留；当前目录和提示要求后续新任务停止沿用已禁用项 |
| 已排队的选择 | 保留入队时正文快照；不会用磁盘新版本改写已排队输入 |
| 修改现有正文 | 下次明确选择或 Read 读取当前文件，不需要 reload |
| 新增、删除或修改元信息 | reload 或打开新会话后刷新发现结果 |
| 切换现有会话 | 使用该会话目录，重新读取共享启停偏好，补全跟随当前会话 |
| resume / fork | 重新发现当前来源，保留原有历史，不重放 Skill 加载或脚本 |

偏好文件位于 `<ArkCode home>/skills.json`，格式为 `{"version":1,"disabledPaths":[...]}`。`--home` 与 `ARKCODE_HOME` 决定其位置。同一个配置目录下的会话共享偏好，读取模型请求、提交输入和进入管理页时刷新；不使用文件 watcher。写入先生成临时文件再原子替换，保存成功才更新内存。独立进程同时修改时没有跨进程事务保证。

启停和 reload 仅在当前会话空闲、无待消费 steer/follow-up 时允许。viewer、历史写入失败或执行状态未确认时只能查看。管理操作不会从持久历史中删除 Skill 正文，也不会清空模型记忆；停用通过当前目录、提示和读取检查生效。

## TUI 与输入

`/skills` 打开临时菜单，包括 List skills、Enable/Disable Skills、Reload skills 和 Sources and diagnostics。List skills 将 `@skill:name ` 加到原草稿末尾，不自动发送。启停页面通过方向键、PgUp/PgDn 选择，输入文字过滤，Space/Enter 切换，Esc/Ctrl+C 返回。每次切换立即保存，失败显示错误并保留原状态。菜单查询和切换不写入聊天或提示历史。

`@query` 按名称与描述搜索已启用 Skill，并与工作区文件候选合并；`@skill:query` 只列 Skills。Skill 候选插入 `@skill:name`，文件候选保留 `@path` 或带引号的路径，避免同名歧义。Tab 接受补全，选择本身不提交请求。运行时继续使用既有的 Enter steer、Tab follow-up 语义。

所有颜色复用 `src/ui/colors.ts` 的 Prism 常量。Skill 和调用使用紫色，文件与来源使用青色，启用使用绿色，禁用使用灰色，管理标题使用暖黄色，错误使用原有红色。
