# 使用 Web Search

[English](../../en/guides/web-search.md) | 简体中文 | [文档首页](../README.md)

## 检查可用性

运行 `/web-search status` 查看当前模型状态。搜索需要 OpenAI Responses 或 Anthropic Messages 协议，以及支持服务端搜索的端点。普通 Chat Completions 不声明 `WebSearch`。

运行 `/web-search check` 执行真实搜索，确认端点确实调用了搜索工具。该操作会产生模型用量，并可能产生供应商搜索费用。普通文本回答不能证明搜索能力可用。

端点明确返回不支持后，当前能力记录会停止提供工具。更换模型、端点或凭据后重新检查。

## 开启并提交任务

`/web-search on` 开启，`/web-search off` 关闭。选择保存在配置中，从下一次任务生效。然后提交需要外部信息的任务：

```text
	搜索这个库的官方迁移说明，给出来源并说明与当前项目的关系。
```

搜索使用独立模型请求，只提交查询，不发送当前对话和本地文件。摘要和链接返回当前会话，仍使用所选模型的凭据和端点。

`WebSearch` 遵循[工具模式](../reference/tool-modes.md)。Always Ask 需要审批，Ask When Needed 和 Never Ask 自动允许；手动 `/web-search check` 是用户明确发起的检查。

## 查看用量

`/status` 中 `Usage.webSearch` 显示请求次数、搜索次数、费用估算和费用未知请求。供应商返回的模型 usage 纳入累计统计，搜索费用与模型 `cost` 分开。

官方端点使用 ArkCode 内置费率估算，代理或自定义端点显示未知。估算不是账单，以供应商实际计费为准。网络中断且没有收到 usage 时无法补算，部分废弃压缩摘要尝试也未纳入完整统计。
