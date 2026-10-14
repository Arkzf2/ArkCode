# ArkCode 开发结构

Pi 管理模型请求、agent 循环、历史格式、压缩、MCP 协议和 CodeMode。ArkCode 管理工作区信任、权限、受管进程、会话所有权和终端交互。

| 路径 | 职责 |
| --- | --- |
| `src/cli.ts` | CLI 启动入口，构建后仍为 `dist/cli.js` |
| `src/app/` | 参数、宿主编排和 UI/权限事件类型 |
| `src/config/` | 用户设置、模型连接及 SDK 资源装配 |
| `src/context/` | 静态提示、项目指令、动态上下文、文件提及与压缩跟踪 |
| `src/integrations/mcp/` | 配置边界和官方 MCP 扩展的宿主适配 |
| `src/permissions/` | 三种权限策略、审批状态和 shell 风险分析 |
| `src/session/` | 工作区 writer 锁、会话检查与运行标记 |
| `src/tools/index.ts` | 六个 SDK 工具定义的宿主适配 |
| `src/tools/workspace.ts` | 路径、symlink、敏感目录和大小限制 |
| `src/tools/shell.ts` | 子进程树、取消和执行 receipt |
| `src/tools/output.ts` | 终端控制字符清理 |
| `src/tools/output-files.ts` | SDK 大结果文件的会话级精确只读授权 |
| `src/ui/` | TUI、补全、slash 命令目录及 Git 状态 |
| `scripts/pi-sdk-patch/` | 固定版本 SDK 补丁的声明、片段和校验清单 |
| `test/` | 真实 SDK 会话、本地 HTTP/stdio 服务、文件系统和 shell 回归 |

增加工具时，在 `src/tools/index.ts` 或对应集成模块定义能力，在宿主工具白名单中明确开放。审批放在实际执行边界，直接与 CodeMode 调用共用；不能仅通过 UI 或模型提示控制权限。当前审批 UI 支持单个待决请求，基础工具与 MCP 工具均使用 `sequential`。

MCP 的 `McpManager` 仅将 ArkCode 配置和权限接到 `createMcpExtension()`。它不创建 MCP client，不维护连接池，也不转换工具结果。SDK controller 负责状态、等待启动、按名称重载、取消和关闭。项目配置需经过工作区信任检查，自动批准规则只能来自用户配置。授权绑定配置、工具元数据和实际连接身份；等待授权期间发生变化时拒绝旧调用。

CodeMode 通过 SDK 的嵌套工具管线调用这些工具。它不会绕过白名单，也没有独立访问操作系统的接口。MCP resources 未接入逐服务审批，因此明确禁用；模型子调用同样禁用。

SDK 截断 MCP/Bash 输出时会保存临时文件。宿主只从这些工具的结果元数据登记文件，记录真实路径与文件身份，允许本会话的 Read 读取；Write/Edit 和其他工作区外文件仍被拒绝。文件被替换后授权失效，授权不随历史恢复。普通文件保留 2 MiB 上限，已登记的大结果文件允许读取最多 64 MiB；更大的结果应在 CodeMode 中先过滤。

`npm install` 会安装 SDK 补丁，`npm run check`、`npm test`、`npm run build` 会再次核对补丁。构建清理旧输出再编译，避免移动模块后发布遗留文件。发布包保留安装补丁和必要说明，不能使用忽略安装脚本的方式部署未经补丁的 SDK。

验证顺序：类型检查，相关行为测试，完整回归，构建及 CLI 冒烟。涉及 MCP 的改动还应检查冷启动、真实服务握手、工具目录更新、授权等待时的连接/schema 变化、中断和退出。测试不依赖远程模型；浏览器 OAuth 与不同操作系统的手工验证单独记录，不能由模拟服务测试替代。
