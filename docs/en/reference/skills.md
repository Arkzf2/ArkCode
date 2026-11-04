# Skills reference

English | [简体中文](../../zh-CN/reference/skills.md) | [Docs home](../README.md)

## Manifest

A Skill is a directory containing `SKILL.md`. The file uses YAML frontmatter for metadata and Markdown for the workflow body.

| Field | Meaning |
| --- | --- |
| `name` | Invocation name, matching the directory name, using a mention-safe name |
| `description` | Purpose text used for the catalog and automatic selection |
| `disable-model-invocation` | Optional boolean; true excludes the Skill from the model's automatic catalog, users can still select it explicitly |

Format and parsing diagnostics are shown in `/skills list` or Sources and diagnostics. A single manifest over 2 MiB is skipped. One input may explicitly select up to 8 different Skills. The body and reference files each have a 2 MiB limit.

## Discovery rules

| Source | Scope and priority |
| --- | --- |
| Project | `.agents/skills` at each level from the nearest Git root to cwd; nearer takes priority; requires trust |
| User | `~/.agents/skills`, after project entries, independent of ArkCode home |

`.git` can be a directory or a worktree file. Without a Git root, only project sources under cwd are read. ArkCode does not recurse workspace subdirectories for new sources, and does not read `.pi/skills`, `~/.arkcode/skills`, plugins, or package resources.

Discovery recurses inside each source looking for manifests. It stops at a Skill's subdirectories once SKILL.md is found. Dot directories and node_modules are skipped; real paths prevent link cycles; the limit is 8 levels and 2000 directories per source. The same actual manifest is registered once.

Same-name entries in different files keep all management entries. The first enabled entry can be invoked; the rest are shadowed. When the first entry is disabled, the next enabled entry takes effect. Enabling or disabling a same-name entry requires the full path.

## Enable and disable files

`<home>/skills.json` uses strict JSON and stores actual manifest paths:

```json
{
  "version": 1,
  "disabledPaths": []
}
```

Sessions sharing one home share preferences, refreshed at requests, input, and management pages. There is no watcher or cross-process transaction. Rescan and enable or disable require idle, no unconsumed queue, and not being a viewer or recovery-restricted state.

## Body and reference files

Ordinary requests provide only names, descriptions, and paths; the model loads bodies on demand through read. Explicit `/skill:name` or `@skill:name` loads a body snapshot at submit or queue time. A mention in code snippets does not trigger loading; repeated mentions load once; unknown or disabled entries report an error.

The root of a discovered and enabled Skill allows read-only access, including user Skills outside cwd. Real paths and symlinks cannot cross the Skill root; `.git`, `.arkcode`, and `.env*` are not exposed. A Skill grants no shell or MCP permissions.

Disabling does not delete historical bodies or queued snapshots. Compaction does not put previously loaded bodies back into the checkpoint; it keeps user-selected text and the current directory, and the body can be re-read when needed. For operations, see the [Skills guide](../guides/skills.md).
