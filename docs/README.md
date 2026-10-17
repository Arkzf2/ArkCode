# ArkCode 文档

根目录 [README](../README.md) 保留安装、使用及配置入口。此目录保存 ArkCode 自身的架构、开发、实施记录和设计资料。

| 分类 | 入口 | 内容 |
| --- | --- | --- |
| 架构 | [源码结构](architecture/ARCHITECTURE.md)、[上下文机制](architecture/CONTEXT.md)、[Skills 机制](architecture/SKILLS.md) | 当前实现与模块职责 |
| 开发 | [Pi SDK 补丁维护](development/PI_SDK_PATCH.md) | 安装校验、宿主接口和 SDK 升级要求 |
| 实施与验证 | [验收记录](implementation/VERIFICATION.md)、[初期计划](implementation/PLAN.md) | 实施流程、验证结果和已知限制 |
| SDK 迁移 | [迁移计划](implementation/SDK_MIGRATION.md)、[决策记录](implementation/sdk-migration.tsv) | Pi 1.2.0 迁移过程 |
| 工具模式 | [工具调用模式与会话配置](implementation/TOOL_MODE_PLAN.md) | 非 MCP 三模式、并行审批、MCP 生效时机和会话继承规则 |
| MCP 历史 | [首期接入](implementation/mcp/INITIAL_IMPLEMENTATION.md)、[连接诊断](implementation/mcp/CONNECTION_DIAGNOSIS.md) | 历史方案和故障分析，不代表全部当前行为 |
| 产品设计 | [设计稿](arkcode-design/README.md)、[TUI 设计](arkcode-design/tui/README.md) | 原始提案、演示及截图 |
| 实现分析归档 | [提示词与工具](archive/prompt-tools/arkcode-analysis.md)、[六工具生命周期](archive/prompt-tools/ark-six-tools-lifecycle.md) | 固定历史版本的分析与提取结果 |

外部项目对照、功能调研和跨项目方案放在根目录 `research/`，按架构、提示词与工具、MCP/skills、TUI 分类。该目录由 Git 忽略，不属于发布包。

设计提案、实施记录和分析归档保留其原始版本背景，不代表当前全部行为。历史报告中的旧源码路径和行号按报告记录的提交解读，不自动映射到重构后的文件。npm 发布包只包含架构、SDK 补丁维护及验收文档；完整设计资料和归档在源码仓库中查看。

`implementation/sdk-migration.tsv` 保持原始追加式记录，其中旧路径表示当时的文件位置。本次归档将 `.audit/SDK_MIGRATION.md` 和 `.audit/sdk-migration.tsv` 移入 `docs/implementation/`，将根目录 `ARCHITECTURE.md`、`CONTEXT.md` 移入 `docs/architecture/`。历史日志及临时验证脚本仍位于忽略的 `.audit/runtime/`。
