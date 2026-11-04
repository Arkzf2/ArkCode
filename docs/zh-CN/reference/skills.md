# Skills 参考

[English](../../en/reference/skills.md) | 简体中文 | [文档首页](../README.md)

## manifest

Skill 是包含 `SKILL.md` 的目录。文件用 YAML frontmatter 提供元信息，正文为 Markdown 工作流。

| 字段 | 含义 |
| --- | --- |
| `name` | 调用名称，与目录命名保持一致，使用可用于 mention 的名称 |
| `description` | 用于目录和自动选择的用途说明 |
| `disable-model-invocation` | 可选布尔，true 时从模型自动目录排除，用户仍可显式选择 |

格式和解析诊断在 `/skills list` 或 Sources and diagnostics 中显示。单个 manifest 超过 2 MiB 会跳过。一条输入最多明确选择 8 个不同 Skill。正文和参考文件各自上限为 2 MiB。

## 发现规则

| 来源 | 范围与优先级 |
| --- | --- |
| 项目 | 最近 Git 根到 cwd 各级 `.agents/skills`，越近越优先，需要信任 |
| 用户 | `~/.agents/skills`，在项目项之后，独立于 ArkCode home |

`.git` 可以是目录或 worktree 文件。没有 Git 根时只读取 cwd 下的项目来源。不递归 workspace 子目录寻找新的来源，不读取 `.pi/skills`、`~/.arkcode/skills`、插件和包资源。

每个来源内部递归寻找 manifest，遇到 SKILL.md 后不再进入该 Skill 的子目录。跳过点目录和 node_modules，通过真实路径防止链接循环，最多 8 层和每来源 2000 个目录。同一实际 manifest 只登记一次。

同名不同文件保留全部管理项，第一个启用项可调用，其余为 shadowed。禁用首项后下一个启用项生效；同名启停必须指定完整路径。

## 启停文件

`<home>/skills.json` 使用严格 JSON，按实际 manifest 路径保存：

```json
{
  "version": 1,
  "disabledPaths": []
}
```

同一 home 的会话共享偏好，在请求、输入和管理页时刷新，没有 watcher 或跨进程事务。重扫及启停要求空闲、无待消费队列，并且不是 viewer 或恢复受限状态。

## 正文与参考文件

普通请求只提供名称、描述和路径；模型通过 read 按需加载。显式 `/skill:name` 或 `@skill:name` 在提交或入队时加载正文快照。代码片段中的 mention 不触发加载，重复提及只加载一次，未知或禁用项会报错。

已发现且启用的 Skill 根目录允许 read 只读访问，包括 cwd 外的用户 Skill。真实路径和 symlink 不能越过 Skill 根，`.git`、`.arkcode` 和 `.env*` 不开放。Skill 不授予 shell 或 MCP 权限。

禁用不删除历史正文与队列快照。compact 不把历史加载过的正文重新放入检查点；保留用户选择文本和当前目录，可在需要时重新读取。操作见[Skills 指南](../guides/skills.md)。
