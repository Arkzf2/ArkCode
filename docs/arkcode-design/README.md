# ArkCode 产品与架构设计

直接打开 [arkcode-design.html](arkcode-design.html)。这一个 HTML 已嵌入样式、脚本、SVG 和图标，离线可读；源码证据链接需要联网。页面是设计提案与交互演示，尚未实现 ArkCode 应用。

方案采用 pi-coding-agent SDK、一个活动工作区和一个受监督执行进程。Pi 拥有会话历史，ArkCode 拥有运行准入、工具授权、停止、变更审阅和验证证据。Goal、多代理、后台自治及复杂扩展留待后续。

构建源为 body.html、style.css、interactions.js、review-note.html 和 research/sdk-evidence.json。在本目录执行 `python build.py` 重新生成页面和验证清单；构建器依赖 E:/Github Programs 下的固定源码提交及 ../../research/architecture/harness-report/sources.json。阅读生成的 HTML 不需要这些依赖。用 `node --check interactions.js` 检查脚本语法。

validation.json 保存源码与页面检查结果；assets 保存实际浏览器截图；research/final-audit.md 保存独立审阅结果；decisions.tsv 是追加式决策记录。25 处证据来自固定提交，不能解读为未来 SDK 版本的保证。跨家族 Kimi 审阅未通过认证，同家族独立审阅已完成。

设计依据 Model the Domain 将运行、批准与恢复编码为明确状态和所有权；依据 Prove It Works 检查真实页面并保留可重复的源码验证脚本。Windows 命令进程树清理、模型执行与崩溃恢复仍需在应用实施时验收。
