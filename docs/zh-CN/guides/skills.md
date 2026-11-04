# 使用 Skills

[English](../../en/guides/skills.md) | 简体中文 | [文档首页](../README.md)

## 安装一个 Skill

用户 Skill 放在 `~/.agents/skills/NAME/SKILL.md`，可信项目 Skill 放在 `.agents/skills/NAME/SKILL.md`。最小文件如下：

```markdown
	---
	name: review-changes
	description: 检查当前改动中的行为回归和遗漏验证。
	---

	先阅读改动及相关调用者，报告有具体证据的问题。
	每个问题注明触发条件、影响和位置。
```

新增后运行 `/skills reload`。打开 `/skills` 的 List skills 或 Sources and diagnostics 检查结果。项目 Skill 需要信任；ArkCode 配置目录下的 `skills/` 和 `.pi/skills` 不参与发现。

## 选择和调用

输入 `@` 搜索文件和已启用 Skills，输入 `@skill:` 只搜索 Skills。选择后插入 `@skill:name`，按 Enter 才提交。也可以输入：

```text
	/skill:review-changes 检查当前改动
```

一条输入可以选择多个 Skill。提交或入队时会固定所选正文，后续修改磁盘文件不会改写已排队快照。

普通请求只向模型提供允许自动选择的 Skill 名称、描述和路径，模型按需读取正文。设置 `disable-model-invocation: true` 后，Skill 只供用户明确选择。

## 启停与刷新

在 `/skills` 的 Enable/Disable Skills 中，输入文本过滤，方向键选择，Space 或 Enter 切换，Esc 返回。每次切换立即保存。

也可使用 `/skills enable NAME`、`/skills disable NAME`、`/skills list` 和 `/skills reload`。同名项必须用完整 `SKILL.md` 路径启停。禁用高优先级项后，另一个仍启用的同名项可能生效。

启停和 reload 需要当前会话空闲且没有待消费队列。禁用影响新输入和后续目录，不删除历史正文或入队快照。viewer 只能查看。

完整发现范围、manifest 约束和读取边界见[Skills 参考](../reference/skills.md)。
