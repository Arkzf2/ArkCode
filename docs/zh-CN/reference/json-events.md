# JSON 事件参考

[English](../../en/reference/json-events.md) | 简体中文 | [文档首页](../README.md)

`--json` 隐含 print。stdout 为 JSONL，每个非空行是一个对象，以 `type` 区分事件。这里记录 ArkCode `0.1.0` 的实际输出，没有独立协议版本号，也不等于透传全部 Pi 事件。

## 事件字段

| type | 字段 |
| --- | --- |
| `status` | model、thinking、cwd、permission、branch、context、state、queued、viewer；以及按状态出现的 sessionId、sessionName、backgroundSessions、executionBlocked、shellSessions、initializing、mcpServers、skills |
| `message` | role 为 user、assistant、info 或 error，text 为正文 |
| `assistant_delta` | text，为本次增量 |
| `assistant_end` | text，为该条回答的完整文本 |
| `reasoning` | id、text、active，仅有供应商提供时出现 |
| `tool` | id、name、text、state；可有 target、exitCode、diff |
| `approval` | request、decision；print 中 decision 为 once 或 deny |

tool.state 是 running、done 或 error，同一 id 可以有多次更新。text 是展示文本，不保证是对应工具的完整结构化结果。`assistant_end` 不应在已有 delta 后直接追加，否则会重复回答。

status.context 为 `{ "tokens": 数值, "contextWindow": 数值, "percent": 数值 }`，未知为 null。status.state 的 kind 为 idle、running、awaiting-approval 或 stopping。idle 包含 outcome，为 completed、failed、interrupted 或 null；其他状态包含运行 id、startedAt，审批状态另有 request。

approval.request 包含 id、tool、description、cwd，可有 invocation。文件、shell、shell_control 和 MCP 的 invocation 字段不同。解析器应根据 kind 判断，不能假设始终存在 command。

## 顺序与终止

一次运行可能包含多条 assistant 回答和多次工具调用。状态、工具与增量事件可能交错。审批事件在动作分派前产生；被拒绝的动作不会执行。错误可能作为 message、tool 或最终状态出现。

等待进程退出并检查[退出码](cli.md)，同时处理最终运行状态。没有独立的 `run_finished` 事件。启动和配置错误也可能只写入 stderr 并返回失败退出码，stdout 可以为空。

下面展示单条事件的形状，不构成完整流或固定时序：

```json
{"type":"assistant_delta","text":"项目入口位于 "}
```

```json
{"type":"assistant_end","text":"项目入口位于 src/cli.ts。"}
```

```json
{"type":"tool","id":"call_1","name":"read","text":"文件内容","state":"done"}
```

JSON 内容可能包含用户文本、工具参数和路径。隐藏的环境上下文不作为 UI 消息输出；JSON 不是原始模型请求的完整记录。
