# 完成第一次任务

[English](../en/quickstart.md) | 简体中文 | [文档首页](README.md)

这份指南带你从源码启动 ArkCode，连接模型，并完成一次只读项目检查。

## 安装并启动

先安装 Node.js 22.19 或更新版本。在源码仓库根目录执行：

```powershell
	npm install
	npm run build
	npm start
```

终端出现 ArkCode 输入界面。首次打开目录时选择是否信任项目。信任会允许加载项目指令、Skills 和 MCP 配置；项目 MCP 可能启动配置中的本地进程。具体范围见[权限与信任](guides/permissions.md)。

## 连接模型

在输入框运行 `/connect`，选择可用供应商和模型。使用已有凭据或供应商环境变量，也可以在隐藏输入框中填写 API key。成功后，底栏显示当前模型。

如果没有可用模型，按[模型配置](guides/models.md)设置凭据或自定义端点。模型需要支持 ArkCode 的工具调用。

## 提交任务

输入以下任务并按 Enter：

```text
	查看这个项目，说明入口文件和测试命令，先不要修改文件。
```

终端显示工具调用和回答。在 Always Ask 模式下，内建读取和搜索自动执行；其他动作可能显示审批面板。按 Esc 中断当前任务，已经发生的文件变更不会回滚。

输入 `/status` 查看模型、工作区、会话 ID、shell 和用量。保留会话 ID，后续可以恢复这段历史。

## 在自己的项目中使用

在 ArkCode 源码目录执行一次 `npm link`，然后切换到项目目录运行 `arkcode`，或明确指定目录：

```powershell
	arkcode -C "D:\my-project"
```

使用 `/exit` 退出。再次打开同一项目后执行 `arkcode resume --last`，继续最近的会话。完整行为见[会话管理](guides/sessions.md)。
