const scenarios = {
  working: {
    state: '正在修改', tone: '',
    chat: '我会先检查提交处理和相关测试，再补上防重复提交逻辑。README.md 中已有的修改会保留。',
    tool: '<div class="tool-block"><div class="tool-line"><span>已读取 · src/checkout.ts</span><span>完成</span></div><div class="tool-line"><span>正在编辑 · test/checkout.test.ts</span><span>进行中</span></div></div>',
    extra: '', evidence: '尚未执行验证', warning: true,
    review: '运行前已有的 README 修改单独标记。右侧差异来自演示中的文件变化。',
    title: '用户知道当前动作，也保留停止入口。',
    product: '会话中用简短动作说明进度，详细参数和输出可展开。运行中输入只作为草稿保存。',
    owner: '运行控制映射 SDK 事件',
    contract: '一次 run 包含多个模型回合。工具执行串行，设置保持固定。收到工具事件更新界面，不由模型文字推断是否执行。',
    composer: '运行中可编辑下一条草稿', action: '停止任务', next: 'stopped'
  },
  approval: {
    state: '等待批准', tone: 'amber',
    chat: '修改已写入工作目录。接下来运行结账模块测试，需要你允许本次命令。',
    tool: '<div class="approval-box"><strong>运行相关测试</strong><p><code>npm test -- checkout</code></p><p>目录 · D:\\checkout-web<br>Shell · PowerShell</p><p>在你的电脑上执行，具有当前用户权限。</p><div class="approval-actions"><button type="button" class="button small primary" id="demo-allow">允许这一次</button><button type="button" class="button small" id="demo-reject">拒绝</button></div></div>',
    extra: '', evidence: '等待命令批准', warning: true,
    review: '文件已修改。批准只关联这一次工具调用，不能放行其他命令或新一轮任务。',
    title: '批准卡说明要执行什么。',
    product: '显示最终命令、工作目录和执行权限。拒绝会成为明确的工具结果，文件修改仍然保留。',
    owner: '审批 broker 持有等待与有效性',
    contract: '审批绑定 epoch、runId、toolCallId 和参数摘要。停止时先撤销等待；迟到的批准不能恢复执行。',
    composer: '可保留草稿，也可以停止整个任务', action: '停止任务', next: 'stopped'
  },
  denied: {
    state: '验证未执行', tone: 'amber',
    chat: '你拒绝了本次测试命令。修改保留在工作目录中，本次没有测试通过的证据。你可以审阅差异，或继续给出指令。',
    tool: '<div class="tool-block"><div class="tool-line"><span>npm test -- checkout</span><span>已拒绝 · 未执行</span></div></div>',
    extra: '', evidence: '未执行 · 批准被拒绝', warning: true,
    review: '拒绝命令不回滚文件。本场景演示模型接受拒绝并结束回复；实际运行仍须等 SDK settle。',
    title: '拒绝不会变成虚假的验证通过。',
    product: '结果说明文件已经改变，同时说明没有执行测试。一次拒绝不会自动变成更宽的授权。',
    owner: '拒绝结果与运行终态分开',
    contract: 'broker 返回拒绝，SDK 可让模型选择其他办法。UI 保持运行状态直到 SDK settle，不能在点击拒绝时提前释放运行槽。',
    composer: '说明接下来需要做什么', action: '回到批准示例', next: 'approval'
  },
  failed: {
    state: '需要继续处理', tone: 'red',
    chat: '防重复提交逻辑已修改，但失败后重新提交的测试没有通过。当前补丁还不能算完成，需要检查 submitting 的复位路径。',
    tool: '<div class="tool-block"><div class="tool-line"><code>npm test -- checkout</code><span>exit 1</span></div><p style="margin:8px 0 0">失败 · 重试提交时按钮仍处于禁用状态</p></div>',
    extra: '', evidence: '测试失败 · exit 1', warning: true,
    review: '这是一次已结束的示例运行。失败输出与已有差异一起保留，用户可以继续修复或自行接手。',
    title: '失败有具体证据和下一步。',
    product: '测试失败与文件修改同时可见。用户不用从长篇回复中猜测任务是否成功。',
    owner: '审阅模块记录命令事实',
    contract: '失败依据退出码和输出；模型补充解释。运行结束与需求满足是两件事，SDK settle 不会自动生成“验证通过”。',
    composer: '继续说明需要修复的部分', action: '继续修复示例', next: 'working'
  },
  done: {
    state: '本次运行结束', tone: 'green',
    chat: '已补上重复提交保护和失败后的状态复位，并增加相应测试。结账模块测试通过。README.md 的原有修改已保留。',
    tool: '<div class="tool-block"><div class="tool-line"><code>npm test -- checkout</code><span>exit 0</span></div><p style="margin:8px 0 0">结账模块 · 12 项测试通过</p></div>',
    extra: '<p class="fine">验证范围为结账模块，未运行完整端到端测试。</p>',
    evidence: '结账模块测试通过 · exit 0', warning: false,
    review: '文件已在工作目录中。审阅差异不会再次应用补丁。之后若文件变化，测试记录标为可能过期。',
    title: '交付改动、验证范围和剩余事项。',
    product: '用户可以打开文件、继续对话，或在自己的编辑器和 Git 工作流中接手。',
    owner: 'SDK settle + 实际验证记录',
    contract: '在 SDK 自动续跑结束、工具清理完成后记录结果。测试数字是本页演示数据，产品中的数字必须来自实际执行。',
    composer: '继续这个会话，或开始新任务', action: '重新体验任务', next: 'working'
  },
  stopped: {
    state: '已停止', tone: 'gray',
    chat: '本次运行已停止。已经写入的文件保持现状；尚未执行的测试没有运行。请检查右侧差异。',
    tool: '<div class="tool-block"><div class="tool-line"><span>待审批请求</span><span>已撤销</span></div><div class="tool-line"><span>SDK 与受管命令</span><span>已确认空闲</span></div></div>',
    extra: '<p class="fine">这里演示确认停止后的状态。未确认退出时必须继续显示“停止中”或“停止未确认”。</p>',
    evidence: '未验证 · 运行已停止', warning: true,
    review: '停止只控制后续执行，不撤回已经完成的文件写入，也不伪造命令执行结果。',
    title: '停止有执行过程，也有确定的结束条件。',
    product: '立即显示正在停止，先取消审批，再等待工具清理。确认后才允许新的编码任务。',
    owner: '宿主监督 + 运行控制共同收敛',
    contract: 'abort 不会替宿主撤销审批或自动清队列。进程树未确认退出时保持工作区占用，避免新任务与旧命令并发写入。',
    composer: '检查改动后，输入新的指令', action: '查看重启恢复', next: 'recovered'
  },
  recovered: {
    state: '上次运行中断', tone: 'amber',
    chat: '已打开这个会话的已保存记录。上次运行意外中断，部分命令结果无法确认。当前尚未确认旧命令已退出，执行入口保持锁定。请先检查工作目录变化。',
    tool: '<div class="tool-block"><div class="tool-line"><code>npm test -- checkout</code><span>结果未知</span></div><p style="margin:8px 0 0">旧进程退出尚未确认，暂不接受新运行。旧批准失效，命令未自动重跑。</p></div>',
    extra: '', evidence: '结果未知 · 需要检查', warning: true,
    review: '以当前文件为准。sidecar 与 Pi 历史不能共同证明命令成功时，明确保留未知状态。',
    title: '恢复记录后，先确认旧执行已停止。',
    product: '展示保存到哪一步、当前文件变化和未知操作。旧命令状态不明时只能查看，确认退出后才接受新任务。',
    owner: 'Pi 恢复对话，ArkCode 校准运行收据',
    contract: '重启产生新 epoch。须确认上一实例的受管命令退出，不能仅凭旧 worker 退出解锁。中断任务不会重放 shell 或沿用旧批准。这是历史恢复，不是 durable 的执行重放。',
    composer: '旧命令退出未确认，执行已锁定', action: '查看确认停止后的示例', next: 'stopped'
  }
};
const layers = {
  ui: {title:'只表达意图与呈现事实',path:'src/ui/',copy:'React 消费命令响应、快照和增量事件。模型输出、工具输出和文件内容都当作数据渲染。界面没有 Node 权限，不能直接读文件、启动命令或取得已保存的密钥。UI 重载后向宿主重新获取快照。'},
  desktop: {title:'让本地应用可以被控制',path:'src/desktop/',copy:'管理窗口、单实例、目录选择、凭据和一个执行进程。保留最后已知的界面快照，执行进程失联时停止接受新的写入任务。强制结束执行进程后仍须确认其命令进程树，不能把 worker 退出等同于所有副作用停止。'},
  runtime: {title:'拥有 ArkCode 的产品规则',path:'src/worker/',copy:'在一处完成输入去重、工作区准入、配置固定、批准、停止和 SDK 事件映射。审阅模块生成文件与命令证据。内部按 sessions、approvals、workspace、review 分模块，先留在一个应用中，不建立第二个 Agent 循环。'},
  sdk: {title:'拥有完整的 coding 会话',path:'pi-coding-agent SDK',copy:'AgentSession 负责模型与工具循环、队列、压缩、重试和扩展运行时。SessionManager 拥有会话树与最终模型上下文。ArkCode 显式配置资源和工具，遵守生命周期，使用 agent_settled 判断 SDK 自动续跑已结束。'}
};
const $ = (id) => document.getElementById(id);
let selectedScenario = 'working';
function showScenario(key) {
  const s = scenarios[key];
  selectedScenario = key;
  document.querySelectorAll('[data-scenario]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.scenario === key)));
  $('demo-state').textContent = s.state;
  $('demo-state').className = 'pill ' + s.tone;
  $('demo-chat').textContent = s.chat;
  $('demo-tool').innerHTML = s.tool;
  $('demo-extra').innerHTML = s.extra;
  $('demo-evidence').textContent = s.evidence;
  $('demo-evidence').className = 'evidence-badge' + (s.warning ? ' warning' : '');
  $('demo-review-note').textContent = s.review;
  $('scenario-title').textContent = s.title;
  $('scenario-product').textContent = s.product;
  $('scenario-owner').textContent = s.owner;
  $('scenario-contract').textContent = s.contract;
  $('demo-composer').textContent = s.composer;
  $('demo-action').textContent = s.action;
}
document.querySelectorAll('[data-scenario]').forEach((button) => button.addEventListener('click', () => showScenario(button.dataset.scenario)));
$('demo-action').addEventListener('click', () => showScenario(scenarios[selectedScenario].next));
$('demo-tool').addEventListener('click', (event) => {
  if (event.target.closest('#demo-allow')) showScenario('failed');
  if (event.target.closest('#demo-reject')) showScenario('denied');
});
function showLayer(key) {
  const layer = layers[key];
  document.querySelectorAll('[data-layer]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.layer === key)));
  $('layer-title').textContent = layer.title;
  $('layer-path').textContent = layer.path;
  $('layer-copy').textContent = layer.copy;
}
document.querySelectorAll('[data-layer]').forEach((button) => button.addEventListener('click', () => showLayer(button.dataset.layer)));
const sources = [...document.querySelectorAll('.source')];
function filterSources() {
  const query = $('source-search').value.toLocaleLowerCase().trim();
  let count = 0;
  sources.forEach((source) => {
    source.hidden = !source.textContent.toLocaleLowerCase().includes(query);
    if (!source.hidden) count++;
  });
  $('source-count').textContent = count + ' / ' + sources.length;
  $('source-empty').hidden = count !== 0;
}
$('source-search').addEventListener('input', filterSources);
document.querySelectorAll('[data-print]').forEach((button) => button.addEventListener('click', () => window.print()));
let openedForPrint = [];
window.addEventListener('beforeprint', () => {
  openedForPrint = [...document.querySelectorAll('details:not([open])')];
  openedForPrint.forEach((detail) => detail.open = true);
});
window.addEventListener('afterprint', () => openedForPrint.forEach((detail) => detail.open = false));
const chapters = [...document.querySelectorAll('.chapter[id]')];
function updateReadingPosition() {
  const total = document.documentElement.scrollHeight - innerHeight;
  document.querySelector('.reading-progress').style.width = (total > 0 ? Math.min(100, Math.max(0, scrollY / total * 100)) : 0) + '%';
  let current = 'overview';
  chapters.forEach((chapter) => { if (chapter.getBoundingClientRect().top < 160) current = chapter.id; });
  document.querySelectorAll('.topnav a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#' + current));
}
window.addEventListener('scroll', updateReadingPosition, {passive:true});
showScenario('working');
showLayer('runtime');
filterSources();
updateReadingPosition();
