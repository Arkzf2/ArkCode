# Set workspace rules with AGENTS.md

English | [简体中文](../../zh-CN/guides/instructions.md) | [Docs home](../README.md)

## Create rules for a project

Create `AGENTS.md` at the workspace root and write the actual build commands, test commands, code conventions, and task constraints. For example:

```markdown
	# Project rules

	Read related modules before making changes. Keep public interfaces compatible.
	Run npm run check after TypeScript changes.
	State the verification commands you actually ran with the result.
```

You can also run `/init` in an idle session and let the model generate rules from the repository. It does not overwrite an existing `AGENTS.md`. The generated file goes through normal tool approval and needs your review.

## Choose the scope

Put global rules in `AGENTS.md` under the ArkCode configuration directory. They always load and do not depend on project trust.

A trusted project discovers ancestor AGENTS.md files from the nearest Git root to the workspace, plus AGENTS.md files in workspace subdirectories. Without a Git root, discovery covers cwd and its subdirectories; unrelated parent directories are not read. Subdirectory rules carry their path scope. Project instructions are limited by the total `projectDocMaxBytes` budget, default 32768 bytes; global rules do not count against this budget.

Project rules load only after you trust the workspace. Having an `AGENTS.md` file is not evidence of trust.

## Update rules

After you modify and save the file, ArkCode checks for changes when preparing the next model request and updates the related context. A request that was already sent cannot be changed retroactively. Compaction and resume rebuild current instructions and do not let historical old rules override the current rules on disk.

For reusable workflows, use [Skills](skills.md). For config locations and budget fields, see the [Configuration reference](../reference/configuration.md); for context composition, see [Context and compaction](../concepts/context-and-compaction.md).
