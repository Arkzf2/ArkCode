# 在脚本中运行任务

[English](../../en/guides/scripting.md) | 简体中文 | [文档首页](../README.md)

## 执行单个任务

先配置凭据和默认模型，或传入 `--model`。`--print` 不打开交互界面：

```powershell
	arkcode --print "说明这个项目的入口和测试命令"
```

没有命令行提示时，可从 stdin 读取，输入上限 1 MiB：

```powershell
	Get-Content -Raw task.txt | arkcode --print
```

普通回答写入 stdout，说明和错误写入 stderr。精确处理输出时使用 JSON 事件，不解析终端显示文本。

## 处理审批

非交互模式默认拒绝需要审批的动作。可以用 `--approve` 明确允许本次运行中请求审批的动作：

```powershell
	arkcode --print --permissions always-ask --approve "修改测试并运行相关检查"
```

`--approve` 不改变权限配置，不取消文件保护、MCP 过滤或恢复限制。`--permissions never-ask` 不等待调用审批。差异见[权限与信任](permissions.md)。

自动化中可在确认项目配置可信后使用 `--trust`。启用的 MCP 必须完成启动，失败的服务器会阻止发送首轮请求。

## 消费 JSON 事件

```powershell
	arkcode --json --permissions always-ask "解释这个项目" > events.jsonl
```

`--json` 隐含 `--print`，stdout 每行一个 JSON 对象。按 `type` 处理增量、完整回答、工具、审批和状态，等待进程退出后判断运行结果。

事件没有独立版本号，当前记录 ArkCode `0.1.0` 的格式。assistant 消息完成或单个工具成功不代表整个运行成功。字段和退出码见[JSON 事件](../reference/json-events.md)与[CLI 参考](../reference/cli.md)。
