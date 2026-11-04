# Use Skills

English | [简体中文](../../zh-CN/guides/skills.md) | [Docs home](../README.md)

## Install a Skill

User Skills live in `~/.agents/skills/NAME/SKILL.md`; trusted project Skills live in `.agents/skills/NAME/SKILL.md`. A minimal file looks like this:

```markdown
	---
	name: review-changes
	description: Check current changes for behavior regressions and missing verification.
	---

	Read the changes and their callers, then report findings with concrete evidence.
	For each finding, state the trigger, impact, and location.
```

After adding a Skill, run `/skills reload`. Open the List skills or Sources and diagnostics view in `/skills` to check the result. Project Skills require trust; `skills/` under the ArkCode configuration directory and `.pi/skills` do not participate in discovery.

## Select and invoke

Enter `@` to search files and enabled Skills, or `@skill:` to search Skills only. Selecting a Skill inserts `@skill:name`; it submits when you press Enter. You can also type:

```text
	/skill:review-changes review the current changes
```

One input can select multiple Skills. When you submit or queue, the selected bodies are fixed; later edits to disk files do not change the queued snapshot.

Ordinary requests give the model only the names, descriptions, and paths of Skills allowed for automatic selection; the model reads bodies on demand. With `disable-model-invocation: true`, the Skill is only available through explicit user selection.

## Enable, disable, and reload

In the Enable/Disable Skills view of `/skills`, type to filter, use arrow keys to move, Space or Enter to toggle, and Esc to return. Every toggle saves immediately.

You can also use `/skills enable NAME`, `/skills disable NAME`, `/skills list`, and `/skills reload`. Same-name entries must be enabled or disabled with the full `SKILL.md` path. When you disable the higher-priority entry, another enabled same-name entry may take effect.

Enable, disable, and reload require the current session to be idle with no unconsumed queue. Disabling affects new input and later catalogues; it does not delete historical bodies or queued snapshots. A viewer can only inspect.

For the full discovery scope, manifest constraints, and read boundaries, see the [Skills reference](../reference/skills.md).
