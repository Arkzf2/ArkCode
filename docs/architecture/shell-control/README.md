# Bash / shell_control 设计与 schema

日期：2026-11-03。bash / shell_control 已接入 ArkCode。JSON Schema 从运行时 TypeBox 定义生成，更新命令为 `npm run schemas:shell`。

保留 `bash`，新增 `shell_control`，通过 `action: wait | send | stop` 控制同一命令会话。Pi 继续承担注册、分发和 CodeMode；ArkCode 接管持续进程与输出。

## 设计文件

- [架构与实施位置](../SHELL_CONTROL_PROPOSAL.md)
- [模型 description、字段说明与各场景 context](../SHELL_CONTROL_MODEL_CONTRACT.md)
- [bash input schema](bash.input.schema.json)
- [shell_control input schema](shell_control.input.schema.json)
- [共用的结构化 result schema](shell.result.schema.json)

JSON Schema 使用 draft 2020-12。控制工具按 action 拒绝无关参数，结果按 kind 和 status 限制字段组合。

## 等待时间

| 操作 | 字段 | 默认 | 有效范围 |
| --- | --- | --- | --- |
| bash | `yield_time_ms` | 10000 ms | 10000 至 60000 ms |
| wait | `wait_ms` | 10000 ms | 10000 至 300000 ms |
| send | `wait_ms` | 500 ms | 500 至 60000 ms |

以上是用户确认的整数毫秒预算，不接受 0。进程提前结束仍提前返回，到期只交还控制权。`bash.timeout` 独立限制执行时间，无默认值，范围 1 至 600 秒，支持小数秒。

stop 只接受 action 和 session_id，不接受 wait_ms。校验和权限检查通过后立即发起取消，宿主内部最多用 5000 ms 确认清理，确认后提前返回 cancelled；仍在清理时返回 stopping，后台继续清理，需要时用 wait 获取最终结果。清理失败时明确返回 cleanup failed，保留未确认状态并阻止后续执行，不声称进程树已停止。内部确认期限不延迟取消请求。已结束会话立即返回原状态。重复 stop 不重置取消流程或延长原确认期限，直接返回当前状态。

普通 wait 等待至结束、观察到期或用户新指令，单条进度不会使其立即返回。已结束会话立即返回。输出截断不会改变等待策略。

结果只使用 `wall_time_seconds` 表示本次 bash 或 shell_control 的实际耗时，单位秒、支持小数，包含执行准备、输入交付、观察和输出捕获，不包含审批时间，不累计之前的调用。内部执行记录仍保留进程开始和结束时间。到期提示使用请求的毫秒观察预算，例如 `[still running after the 60000ms observation window; session_id: sh_a1b2c3d4]`，该数字不是测量耗时。提示同时进入直接文本和 CodeMode 结构化结果的 `message`，明确使用同一 session_id 调用 shell_control，避免重新启动。

句柄为 `sh_` 加 8 位随机十六进制字符，共 11 字符；分配时检查碰撞，同一 ManagedShell 生命周期内不复用，包括跨 run 清理后。模型可见结果不再重复 shell 可执行文件路径和 cwd，环境上下文、审批及内部记录仍保留。CodeMode 的 `Script completed` 只表示脚本结束，嵌套命令可能仍在运行。

## 输出与 CodeMode 分层

删除 bash 和所有 shell_control 动作的 `max_output_tokens`，不提供 `has_more` 或日志分页。

| 层次 | 返回范围 | 超限处理 |
| --- | --- | --- |
| 直接给模型的 bash/control 文本 | 本次增量末尾最多 2000 行或 50 KiB，先触及的限制生效 | 显示预览、截断提示、文件行号范围及路径 |
| CodeMode 脚本接收的结构化 shell 数据 | 保留 Pi 独立的 1 MiB 数据上限 | 保留头尾并标注省略字节，提供文件路径 |
| CodeMode 最终交给模型的文本 | 遵循 CodeMode 自己的配置，目前默认 10000 tokens | 使用 CodeMode 自己的截断与存文件机制 |

直接文本与脚本数据来自同一次观察，状态一致，正文大小和是否截断可以不同。结构化字段 `truncated` 只描述脚本数据；直接文本使用自己的截断提示。1 MiB 是当前 Pi shell 的独立常量，不是新的模型参数，也不是 CodeMode 外层 token 配置。

Pi 已有“末尾预览 + 行号范围 + 完整文件路径”，无需改成只返回路径。保留这一行为能让模型先看到错误、测试汇总等末尾信息，再决定是否补读。50 KiB 指 51200 UTF-8 字节。状态和截断说明不占预览正文预算；单行超长时保留 UTF-8 安全的行尾并注明部分行。

每次结果提交后，观察位置推进至本次捕获末尾，包含未展示的部分。后续 wait 只返回这之后的新输出，不补发省略内容，也不重复旧预览。没有新输出时正文为空。已结束且被截断的结果无需再 wait；只有任务需要时才 read 保存文件。

## 保存文件与读取

文件包含命令从开始到本次捕获位置的完整日志，包括已展示的内容。运行中返回不可变的完整前缀快照，后续输出不修改旧文件；结束后提供完整封存日志。私有追加日志不直接进入现有不可变文件授权体系。

若直接文本或结构化数据任一发生截断，就必须先成功保存并授权文件，再提交结果。保存失败返回带已知会话状态的错误，不虚构路径，不推进观察位置。保留文件身份检查，新增 shell_control 为可信输出生产者。

授权输出文件的文本读取已改为分段处理，offset/limit 不再受原 64 MiB 整体读取限制。原生 read 与 CodeMode 共用该路径，读取前后校验不可变文件身份，不把完整大文件加载到内存。单行超长时保留明确提示，可用 bash 提取或过滤所需部分。

CodeMode 外层保存的只是脚本实际输出的文本，不会自动展开 shell 文件路径或补入 shell 省略的日志。脚本按需读文件、过滤并输出所需证据。外层再次存文件不影响内层日志，但也不能代替内层日志。

## 输入与生命周期

默认 stdin closed。后续需要输入时，启动选择 pipe。send 要求非空 data 或 eof true，不 trim、不追加换行。输入交付最多 65536 UTF-8 字节；宿主使用独立的 5000 ms 写入期限，防止背压无限阻塞。

EOF 永久关闭输入，不等于退出。`exit\n` 等只对支持该语句的程序有效。pipe 中 Ctrl+C 字节不等于终端中断，宿主取消使用 stop。`accepted` 只证明输入交付，不证明程序处理；交付 unknown 时禁止自动重发。

会话属于当前 agent run，可跨工具调用和 CodeMode 脚本。单次观察取消或脚本结束不终止已交回的进程；整个 run 结束、用户中断和 runtime 退出执行清理。不承诺跨用户轮次保留。

`stopping` 表示尚未确认所有后代停止。正常非零退出为 session failed，区别于工具错误。保留真实退出码、信号和独立的终止原因；重复 stop 不改写已确定结果。

同会话拒绝重叠 wait，但允许 send/stop 在已有 wait 期间发出操作。观察、文件复制期间不持有进程或输入锁。原生和 CodeMode 共用观察位置，UI、文件读取及通知均不消费它。

## 注册、权限与模型 context

使用同一输入 schema 进行声明和严格原始参数校验，在 Pi prepareArguments 中先拒绝数字字符串、小数毫秒、null 等，再进入常规校验。Pi 不自动插入 schema default，handler 按动作补省略值。使用 constrainedSampling false，避免当前 strict 转换器不支持 object union 的问题。

bash description 从实际 Pi shell 定义 edit / append，保留工作目录、stdout/stderr、原截断说明、可选 timeout 和 ArkCode 权限说明。PowerShell 显示正确 shell 名称。具体时间与输入规则放入字段 description。

direct 使用原生工具；codemode 可原生或 nested；codemode-only 只 nested。三种方式共用进程和权限。send 可能向解释器提交新的可执行输入，权限按动作判断，不能把启动批准视为后续输入的无限授权。

结果保留句柄、状态、真实退出信息、输入交付、清理状态及必要截断事实，不要求读完日志。CodeMode 对结构化工具错误可能 resolve，脚本应检查 kind/status，也要处理校验阶段 reject。

完成通知在下次模型请求前通过宿主 context 投递，只包含状态，不携带或消费日志，也不提供 has_more。仅在 active run 中投递并去重。上次只返回 stopping 时，最终清理确认仍需送达。请求准备时刷新简短会话 inventory，压缩后可恢复仍有效的句柄，不承诺空闲唤醒。

## 验证范围

自动化测试覆盖 schema 边界、动作互斥、Git Bash / PowerShell 输入与 EOF、并发等待和停止、截断后的新输出、不可变快照、独立结构化上限，以及超过 64 MiB 的授权文件分段读取。三种工具模式通过本地 provider fixture 验证。未调用外部模型服务；POSIX 进程组清理需在对应平台继续验收。

2026-11-03 验证结果：全量 `npm test` 为 355/355 通过。随后对自然退出与 stop 的竞态修正完成 30/30 工具测试和 5/5 运行时集成复验，包括跨 run 句柄失效和 compact 后恢复会话清单。`npm run check`、`npm run build`、`node dist/cli.js --help` 均通过。JSON Schema 可用 `npm run schemas:shell` 从运行时定义重新生成。

同日简化返回字段后复验：38/38 工具与 shell 测试、4/4 运行时集成测试通过，覆盖三种工具模式和 compact 后的会话恢复。`npm run check`、schema 生成、构建及 CLI 帮助检查通过。构建产物运行真实 `sleep 11` 时，默认观察预算 10000 ms 后返回 running，本次耗时约 10.040 秒；进程完成后以 300000 ms 预算调用 wait，约 0.001 秒返回 completed。新增测试还确认到期提示使用请求预算、用户 steering 不误报等满预算、结果无旧毫秒字段和重复 shell/cwd、短句柄跨 run 不复用。这些耗时是本机样本，不是延迟保证。

提交前最终验证：全量 `npm test` 为 357/357 通过，耗时约 380 秒；`npm run check`、`npm run schemas:shell`、`npm run build`、`node dist/cli.js --help` 均通过。CLI 帮助同步反映七个内建工具，以及 wait/stop 与 send 的审批差异。

实施验收需覆盖三种工具模式、真实进程等待与清理、截断后仅返回新输出、运行中快照不可变、超大文件分段读，以及 CodeMode 独立输出配置。详细清单见架构方案。
