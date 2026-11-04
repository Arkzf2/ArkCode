# Complete your first task

English | [简体中文](../zh-CN/quickstart.md) | [Docs home](README.md)

This guide starts ArkCode from source, connects a model, and completes one read-only project inspection.

## Install and start

Install Node.js 22.19 or newer. From the repository root, run:

```powershell
	npm install
	npm run build
	npm start
```

The terminal shows the ArkCode composer. When you open a directory for the first time, choose whether to trust the project. Trust allows loading project instructions, Skills, and MCP configuration; project MCP may start local processes configured in the project. See [Permissions and trust](guides/permissions.md) for the exact scope.

## Connect a model

Run `/connect` in the composer, then choose an available provider and model. Use existing credentials or provider environment variables, or enter an API key in the masked input. After a successful connection, the status bar shows the current model.

If no model is available, configure credentials or a custom endpoint with [Model configuration](guides/models.md). The model must support ArkCode's tool calling.

## Submit a task

Enter the following task and press Enter:

```text
	Inspect this project, explain the entry file and test commands, and do not modify files.
```

The terminal shows tool calls and the answer. In Always Ask mode, built-in reads and searches run automatically; other actions may show an approval panel. Press Esc to interrupt the current task. File changes that already happened are not rolled back.

Run `/status` to view the model, workspace, session ID, shell, and usage. Keep the session ID; you can resume this history later.

## Use ArkCode in your own project

Run `npm link` once in the ArkCode source directory, then run `arkcode` from your project, or pass the directory explicitly:

```powershell
	arkcode -C "D:\my-project"
```

Exit with `/exit`. Open the same project again and run `arkcode resume --last` to continue the most recent session. See [Session management](guides/sessions.md) for the full behavior.
