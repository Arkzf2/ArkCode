const $ = id => document.getElementById(id);
const e = text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const isActive = () => ['running','approval','stopping','compacting'].includes(state.phase);
const state = {scene:'ready',transcriptScene:'ready',phase:'idle',panel:null,menuIndex:0,query:'',draft:'',task:'修复结账表单重复提交，保留 README.md 中已有修改，并补相关测试。',model:'model-pro · medium',mode:'编码',runMode:'编码',check:'none',file:'src/checkout.ts',scope:'run',detail:null,paletteClosed:null,exitArmedAt:0};
const files = ['src/checkout.ts','test/checkout.test.ts','README.md'];
function feedback(text){$('demo-feedback').textContent=text;}
function commandBlockReason(command){
  const base=command.name.split(' ')[0];
  if(isActive()&&!command.active)return '当前运行中，先停止或等待结束';
  if(state.phase==='locked'&&!PRODUCT.lockedCommands.includes(base))return '当前仅查看，工作区执行占用未解除';
  return '';
}
function transcript(){
  const scene=state.transcriptScene;
  const task='<p class="user-line">'+e(state.task)+'</p>';
  if(['ready','setup'].includes(scene))return '<p><span class="term-teal">项目就绪</span> · D:\\checkout-web</p><p class="term-dim">README.md 已有修改。'+(scene==='setup'?'尚未配置模型。':'当前目录模式 · '+e(state.mode))+'</p><p>› 描述任务，或输入 / 查看本地命令。</p>';
  if(scene==='error')return task+'<p class="term-red">× API 来源拒绝请求 · 401</p><p>检查端点与凭据。任务文字保留，未启动工具。</p>';
  if(['recovered','locked'].includes(scene))return task+'<p class="term-amber">! '+(scene==='locked'?'另一终端持有工作区写入占用。':'上次运行中断，部分命令结果未知。')+'</p><p>可以查看记录与当前文件。执行入口保持锁定。</p>';
  if(scene==='compacting')return '<p>正在整理当前会话的有效模型上下文。</p><p class="term-dim">本地历史保留。新任务暂不接受，Ctrl+C 可停止。</p>';
  if(['reading','readresult'].includes(scene)||(['stopping','stopped'].includes(scene)&&state.runMode==='只读'))return task+'<div class="tool-line">✓ read · src/checkout.ts</div><div class="tool-line">✓ search · submitting</div><p>'+(scene==='reading'?'正在分析重复提交路径。':scene==='readresult'?'建议提交前检查 submitting，并在 finally 中复位。未写入文件，未执行测试。':'只读运行'+(scene==='stopped'?'已确认停止。':'正在停止。'))+'</p>';
  let result=task+'<p>先检查提交处理与相关测试，再补重复提交保护。</p><div class="tool-line">✓ read · src/checkout.ts</div><div class="tool-line">✓ read · test/checkout.test.ts</div>';
  result+='<div class="tool-line">'+(scene==='working'?'… edit':'✓ edit')+' · src/checkout.ts · +8 / -2</div>';
  if(scene==='verifying')result+='<div class="tool-line">… shell · npm test -- checkout</div><div class="tool-line term-dim">运行中 · 正在收集输出</div>';
  if(scene==='passed')result+='<div class="result-block"><p><span class="term-teal">✓ 结账模块验证通过 · exit 0</span></p><p>已补上保护和失败复位。未运行端到端测试。</p><p class="term-dim">/changes 查看改动 · /checks 查看证据</p></div>';
  if(scene==='failed'||scene==='tools')result+='<div class="result-block"><p class="term-red">× 测试失败 · exit 1</p><p>重试提交时按钮仍禁用，需检查复位路径。</p><p class="term-dim">改动保留。/checks 查看输出</p></div>';
  if(scene==='denied')result+='<div class="result-block"><p class="term-amber">! 测试未执行 · 批准已拒绝</p><p>文件修改保留，目前没有测试通过证据。</p></div>';
  if(['stopping','stopped'].includes(scene))result+='<p class="term-amber">待审批已撤销。'+(scene==='stopped'?'SDK 与命令已确认退出。':'SDK 与命令仍在清理。')+'</p><p class="term-dim">已写入文件不回滚，未发送文字仍是草稿。</p>';
  return result;
}
function choices(){
  if(state.panel==='approval')return [{name:'拒绝这次',value:'deny',detail:'命令不执行，模型收到拒绝结果'},{name:'允许这次',value:'allow',detail:'只允许 shell #t17 的最终参数'},{name:'停止整个任务',value:'stop',detail:'撤销审批，等待执行清理'}];
  if(['help','palette'].includes(state.panel))return PRODUCT.commands.filter(c=>(c.name+' '+c.purpose).toLowerCase().includes(state.query.toLowerCase())).map(c=>{const reason=commandBlockReason(c);return {name:c.name,value:c.name.split(' ')[0],detail:c.purpose+(reason?' · '+reason:state.phase==='locked'&&PRODUCT.lockedViewOnly.includes(c.name.split(' ')[0])?' · 仅浏览，不保存':''),disabled:!!reason};});
  if(state.panel==='model')return [{name:'model-pro · medium',value:'model-pro · medium',detail:'已配置 provider · 支持推理等级'},{name:'model-fast',value:'model-fast',detail:'已配置 provider · 无推理等级'}];
  if(state.panel==='permissions')return [{name:'只读',value:'只读',detail:'读/搜索，无 shell 和写入工具'},{name:'编码',value:'编码',detail:'本次任务允许目录内编辑，shell 逐次批准'}];
  if(state.panel==='sessions')return [{name:'修复重复提交',value:'passed',detail:'今天 09:42 · 已保存 · 验证通过'},{name:'重试提交失败',value:'recovered',detail:'昨天 16:10 · 上次中断，旧执行须检查'}].filter(x=>x.name.includes(state.query));
  if(state.panel==='files')return files.filter(x=>x.toLowerCase().includes(state.query.toLowerCase())).map(name=>({name,value:name,detail:'工作区文件 · 提交时重新校验'}));
  if(state.panel==='changes')return (state.runMode==='只读'?(state.scope==='run'?[]:['README.md']):files).map(name=>({name,value:name,detail:name==='README.md'?(state.scope==='run'?'运行前已有 · 本次无新增变化':'unstaged · 用户原有修改'):'修改 · +8 / -2 · 来源可能混合'}));
  return [];
}
function renderPanel(){
  const panel=$('demo-panel');
  panel.hidden=!state.panel;
  panel.className='terminal-panel'+(state.panel==='approval'?' approval-panel':'');
  if(!state.panel){panel.innerHTML='';return;}
  const titles={approval:'等待批准 · shell #t17',model:'选择已配置模型',permissions:'选择后续任务能力',sessions:'当前目录会话',changes:'查看文件差异',context:'当前上下文来源',tools:'工具输出 · shell #t17',help:'本地命令与帮助',palette:'本地命令',files:'工作区文件',provider:'API 来源 · 演示配置',settings:'本地设置',checks:'验证记录',exit:'停止并退出？',compact:'压缩当前上下文？',export:'导出会话 · 规格预览',copy:'复制完整回复 · 规格预览',open:'打开文件 · 规格预览',rename:'会话命名 · 规格预览',status:'本地运行状态'};
  let html='<div class="panel-title">'+e(titles[state.panel]||'本地操作')+'</div>';
  if(state.panel==='approval')html+='<dl class="approval-facts"><dt>命令</dt><dd>npm test -- checkout</dd><dt>目录</dt><dd>D:\\checkout-web</dd><dt>Shell</dt><dd>PowerShell · C:\\Program Files\\PowerShell\\7\\pwsh.exe</dd><dt>范围</dt><dd>仅这一次；以当前用户权限执行</dd></dl>';
  if(state.panel==='changes'){
    html+='<p class="panel-note">'+(state.scope==='run'?'运行前基线 → 当前文件 · 来源可能混合':'Git 工作目录全量 · staged/unstaged/untracked 分组')+'</p><div class="panel-actions"><button type="button" data-scope="run">运行增量</button><button type="button" data-scope="workspace">工作目录全量</button></div>';
    if(isActive())html+='<p class="term-amber">当前运行未定稿 · 文件仍可能变化</p>';
    if(state.runMode==='只读'&&state.scope==='run')html+='<p>本次只读运行无新增变化。工作目录全量仍可查看运行前已有修改。</p>';
    if(state.detail){
      const diff=state.file==='README.md'?(state.scope==='run'?'运行前已有修改，本次没有新增变化。':'@@ 项目说明 @@\n- Checkout demo\n+ Checkout demo with retry guidance') : state.file==='test/checkout.test.ts'?'@@ 重复提交测试 @@\n+ it("ignores duplicate submit", async () => {\n+   expect(requestCount).toBe(1);\n+ });':'@@ 提交处理 @@\n- await submitOrder(values);\n+ if (submitting) return;\n+ submitting = true;\n+ try { await submitOrder(values); }\n+ finally { submitting = false; }';
      html+='<p>'+e(state.file)+'</p><pre class="diff">'+e(diff)+'</pre><button type="button" data-back="files">返回文件列表</button>';
    }
  }
  if(['help','sessions'].includes(state.panel))html+='<input class="panel-search" id="panel-search" aria-label="检索当前面板" value="'+e(state.query)+'" placeholder="输入关键词过滤">';
  if(state.panel==='context')html+='<p>指令 · D:\\checkout-web\\AGENTS.md</p><p>显式文件 · src/checkout.ts</p><p>上下文用量 · 估算 28k / 128k</p><p class="term-dim">压缩后、尚无新 usage 时显示未知。缓存指标仅使用 provider usage。</p>';
  if(state.panel==='tools'||state.panel==='checks'){
    const output={none:'没有执行验证命令。',denied:'shell #t17 被拒绝 · 命令未执行 · 无退出码。',unknown:'命令退出状态未知 · 不能判断验证结果。',running:'npm test -- checkout · 运行中 · 尚无退出码。',passed:'npm test -- checkout · exit 0 · 2.4s\nPASS test/checkout.test.ts\n结账模块通过，未运行端到端测试。',failed:'npm test -- checkout · exit 1 · 2.4s\nFAIL test/checkout.test.ts\nRetry after failure\nExpected button.disabled = false\nReceived true'};
    html+='<p>cwd · D:\\checkout-web · PowerShell</p><pre class="diff">'+e(output[state.check])+'</pre><p class="term-dim">演示证据。仅实际采集且尚未清理的输出可打开；文件变化后证据标可能过期。</p>';
  }
  if(state.panel==='status')html+='<p>目录 · D:\\checkout-web</p><p>模型 · '+e(state.model)+'</p><p>模式 · '+e(state.mode)+'</p><p>运行 · '+e(state.phase)+'</p><p>工作区 · '+(state.phase==='locked'?'执行占用未解除':'宿主持有 writer')+'</p><p class="term-dim">固定 SDK；真实版本与缓存 usage 在产品中由运行时填入。</p>';
  if(state.panel==='provider')html+='<p>来源 · SDK 支持的 provider</p><p>凭据 · 环境变量（演示，无真实密钥）</p><p>端点 · 已选择来源的端点</p><p class="panel-note">本原型不会连接服务、保存凭据或上传文件。</p>'+(state.phase==='locked'?'': '<button type="button" data-setup="ready">完成演示配置</button>');
  if(state.panel==='settings')html+='<p>主题 · 跟随终端</p><p>Shell · PowerShell，显式选择</p><p>编辑器 · VISUAL &gt; EDITOR</p><p>日志 · 本地、脱敏，不自动上传</p>';
  if(state.panel==='compact')html+='<p>此操作通过 SDK 调用模型，可能消耗 token。保留本地历史。</p><div class="panel-actions"><button type="button" data-confirm="compact">开始压缩演示</button><button type="button" data-close>返回</button></div>';
  if(state.panel==='exit')html+='<p>活跃任务先停止并确认命令清理。草稿保留。</p><div class="panel-actions"><button type="button" data-confirm="exit">停止并退出演示</button><button type="button" data-close>返回</button></div>';
  if(['export','copy','open','rename'].includes(state.panel)){
    const c=PRODUCT.commands.find(x=>x.name.split(' ')[0]==='/'+state.panel);
    html+='<p>'+e(c.detail)+'</p><p class="panel-note">这是边界规格预览，不写文件、不复制剪贴板、不启动编辑器。</p>';
  }
  const list=choices();state.menuIndex=Math.max(0,Math.min(state.menuIndex,Math.max(0,list.length-1)));
  if(!(state.panel==='changes'&&state.detail))html+=list.map((c,i)=>'<button type="button" class="panel-choice'+(i===state.menuIndex?' selected':'')+'" data-choice="'+i+'"'+(c.disabled?' disabled':'')+'><span class="choice-title">'+(i===state.menuIndex?'› ':'  ')+e(c.name)+'</span><span class="choice-detail">'+e(c.detail)+'</span></button>').join('');
  if(['help','palette','sessions','files'].includes(state.panel)&&!list.length)html+='<p class="term-amber">没有匹配项。原草稿保留。</p>';
  html+='<p class="panel-note" style="margin:12px 0 0">'+(state.panel==='approval'?'Up/Down 选择 · Enter 确认 · Esc 拒绝 · Ctrl+C 停止':'Esc 返回原草稿')+'</p>';
  if(state.panel!=='approval')html+='<button type="button" data-close>返回</button>';
  panel.innerHTML=html;
}
function render(){
  const s=SCENES[state.scene];
  $('scene-select').value=state.scene;
  $('demo-transcript').innerHTML=transcript();
  $('demo-state').textContent=s.state;
  $('demo-state').className='state-label'+(['locked','approval','stopping'].includes(state.phase)?' warning':state.scene==='error'||state.scene==='failed'?' error':'');
  $('demo-operation').textContent=s.operation;
  $('demo-input').value=state.draft;
  $('demo-input').disabled=state.panel==='approval'||state.phase==='setup';
  $('demo-send').disabled=$('demo-input').disabled;
  $('demo-send').textContent=isActive()?'保留草稿':'发送';
  $('demo-config').textContent=state.model+' · '+state.mode+' · 上下文 估算 / 未知';
  $('demo-keyhint').textContent=state.panel==='approval'?'Esc 拒绝这次 · Ctrl+C 停止':isActive()?'Enter 保留草稿 · Ctrl+C 停止':'Enter 发送 · Ctrl+J 换行 · / 命令';
  $('scene-title').textContent=s.title;$('scene-description').textContent=s.description;
  const next={ready:'开始示例任务',reading:'模拟分析完成',readresult:'查看上下文',working:'模拟下一步请求批准',approval:'等待用户决定',verifying:'模拟测试通过',stopping:'模拟命令退出确认',recovered:'模拟旧命令退出确认',compacting:'模拟压缩完成'};
  $('demo-step').textContent=next[state.scene]||'查看下一流程';
  $('demo-step').disabled=state.scene==='approval'||state.scene==='locked';
  renderPanel();
}
function showScene(key){
  if(!['sessions','changes','context','models','permissions','help'].includes(key))state.transcriptScene=key;
  if(['reading','readresult'].includes(key))state.runMode='只读';
  if(['working','approval','verifying','passed','failed','denied','tools'].includes(key))state.runMode='编码';
  if(['working','reading'].includes(key))state.check='none';
  const checks={ready:'none',readresult:'none',verifying:'running',passed:'passed',failed:'failed',tools:'failed',denied:'denied',recovered:'unknown',stopping:state.check==='running'?'unknown':state.check};
  if(key in checks)state.check=checks[key];
  const s=SCENES[key];state.scene=key;state.phase=s.phase;state.panel=s.panel||null;state.query='';state.menuIndex=0;state.detail=null;state.paletteClosed=null;
  render();
  if(state.panel&&state.panel!=='palette')$('demo-panel').querySelector('[data-choice]')?.focus();
}
function closePanel(){state.panel=null;state.query='';state.detail=null;state.paletteClosed=state.draft;render();$('demo-input').focus();feedback('面板已关闭，草稿保留；运行状态没有因此改变。');}
function openPanel(panel){state.panel=panel;state.menuIndex=0;state.query='';state.detail=null;render();if(panel!=='palette'&&panel!=='files')$('demo-panel').querySelector('[data-choice],button')?.focus();}
function choose(index){
  const c=choices()[index];if(!c||c.disabled)return;
  state.menuIndex=index;
  const panel=state.panel;
  if(panel==='approval'){
    if(c.value==='stop')requestStop();else showScene(c.value==='allow'?'verifying':'denied');
    feedback(c.value==='allow'?'演示批准已绑定 #t17，测试现在才进入执行态。':c.value==='deny'?'演示命令被拒绝，未执行。此场景随后模拟模型接受拒绝并结束。':'演示撤销批准并等待停止确认。');return;
  }
  if(panel==='palette'){state.draft=c.value;closePanel();feedback('已补全 '+c.value+'，尚未执行。再次 Enter 执行本地命令。');return;}
  if(panel==='help'){executeCommand(c.value);return;}
  if(panel==='files'){state.draft=state.draft.replace(/@[^\s]*$/,'@"'+c.value+'"');closePanel();feedback('显式文件引用已进入草稿；真实产品在发送时校验路径与内容。');return;}
  if(panel==='model'){state.model=c.value;closePanel();feedback('演示模型已切换，后续运行使用 '+c.value+'。');return;}
  if(panel==='permissions'){state.mode=c.value;closePanel();feedback('演示模式已改为'+c.value+'，后续任务采用该能力集合。');return;}
  if(panel==='sessions'){
    if(state.draft){feedback('当前有未发送草稿，先关闭面板并处理草稿后再恢复，演示不会丢弃输入。');return;}
    showScene(c.value);feedback('演示恢复已保存记录。命令未自动重跑；旧执行未知时保持锁定。');return;
  }
  if(panel==='changes'){state.file=c.value;state.detail=true;renderPanel();$('demo-panel').querySelector('[data-back]')?.focus();feedback('正在查看 '+c.value+' 的 '+(state.scope==='run'?'运行增量':'工作目录全量')+'。');}
}
function executeCommand(text){
  const base=text.trim().split(/\s/)[0];
  const spec=PRODUCT.commands.find(c=>c.name.split(' ')[0]===base);
  if(!spec){feedback('未知本地命令 '+base+'。草稿保留；用 // 开头可发送字面斜杠。');return;}
  const reason=commandBlockReason(spec);if(reason){feedback(base+' 不可执行 · '+reason+'。命令没有排队。');return;}
  const previousDraft=state.draft;
  if(previousDraft.trim()===text.trim()){state.draft='';}
  if(base==='/stop'){requestStop();return;}
  if(base==='/new'){
    if(state.draft){feedback('未发送草稿保留，先处理草稿再新建。');return;}
    showScene('ready');feedback('演示已新建会话，旧历史与工作目录改动保留。');return;
  }
  if(base==='/exit'&&!isActive()){
    closePanel();feedback(state.scene==='recovered'?'只能退出只读恢复查看器，旧执行仍未知；不会解除工作区锁或宣称清理成功。':state.scene==='locked'?'退出本查看器，另一终端的执行与占用继续保留。':'演示安全退出，恢复终端，保留可保存记录，显示 arkcode resume <session-id>。此网页仍可继续查看。');return;
  }
  openPanel(base.slice(1)==='sessions'?'sessions':base.slice(1)==='permissions'?'permissions':base.slice(1)==='model'?'model':base.slice(1));
  feedback(base+' 是宿主本地操作，不进入模型对话。');
}
function submit(){
  if(state.panel==='palette'||state.panel==='files'){choose(state.menuIndex);return;}
  const text=state.draft.trim();if(!text){feedback('输入为空，没有提交。');return;}
  if(text==='?'){executeCommand('/help');return;}
  if(new TextEncoder().encode(text).length>65536){feedback('演示输入超过 64 KiB，保留草稿，请缩小内容。');return;}
  if(text.startsWith('/')&&!text.startsWith('//')){executeCommand(text);return;}
  if(isActive()){feedback('当前任务进行中。草稿尚未发送，等待结束或先停止。');return;}
  if(state.phase==='locked'||state.phase==='setup'){feedback('执行入口未就绪，草稿保留。先确认旧执行已退出或完成配置。');return;}
  state.task=text.startsWith('//')?text.slice(1):text;state.draft='';
  showScene(state.mode==='只读'?'reading':'working');feedback('已开始一轮演示任务。此页不调用模型，使用“推进演示”观察下一阶段。');
}
function requestStop(){
  if(!isActive()){feedback(state.phase==='locked'?'执行状态仍未知，不能仅由 /stop 宣称已退出。':'当前没有活跃运行。');return;}
  if(state.phase==='stopping'){feedback('仍在等待执行退出；重复停止不会解锁工作区。');return;}
  showScene('stopping');feedback('停止请求已接收。批准已撤销，等待 SDK 和受管命令退出确认。');
}
function step(){
  const next={ready:state.mode==='只读'?'reading':'working',reading:'readresult',readresult:'context',working:'approval',verifying:'passed',stopping:'stopped',recovered:'stopped',compacting:'ready',passed:'changes',failed:'checks',denied:'changes',stopped:'changes'};
  if(state.scene==='failed'){openPanel('checks');return;}
  if(next[state.scene]){showScene(next[state.scene]);feedback('已推进演示。此阶段变化代表模拟事件，不是实际执行证据。');}else showScene('ready');
}
$('scene-select').addEventListener('change',event=>{const key=event.target.value;if(['reading','readresult','setup'].includes(key))state.mode='只读';else if(['working','approval','verifying','passed','failed','denied','tools'].includes(key)){state.mode='编码';state.runMode='编码';}showScene(key);feedback('已切换到 '+SCENES[key].label+'。');});
$('demo-step').addEventListener('click',step);
$('demo-reset').addEventListener('click',()=>{Object.assign(state,{draft:'',model:'model-pro · medium',mode:'编码',scope:'run'});showScene('ready');feedback('演示已重置，输入任务开始。');});
$('demo-send').addEventListener('click',submit);
$('demo-input').addEventListener('input',event=>{
  state.draft=event.target.value;
  if(state.draft!==state.paletteClosed&&/^\/[^\s]*$/.test(state.draft)){state.panel='palette';state.query=state.draft.slice(1);state.menuIndex=0;renderPanel();}
  else if(/@[^\s]*$/.test(state.draft)){state.panel='files';state.query=state.draft.match(/@([^\s]*)$/)[1];state.menuIndex=0;renderPanel();}
  else if(state.panel==='palette'||state.panel==='files'){state.panel=null;renderPanel();}
});
$('terminal').addEventListener('keydown',event=>{
  if(event.isComposing)return;
  const inputTarget=event.target===$('demo-input');
  if(event.ctrlKey&&event.key.toLowerCase()==='c'){
    event.preventDefault();if(isActive()){requestStop();return;}
    if(state.panel){closePanel();return;}
    if(state.draft){state.draft='';render();feedback('演示清空草稿，真实产品同时保存撤销副本。');return;}
    if(Date.now()-state.exitArmedAt<2000)executeCommand('/exit');else{state.exitArmedAt=Date.now();feedback('再次 Ctrl+C 退出演示，或 /exit。');}return;
  }
  if(event.key==='Escape'){
    event.preventDefault();if(state.panel==='approval')choose(0);else if(state.panel==='changes'&&state.detail){state.detail=null;renderPanel();$('demo-panel').querySelector('[data-choice="'+state.menuIndex+'"]')?.focus();}else if(state.panel)closePanel();else if(isActive())requestStop();return;
  }
  if(inputTarget&&event.ctrlKey&&event.key.toLowerCase()==='j'){
    event.preventDefault();const input=$('demo-input');const start=input.selectionStart;state.draft=input.value.slice(0,start)+'\n'+input.value.slice(input.selectionEnd);input.value=state.draft;input.setSelectionRange(start+1,start+1);return;
  }
  if(inputTarget&&event.ctrlKey&&event.key.toLowerCase()==='o'){event.preventDefault();openPanel('tools');return;}
  if(inputTarget&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit();return;}
  if(state.panel&&['ArrowUp','ArrowDown'].includes(event.key)&&event.target.id!=='panel-search'){
    event.preventDefault();const list=choices();if(!list.length)return;state.menuIndex=(state.menuIndex+(event.key==='ArrowDown'?1:-1)+list.length)%list.length;renderPanel();if(!inputTarget)$('demo-panel').querySelector('[data-choice="'+state.menuIndex+'"]')?.focus();return;
  }
  if(inputTarget&&event.key==='Tab'&&['palette','files'].includes(state.panel)){event.preventDefault();if(event.shiftKey){const list=choices();if(list.length){state.menuIndex=(state.menuIndex-1+list.length)%list.length;renderPanel();}}else choose(state.menuIndex);}
});
$('demo-panel').addEventListener('input',event=>{if(event.target.id==='panel-search'){state.query=event.target.value;state.menuIndex=0;renderPanel();const search=$('panel-search');search.focus();search.setSelectionRange(search.value.length,search.value.length);}});
$('demo-panel').addEventListener('click',event=>{
  const choice=event.target.closest('[data-choice]');if(choice){choose(Number(choice.dataset.choice));return;}
  const scope=event.target.closest('[data-scope]');if(scope){state.scope=scope.dataset.scope;state.detail=null;renderPanel();$('demo-panel').querySelector('[data-scope="'+state.scope+'"]')?.focus();return;}
  if(event.target.closest('[data-close]')){closePanel();return;}
  if(event.target.closest('[data-back]')){state.detail=null;renderPanel();$('demo-panel').querySelector('[data-choice="'+state.menuIndex+'"]')?.focus();return;}
  if(event.target.closest('[data-setup]')){state.mode='只读';showScene('ready');openPanel('permissions');feedback('演示配置完成。首次目录默认只读，请确认能力模式。没有发送认证请求。');return;}
  const confirm=event.target.closest('[data-confirm]');if(confirm){showScene(confirm.dataset.confirm==='compact'?'compacting':'stopping');feedback('已开始 '+(confirm.dataset.confirm==='compact'?'压缩':'停止并退出')+' 演示。');}
});
document.querySelectorAll('[data-width]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-width]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));$('terminal').classList.toggle('narrow',button.dataset.width==='narrow');}));
const commandRows=[...document.querySelectorAll('#command-table tbody tr')];
function filterCommands(){const query=$('command-filter').value.toLowerCase().trim();let count=0;commandRows.forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(query);if(!row.hidden)count++;});$('command-count').textContent=count+' / '+commandRows.length;$('command-empty').hidden=count!==0;}
$('command-filter').addEventListener('input',filterCommands);
const chapters=[...document.querySelectorAll('section[id]')];
function updateNav(){let id='prototype';chapters.forEach(c=>{if(c.getBoundingClientRect().top<150)id=c.id;});document.querySelectorAll('.topnav a').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+id));}
window.addEventListener('scroll',updateNav,{passive:true});
let openedForPrint=[];
window.addEventListener('beforeprint',()=>{openedForPrint=[...document.querySelectorAll('details:not([open])')];openedForPrint.forEach(d=>d.open=true);});
window.addEventListener('afterprint',()=>openedForPrint.forEach(d=>d.open=false));
render();filterCommands();updateNav();
