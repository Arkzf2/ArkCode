# ArkCode TUI 产品与交互规格

当前版本为 [arkcode-tui.html](arkcode-tui.html)，revision 03。本地预览：http://127.0.0.1:8766/tui/arkcode-tui.html 。

规格是独立的静态 HTML，内嵌样式和架构 SVG，无脚本、外部字体或图片依赖。说明使用中文，TUI 系统文案使用英文。用户与模型的对话不强制英语。

[arkcode-tui-demo.html](arkcode-tui-demo.html) 是渲染与交互 demo。它内嵌脚本和依赖，可独立打开，提供编码、审批、失败、Markdown 四个场景。内容全部是固定样例，不连接模型或执行命令。规格中的“渲染”章节解释设计与源码依据。

## 当前设计

产品行为以 Codex 为主：Read Only / Ask for approval（Auto 语义）/ Full Access，工作区普通命令在沙箱内自动执行，越界才申请额外权限。Enter 在运行中交付 steer 输入，Tab 排队下一轮；/diff、/resume、/review、/fork 与快捷键保持熟悉的含义。

底座仍是 pi-coding-agent SDK 和 Pi SessionManager。宿主负责输入交付、授权、受管进程与工作区单写者。真实 OS 沙箱是首版必要条件，尚未实现。Goal、多代理、持久 Plan、插件与学习式记忆继续后置。

## 文件与历史

| 文件 | 用途 |
| --- | --- |
| `arkcode-tui.html` | 当前 v3 产品规格，直接编辑，无需构建 |
| `arkcode-tui-demo.html` | 单文件交互 demo，固定场景数据 |
| `demo/` / `build-demo.mjs` | demo 源文件、内嵌依赖与构建器；运行 `node build-demo.mjs` |
| `rendering-validation.json` | 渲染 demo 的浏览器检查与限制 |
| `validation-v3.json` | 当前静态页面检查与验证边界 |
| `assets/tui-v3-*.png` | 当前页面截图 |
| `arkcode-tui-v2.html` | 历史交互原型，其旧权限与输入规则已被替代 |
| `body.html` / `style.css` / `product.json` / `scenes.json` / `interactions.js` | 历史 v2 的生成源 |
| `build.mjs` | 仅重建 v2；不会覆盖当前 v3 |
| `sources.json` / `research/*.md` | 之前的固定源码调查与引用记录 |
| `validation.json` / `browser-validation.json` / `review-validation.json` | 历史 v2 验证，不能证明 v3 行为 |
| `decisions.tsv` | 历史决策记录，最新行为以当前页面为准 |

## 验证边界

v3 交付的是设计规格，新增渲染 demo 使用固定事件驱动交互。未实现原生 CLI/TUI，未调用模型或执行工具。页面检查覆盖章节锚点、资源自包含、英文样稿、桌面显示及一次窄屏适配检查。原生 IME、快捷键、输入队列、沙箱隔离、进程树停止与恢复仍需实际产品验收。

本地 HTTP 服务用于浏览器预览。HTML 不依赖服务逻辑；参考资料链接需要网络。
