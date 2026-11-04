# 故障排查

[English](../en/troubleshooting.md) | 简体中文 | [文档首页](README.md)

## 没有可用模型或凭据错误

运行 `arkcode models` 检查已具备凭据的模型，使用 `/connect` 设置供应商，或确认当前进程可读取密钥环境变量。print 需要 `--model` 或已保存的默认模型。

自定义端点检查协议、模型 ID 和 baseUrl。Anthropic 配置入口拒绝末尾 `/v1`，OpenAI 兼容服务通常需要 API base `/v1`。同名 provider 已绑定其他端点时，换用独立名称。

改变环境变量后仍使用旧凭据时，检查 `/connect` 中的已存凭据。auth.json 中保存的认证可能优先于模型文件和继承环境。不要在报告问题时粘贴密钥或完整认证文件。

## settings.json 无法加载

检查严格 JSON 语法和[允许字段](reference/configuration.md)。Pi 的 settings 字段不能直接复制。旧 `read-only` 已移除，需要明确选择当前权限模式。未知字段、错误枚举和无效预算会报错。

## MCP 卡在启动或连接失败

用 `/mcp status` 查看服务器状态与脱敏诊断。检查命令和路径是否存在，stdio stdout 是否只写协议，所需环境变量是否设置。首次 npx 或 uvx 可能正在下载依赖，可预先安装或增加 startupTimeoutMs，最大 300000。

修改配置后运行 `/mcp reload` 或 `/mcp reconnect SERVER`。只有可信项目才加载项目配置。项目条目整体覆盖用户条目，不继承用户 autoApproveTools，且不能配置非空自动批准规则。

远程服务要求 OAuth 时运行 `/mcp login SERVER`。首次启动失败后，交互模式需要明确选择重试或使用当前可用工具继续；非交互模式会直接报错。

## 修改工具模式后没有变化

首次模型请求之前使用最新设置。已经请求过模型的会话保留分支策略，成功 `/compact` 或新会话才应用新设置。resume、fork、reload 或 reconnect 不会自动替换旧分支策略。停用和过滤工具仍立即阻止调用。

## Skill 没有出现

检查文件是否名为 SKILL.md，位于用户或可信项目的 `.agents/skills` 来源中。运行 `/skills reload`，查看来源诊断、禁用状态和 shadowed 同名项。`--home` 不改变用户 Skill 目录，`.pi/skills` 不参与发现。

## 会话一直是 Read-only viewer

另一个宿主可能持有该 session 的写入权。退出原宿主后，通过 `/sessions` 重新打开来重试。独立任务可以 `/new` 或 `/fork`。

若启动消息明确报告残留锁，先确认没有进程持有或正在恢复该 session，再清理消息给出的那一个锁文件。不能根据目录名猜测并删除一组锁。无法确认锁归属时，程序不会自动清理。

## Execution unconfirmed

旧 run 没有可靠的结束记录。先检查工作区文件和外部执行状态，确认旧命令及后代进程已经结束。仅在确认后，修改该 session 对应的 `<home>/runs/` 标记，将 status 改为 interrupted，补 endedAt，删除 pid，再重新打开该会话。

不要修改其他 session 的标记，也不要把标记改写当成已经终止进程。新建会话可独立工作，但不能因此假定旧进程已停止。

## shell 命令等待后仍在运行

观察预算到期不是执行超时。模型应对原 session_id 调用 shell_control wait；需要取消时使用 stop，看到 stopping 后继续等待清理确认。不要重复启动同一命令。PowerShell 和 Bash 语法不同，以 `/status` 的实际 shell 为准。

输出被截断后，用 read 读取返回的保存文件。后续 wait 不补发先前省略的日志。句柄跨 agent run 失效，详细规则见[工具参考](reference/tools.md)。

## 压缩失败或预算不足

检查模型 contextWindow 和 maxTokens 是否符合真实能力，是否能容纳[保留预算](concepts/context-and-compaction.md)。压缩请求还需要容纳系统规则、工具声明和待处理用户输入。

重试 `/compact`，或在检查任务状态后建立新会话。持久化、检查点激活和历史写入错误需要先处理文件权限、磁盘空间和会话归属，不能通过不断发送任务绕过。

## 搜索检查没有通过

确认模型使用 Responses 或 Anthropic Messages，并且端点实际支持服务端搜索。`/web-search check` 必须收到成功的搜索事件，只有文本回答会判定未执行搜索。自定义端点不因声明协议相同就具备搜索能力。
