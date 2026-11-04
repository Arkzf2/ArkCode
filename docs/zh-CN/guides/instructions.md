# 使用 AGENTS.md 设置工作规则

[English](../../en/guides/instructions.md) | 简体中文 | [文档首页](../README.md)

## 为项目创建规则

在工作区根目录创建 `AGENTS.md`，写入实际的构建命令、测试命令、代码约定和任务约束。例如：

```markdown
	# 项目规则

	修改前阅读相关模块。保持公共接口兼容。
	修改 TypeScript 后运行 npm run check。
	提交结果时说明实际运行的验证命令。
```

也可以在空闲会话运行 `/init`，让模型根据仓库生成规则。已有 `AGENTS.md` 时不会覆盖；生成文件经过正常工具审批，并需要你检查内容。

## 选择作用范围

全局规则放在 ArkCode 配置目录的 `AGENTS.md`，始终加载，不依赖项目信任。

可信项目会发现最近 Git 根到工作区的祖先 AGENTS.md，以及工作区子目录中的 AGENTS.md。没有 Git 根时，从 cwd 和它的子目录发现，不读取无关父目录。子目录规则带有对应路径范围。项目指令受 `projectDocMaxBytes` 总预算约束，默认 32768 字节；全局规则不占这项预算。

项目规则只有在信任工作区后才加载。不要把“存在 AGENTS.md”当成已经信任的依据。

## 更新规则

修改并保存后，ArkCode 在后续模型请求准备时检查变化，更新相关上下文。已经发送的请求不能追溯改变。压缩和恢复会重建当前指令，不使用历史旧规则覆盖磁盘上的当前规则。

可复用流程使用[Skills](skills.md)。配置位置和预算字段见[配置参考](../reference/configuration.md)，上下文组成见[上下文与压缩](../concepts/context-and-compaction.md)。
