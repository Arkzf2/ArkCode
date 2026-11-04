# 管理会话

[English](../../en/guides/sessions.md) | 简体中文 | [文档首页](../README.md)

## 新建和切换

输入 `/new` 创建独立会话。旧会话保留，运行中的模型请求、工具和队列继续执行。各会话拥有独立历史、草稿、审批、shell 和 MCP 连接。

输入 `/sessions`，或在空输入框按 Left，打开跨项目会话列表。方向键选择、Enter 打开，`/` 搜索，Tab 切换状态筛选，`g` 更改分组，`n` 在选中项目新建，Esc 返回。

后台会话需要审批时显示提示，切回后才展示审批面板。Ctrl+C 只中断当前会话；退出终端会停止本终端拥有的所有会话。

## 恢复历史

在目标项目中运行：

```powershell
	arkcode resume --last
	arkcode resume SESSION_ID
```

将 `SESSION_ID` 换成 `/status` 或列表显示的 ID。`resume --last` 选择当前工作区最近的会话；在 TUI 中可以通过 `/sessions` 跨项目选择。恢复显示当前分支完整历史，包括压缩前的消息，但不会重放历史工具、草稿或队列。

切换到未信任的项目需要重新选择信任级别。打开失败时，原会话和草稿会保留。

## 创建分支

运行 `arkcode fork SESSION_ID`，或在界面输入 `/fork` 为当前会话创建分支。`/fork ID` 选择当前项目的已保存会话。至少提交一次任务并保存历史后才能 fork。

分支复制起点的对话和工具策略，使用同一工作区，不建立 Git 分支或 worktree，也不回滚文件。并发修改同一文件需要自己协调。

## 处理只读 viewer

同一个 session 同时只有一个可写宿主。另一个终端打开它时进入 Read-only viewer，定期刷新已保存历史，不能提交任务、steer、改名或修改会话设置。

viewer 可以 `/new` 或 `/fork` 创建独立会话。原宿主退出后，在 viewer 的 `/sessions` 中重新打开该会话，重新尝试取得写入权。会话锁按 session ID 管理，换一个 `--home` 不会绕过锁。

Execution unconfirmed 和残留锁见[故障排查](../troubleshooting.md)。会话与单次运行的区别见[会话生命周期](../concepts/session-lifecycle.md)。
