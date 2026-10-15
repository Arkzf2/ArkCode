(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const icons = {play:$('play').innerHTML, pause:'', copy:''};
  const themes = {
    signal: {description:'Signal · 冰青操作色、杏色用户输入、柔紫命令与绿色结果。清晰的航电仪表配色。',colors:{Input:'#E9BF93',Tools:'#7ECAD5',Code:'#B6ABEE',Added:'#92C99B',Removed:'#EE9D9A',Context:'#D5C879'}},
    amber: {description:'Amber · 琥珀操作色、浅青用户输入、雾蓝路径与玫瑰紫语法。早期工作站的暖色信号。',colors:{Input:'#A0D6D0',Tools:'#E5BC76',Code:'#CAA4D3',Added:'#9BC795',Removed:'#E99A99',Context:'#A0D6D0'}},
    ion: {description:'Ion · 薄荷操作色、淡玫瑰用户输入、冰蓝命令与黄紫语法。更轻盈的实验室终端。',colors:{Input:'#E6B0C7',Tools:'#99D4B8',Code:'#B7AFF1',Added:'#A4CE8A',Removed:'#EF9C9C',Context:'#DFCB91'}},
    prism: {description:'Prism · 白灰正文、工具与代码，淡暖灰用户输入，常驻柔紫输入边框。颜色保留在增删、交互与底部会话信息。',colors:{Input:'#D1C9B5',Tools:'#C3C4CD',Code:'#B9B6C2',Added:'#92BDA0',Removed:'#DBA0A0',Context:'#C7B7A4'}}
  };
  const visuals = ['instrument-deepfield'];
  const escape = text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const guardDiff = '@@ -18,3 +18,9 @@\n export async function submitOrder() {\n+  if (pending) return;\n+  pending = true;\n-  await sendOrder();\n+  try {\n+    await sendOrder();\n+  } finally {\n+    pending = false;\n+  }\n }';
  const testOutput = 'PASS test/checkout.test.ts\n  ✓ ignores a second submit while pending\n  ✓ allows retry after a rejected request\n  ✓ preserves the successful request\n\nTest Files  1 passed (1)\nTests       3 passed (3)\nDuration    148 ms';
  const codingAnswer = '## Changes\n\nAdded a **submission guard** in [src/checkout.ts:18](src/checkout.ts:18). The guard resets after a failed request.\n\n- Duplicate submissions are ignored while pending.\n- A failed request can be retried.\n\n```typescript\nif (pending) return;\npending = true;\ntry {\n  await sendOrder();\n} finally {\n  pending = false;\n}\n```\n\n## Validation\n\n`npm test -- checkout` passed **3 tests**.\n\n> End-to-end tests were not run.\n';
  const markdownAnswer = '## Prevent duplicate submissions\n\nUse a **single pending flag** around the asynchronous request. Keep the reset in `finally` so a failed request can be retried.\n\n```typescript\nlet pending = false;\n\nexport async function submitOrder() {\n  if (pending) return;\n  pending = true;\n  try {\n    await sendOrder();\n  } finally {\n    pending = false;\n  }\n}\n```\n\n### Expected behavior\n\n| State | Next click |\n| --- | --- |\n| Idle | Send request |\n| Pending | Ignore click |\n| Rejected | Allow retry |\n\n- [x] Prevent concurrent submissions\n- [x] Reset after rejection\n- [ ] Verify the browser flow\n\n> This prevents concurrent requests. Server-side idempotency is still needed for retries across clients.\n\nSee [the handler](src/checkout.ts:18) and the [MDN async function reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function).\n';
  const chunkAnswer = (source, id='answer') => {
    const tokens = marked.lexer(source);
    return tokens.filter(t => t.type !== 'space').flatMap((token,index,all) => {
      const position=tokens.indexOf(token);
      const source=tokens.slice(0,position+1).map(t=>t.raw).join('');
      const end={kind:'text',id,source,blockComplete:true,complete:index===all.length-1};
      if(token.type!=='code')return [end];
      const prefix=tokens.slice(0,position).map(t=>t.raw).join('');
      const lines=token.text.split('\n');
      const partial=prefix+token.raw.split('\n')[0]+'\n'+lines.slice(0,Math.ceil(lines.length/2)).join('\n')+'\n';
      return [{kind:'text',id,source:partial,blockComplete:false,complete:false},end];
    });
  };
  const scenes = {
    coding:{prompt:'Fix duplicate checkout submissions and add a regression test.',caption:'编码场景 · 推理摘要、文件探索、diff、测试结果与流式 Markdown。',events:[
      {kind:'summary',id:'reason',text:'Checking the submit handler',detail:'I will inspect the existing guard and the regression tests before making a change.'},
      {kind:'summary',id:'reason',text:'Looking for the retry path',detail:'The reset must happen after both success and rejection. I will preserve the existing README changes.'},
      {kind:'tool',id:'reads',action:'Exploring',label:'checkout handler and tests',output:'Read src/checkout.ts\nRead test/checkout.test.ts',status:'running'},
      {kind:'result',id:'reads',action:'Explored',status:'success',output:'Read src/checkout.ts\nRead test/checkout.test.ts'},
      {kind:'tool',id:'edit',action:'Editing',label:'src/checkout.ts',output:'',status:'running'},
      {kind:'result',id:'edit',action:'Edited',status:'success',output:guardDiff,diff:true,meta:'(+7 -1)'},
      {kind:'tool',id:'tests',action:'Running',label:'npm test -- checkout',output:'RUN test/checkout.test.ts',status:'running'},
      {kind:'output',id:'tests',output:'RUN test/checkout.test.ts\n  ✓ ignores a second submit while pending\n  ✓ allows retry after a rejected request'},
      {kind:'result',id:'tests',action:'Ran',status:'success',output:testOutput,exitCode:0},
      ...chunkAnswer(codingAnswer),{kind:'done',status:'completed'}
    ]},
    approval:{prompt:'Install the project dependencies and run the checkout tests.',caption:'审批场景 · 到请求处暂停。允许、会话授权、拒绝与取消分别产生明确结果。',events:[
      {kind:'summary',id:'reason',text:'Checking project dependencies',detail:'The project needs dependencies before the tests can run. Network access is outside the current sandbox.'},
      {kind:'tool',id:'package',action:'Explored',label:'package.json',output:'Read package.json\nRead package-lock.json',status:'success'},
      {kind:'approval'}
    ]},
    failure:{prompt:'Run the checkout tests and report any failures.',caption:'失败场景 · 保留错误和 exit code。运行中可中断，部分输出不会被当成成功。',events:[
      {kind:'summary',id:'reason',text:'Checking the test command',detail:'I will run the focused test suite and report the actual command result.'},
      {kind:'tool',id:'failed-tests',action:'Running',label:'npm test -- checkout',output:'RUN test/checkout.test.ts',status:'running'},
      {kind:'output',id:'failed-tests',output:'RUN test/checkout.test.ts\nFAIL test/checkout.test.ts\n  retry after rejection'},
      {kind:'result',id:'failed-tests',action:'Ran',status:'failed',exitCode:1,output:'FAIL test/checkout.test.ts\nAssertionError: expected pending to be false\n  at test/checkout.test.ts:42:19\n\nTests  1 failed | 2 passed\nExit code: 1'},
      ...chunkAnswer('## Test failure\n\n**1 test failed**. The pending flag stays set after a rejected request.\n\n- Location: [test/checkout.test.ts:42](test/checkout.test.ts:42)\n- Command: `npm test -- checkout`\n- Exit code: `1`\n\nNo files were changed.\n'),{kind:'done',status:'failed'}
    ]},
    markdown:{prompt:'Explain the submission guard with code and a behavior table.',caption:'Markdown 场景 · 小标题、强调、代码、表格、引用和任务列表。完整回答可复制原文。',events:[
      {kind:'summary',id:'reason',text:'Explaining the submission guard',detail:'I will separate concurrent submission prevention from server-side idempotency.'},
      ...chunkAnswer(markdownAnswer),{kind:'done',status:'completed'}
    ]}
  };
  let state;
  let timer;
  let generation = 0;
  let itemNumber = 0;
  let approvalFocus;
  const nodes = new Map();
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  $('motion').checked = !media.matches;

  // Timers carry a generation so resetting or interrupting cannot revive an old scene.
  function cancelTimer() { clearTimeout(timer); timer = undefined; generation++; }
  function reset(scene) {
    cancelTimer();
    state = {scene,phase:'ready',items:[],events:[...scenes[scene].events],cursor:0,playing:false,summary:'Ready',pending:[],expanded:new Map(),view:'conversation',panel:null,approvalSelection:0,activeMs:0,lastTick:performance.now()};
    nodes.clear(); $('entries').replaceChildren(); $('input').value=scenes[scene].prompt;
    $('caption').textContent=scenes[scene].caption; $('notice').textContent=''; $('scroll').scrollTop=0;
    render();
  }
  function updateItem(event) {
    const found = state.items.find(item=>item.id===event.id);
    if (found) Object.assign(found,event);
    else state.items.push({...event});
  }
  function dispatch(event) {
    switch(event.kind) {
      case 'start':
        state.phase='running'; state.summary='Working'; state.items.push({kind:'user',id:`user-${++itemNumber}`,text:event.prompt}); break;
      case 'summary': {
        const previous=state.items.find(x=>x.id===event.id);
        updateItem({...event,detail:previous?`${previous.detail}\n${event.detail}`:event.detail});
        state.summary=event.text;
        break;
      }
      case 'tool': updateItem(event); state.summary=event.action; break;
      case 'result': updateItem({...event,kind:'tool'}); state.summary=event.status==='failed'?'Inspecting the failure':'Working'; break;
      case 'output': {
        const tool=state.items.find(x=>x.id===event.id);
        if(tool)tool.output=event.output;
        break;
      }
      case 'text': updateItem(event); state.summary='Writing the response'; break;
      case 'approval': state.phase='approval'; state.playing=false; state.approvalSelection=0; state.summary='Approval needed'; cancelTimer(); break;
      case 'decision': {
        if(state.phase!=='approval')return;
        cancelTimer(); state.phase='running'; state.summary='Working';
        const allowed=event.decision==='once'||event.decision==='session';
        state.items.push({kind:'notice',id:`decision-${++itemNumber}`,text:allowed?(event.decision==='session'?'Approved npm install for this session':'Approved npm install for this command'):event.decision==='cancel'?'Approval cancelled. npm install was not run':'npm install was not run'});
        state.events=allowed?[
          {kind:'tool',id:'install',action:'Running',label:'npm install',status:'running',output:'Resolving packages...'},
          {kind:'result',id:'install',action:'Ran',status:'success',exitCode:0,output:'added 124 packages\nNetwork request completed'},
          {kind:'tool',id:'tests',action:'Running',label:'npm test -- checkout',status:'running',output:'RUN test/checkout.test.ts'},
          {kind:'result',id:'tests',action:'Ran',status:'success',exitCode:0,output:testOutput},
          ...chunkAnswer('Dependencies installed. The checkout suite passed **3 tests**.\n\nEnd-to-end tests were not run.\n'),{kind:'done',status:'completed'}
        ]:[...chunkAnswer('The install command was not run. Tests remain **unverified** because the dependencies are missing.\n'),{kind:'done',status:'completed'}];
        state.cursor=0; state.playing=true; break;
      }
      case 'input': state.pending.push({id:`input-${++itemNumber}`,delivery:event.delivery,text:event.text}); break;
      case 'consume': {
        const consumed=state.pending.filter(x=>x.delivery==='steer');
        for(const input of consumed)state.items.push({kind:'user',id:input.id,text:input.text});
        state.pending=state.pending.filter(x=>x.delivery!=='steer');
        if(consumed.length)state.items.push({kind:'notice',id:`accepted-${++itemNumber}`,text:'Instruction received'});
        break;
      }
      case 'done': state.phase=event.status;state.playing=false;state.summary=event.status==='failed'?'Finished with a test failure':'Completed';cancelTimer();break;
      case 'stop':
        if(!['running','approval'].includes(state.phase))return;
        cancelTimer();state.phase='stopping';state.playing=false;state.summary='Stopping';
        for(const item of state.items)if(item.kind==='text')item.complete=true;
        break;
      case 'stopped':
        state.phase='interrupted';state.summary='Interrupted';
        for(const item of state.items)if(item.kind==='tool'&&item.status==='running'){item.status='interrupted';item.action='Interrupted';}
        if(state.pending.length){$('input').value=[$('input').value,...state.pending.map(x=>x.text)].filter(Boolean).join('\n');state.pending=[];}
        state.items.push({kind:'notice',id:`interrupted-${++itemNumber}`,text:'Interrupted. Partial output retained; existing files were not reverted.'});break;
    }
    render();
  }
  function next() {
    if(['approval','stopping','interrupted'].includes(state.phase))return;
    if(state.phase==='ready') {dispatch({kind:'start',prompt:$('input').value.trim()||scenes[state.scene].prompt});$('input').value='';}
    if(['completed','failed'].includes(state.phase))return;
    const runningTool=state.items.some(x=>x.kind==='tool'&&x.status==='running');
    if(!runningTool&&state.pending.some(x=>x.delivery==='steer'))dispatch({kind:'consume'});
    const event=state.events[state.cursor++];
    if(event)dispatch(event);
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if(!state.playing||state.phase!=='running')return;
    const expected=generation;
    timer=setTimeout(()=>{if(expected===generation)next();},state.events[state.cursor]?.kind==='text'?650:1100);
  }
  function play() {
    if(state.phase==='approval')return;
    if(['completed','failed','interrupted'].includes(state.phase)) {
      if(state.pending.length){startFollowUp();return;}
      reset(state.scene);
    }
    state.playing=!state.playing;state.lastTick=performance.now();
    if(state.playing)next();else {cancelTimer();render();}
  }
  function startFollowUp() {
    const pending=state.pending.splice(0);
    if(!pending.length)return;
    cancelTimer();state.phase='running';state.playing=true;state.cursor=0;
    for(const input of pending)state.items.push({kind:'user',id:input.id,text:input.text});
    state.events=[{kind:'summary',id:`follow-reason-${++itemNumber}`,text:'Considering the follow-up',detail:'This example has no additional tool actions.'},...chunkAnswer('I have received the follow-up. No additional files were changed in this example.\n',`follow-${++itemNumber}`),{kind:'done',status:'completed'}];
    next();
  }
  function stop() {
    if(state.phase==='approval') {decide('cancel');return;}
    if(state.phase!=='running')return;
    dispatch({kind:'stop'});
    const expected=generation;
    timer=setTimeout(()=>{if(expected===generation)dispatch({kind:'stopped'});},500);
  }
  function decide(decision) {dispatch({kind:'decision',decision});schedule();$('input').focus();}
  function diffHtml(source) {
    return source.split('\n').map(line=>`<span class="diff-line ${line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-del':line.startsWith('@@')?'diff-meta':''}">${escape(line)}</span>`).join('');
  }
  function markdownHtml(source,complete) {
    const tokens=marked.lexer(source);
    const tail=!complete?tokens.pop():null;
    let html=marked.parser(tokens);
    if(tail){
      if(tail.type==='code')html+=`<pre class="stream-tail-code"><code class="language-${escape((tail.lang||'text').split(' ')[0])}">${escape(tail.text)}</code></pre>`;
      else if(tail.type==='table')html+=marked.parser([tail]);
      else html+=`<div class="stream-tail">${escape(tail.raw)}</div>`;
    }
    const clean=DOMPurify.sanitize(html,{FORBID_TAGS:['img','style','iframe','form','button'],FORBID_ATTR:['style'],ADD_ATTR:['target']});
    const template=document.createElement('template');template.innerHTML=clean;
    for(const link of template.content.querySelectorAll('a')) {
      const href=link.getAttribute('href')||'';
      if(/^https?:\/\//i.test(href)){link.target='_blank';link.rel='noopener noreferrer';}
      else if(/^(src|test)\/[^\s]+:\d+$/.test(href)){link.dataset.file=href;link.href='#file-preview';}
      else link.removeAttribute('href');
    }
    for(const table of template.content.querySelectorAll('table')){const wrap=document.createElement('div');wrap.className='table-wrap';table.replaceWith(wrap);wrap.append(table);}
    for(const pre of template.content.querySelectorAll('pre')) {
      const code=pre.querySelector('code');if(!code)continue;
      const language=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9)||'text';
      if(hljs.getLanguage(language))code.innerHTML=hljs.highlight(code.textContent,{language}).value;
      const block=document.createElement('div');block.className='code-block';
      const heading=document.createElement('div');heading.className='code-heading';heading.textContent=language;
      const copy=document.createElement('button');copy.className='icon';copy.title='Copy code';copy.setAttribute('aria-label','Copy code');copy.dataset.code=code.textContent;copy.innerHTML=icons.copy;
      heading.append(copy);pre.replaceWith(block);block.append(heading,pre);
    }
    return template.innerHTML;
  }
  function renderItem(item) {
    if(item.kind==='user')return `<span class="marker">›</span><div class="body">${escape(item.text)}</div>`;
    if(item.kind==='summary')return `<span class="marker">•</span><div class="body">${escape(item.text)}\n${escape(item.detail)}</div>`;
    if(item.kind==='notice')return `<span class="marker">•</span><div class="body">${escape(item.text)}</div>`;
    if(item.kind==='text')return `<span class="marker">•</span><div class="body markdown">${markdownHtml(item.source,item.complete)}</div>`;
    const full=state.expanded.get(`${state.view}:${item.id}`)??state.view==='transcript';
    const lines=(item.output||'').split('\n');
    const preview=full||item.diff?item.output:lines.slice(0,3).join('\n');
    const outcome=item.status==='failed'?'bad':item.status==='success'?'ok':item.status==='interrupted'?'warn':'dim';
    const metadata=[item.meta,item.exitCode!==undefined?`exit ${item.exitCode}`:''].filter(Boolean).join(' · ');
    return `<span class="marker ${outcome}">•</span><div class="body"><div class="tool-heading"><strong><span class="tool-action">${escape(item.action)}</span> <span class="${item.action==='Ran'||item.action==='Running'?'command':'tool-target'}">${escape(item.label)}</span></strong><span class="dim">${escape(metadata)}</span></div>${preview?`<div class="tool-output"><pre class="${item.diff?'diff-output':''}">${item.diff?diffHtml(preview):escape(preview)}</pre></div>`:''}${lines.length>3&&!item.diff?`<button class="tool-toggle" data-tool="${escape(item.id)}" aria-expanded="${full}">${full?'Collapse output':`+${lines.length-3} lines · ctrl+t for details`}</button>`:''}</div>`;
  }
  function patchMarkdown(node,item) {
    if(!node.querySelector('.markdown'))node.innerHTML='<span class="marker">•</span><div class="body markdown"></div>';
    const body=node.querySelector('.markdown');
    const next=document.createElement('template');next.innerHTML=markdownHtml(item.source,item.complete||item.blockComplete);
    const children=[...next.content.childNodes];
    children.forEach((child,index)=>{
      const previous=body.childNodes[index];
      if(!previous)body.append(child.cloneNode(true));
      else if(!previous.isEqualNode(child))previous.replaceWith(child.cloneNode(true));
    });
    while(body.childNodes.length>children.length)body.lastChild.remove();
  }
  function render() {
    const scroll=$('scroll');
    const follow=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<55&&!getSelection()?.toString();
    for(const item of state.items) {
      let node=nodes.get(item.id);
      if(!node){node=document.createElement('div');nodes.set(item.id,node);$('entries').append(node);}
      node.className=`entry ${item.kind==='summary'?'reasoning':item.kind==='notice'?'notice-row':item.kind}`;
      node.hidden=item.kind==='summary'&&state.view!=='transcript';
      const signature=JSON.stringify([item,state.view,state.expanded.get(`${state.view}:${item.id}`)]);
      if(node.dataset.signature!==signature){if(item.kind==='text')patchMarkdown(node,item);else node.innerHTML=renderItem(item);node.dataset.signature=signature;}
    }
    const modal=state.phase==='approval';
    $('approval').hidden=!modal; $('composer').hidden=modal;
    $('input').disabled=state.phase==='stopping';
    $('activity-label').textContent=state.summary;
    $('elapsed').textContent=state.phase==='ready'?'':`(${Math.floor(state.activeMs/1000)}s)`;
    $('activity').className=`activity ${state.phase} ${state.phase==='running'&&state.playing?'busy':''}`;
    $('interrupt').hidden=state.phase!=='running';
    $('pending').innerHTML=state.pending.map(x=>`<div class="pending-item"><strong>${x.delivery==='steer'?'Instruction pending':'Queued follow-up'}</strong><span>↳ ${escape(x.text)}</span></div>`).join('');
    $('play').innerHTML=state.playing?icons.pause:icons.play;
    $('play').title=state.playing?'Pause playback':'Play scene';$('play').setAttribute('aria-label',$('play').title);
    $('play').disabled=modal||state.phase==='stopping';
    $('step').disabled=!['ready','running'].includes(state.phase)||modal;
    $('playback-label').textContent=modal?'Waiting':state.playing?'Playing':state.phase==='ready'?'Ready':state.phase==='running'?'Paused':'Finished';
    $('transcript').setAttribute('aria-pressed',String(state.view==='transcript'));
    $('entries').hidden=Boolean(state.panel);$('panel').hidden=!state.panel;
    if(state.panel)$('panel').innerHTML=panelHtml();
    [...$('approval').querySelectorAll('[data-decision]')].forEach((button,index)=>button.setAttribute('aria-pressed',String(index===state.approvalSelection)));
    if(modal&&!approvalFocus){approvalFocus=document.activeElement;$('approval').querySelector('button').focus();}
    if(!modal&&approvalFocus){approvalFocus=null;$('input').focus();}
    if(follow&&!state.panel)scroll.scrollTop=scroll.scrollHeight;
  }
  function panelHtml() {
    let content;
    if(state.panel==='diff')content=`<p class="dim">Working directory · src/checkout.ts</p><pre class="diff-output">${diffHtml(state.items.some(x=>x.id==='edit'&&x.status==='success')?guardDiff:'No changes in this scene.')}</pre>`;
    else if(state.panel==='file')content=`<p class="dim">${escape(state.file||'src/checkout.ts:18')}</p><div class="markdown">${markdownHtml('```typescript\n'+(state.file?.startsWith('test')?'42  expect(pending).toBe(false);':'18  if (pending) return;\n19  pending = true;\n20  try { await sendOrder(); }\n21  finally { pending = false; }')+'\n```',true)}</div><p class="dim">Fixture source preview</p>`;
    else content='<p>Enter /diff to inspect changes, /review to see a review example, or /copy to copy the latest completed response.</p><p>Ctrl+T opens the transcript. Ctrl+O copies a response. Esc interrupts the current turn.</p>';
    return `<div class="panel-heading"><h2>${state.panel==='diff'?'Workspace diff':state.panel==='file'?'File preview':'Keyboard shortcuts'}</h2><button data-close-panel>Back</button></div>${content}`;
  }
  function toggleTranscript() {state.view=state.view==='transcript'?'conversation':'transcript';state.panel=null;render();}
  function openPanel(panel) {if(!state.panel)state.conversationScroll=$('scroll').scrollTop;state.panel=panel;render();$('scroll').scrollTop=0;}
  function closePanel() {state.panel=null;render();$('scroll').scrollTop=state.conversationScroll||0;$('input').focus();}
  async function copyText(text) {
    try {await navigator.clipboard.writeText(text);$('notice').textContent='Copied';}
    catch {$('notice').textContent='Clipboard unavailable';}
  }
  function copyAnswer() {const item=[...state.items].reverse().find(x=>x.kind==='text'&&x.complete);if(item)copyText(item.source);else $('notice').textContent='No completed response to copy';}
  function submit(delivery='steer') {
    const text=$('input').value.trim();if(!text||['approval','stopping'].includes(state.phase))return;
    if(text.startsWith('/')) {
      if(text==='/diff'){openPanel('diff');$('input').value='';return;}
      if(text==='/copy'){copyAnswer();$('input').value='';return;}
      if(text==='/help'){openPanel('help');$('input').value='';return;}
      if(text==='/new'){reset(state.scene);return;}
      if(text==='/review'&&state.phase!=='running') {
        const edited=state.items.some(x=>x.id==='edit'&&x.status==='success');
        const review=edited?'## Review\n\nNo findings in the submission guard. The `finally` reset covers rejected requests.\n\nEnd-to-end coverage remains unverified. No files were changed during review.\n':'## Review finding\n\n**[P1] Reset the pending flag after a rejected request**\n\n[src/checkout.ts:18](src/checkout.ts:18) sets `pending` before the request. If the request rejects without a `finally` reset, the next submit is ignored.\n\nThis is a review fixture. No files were changed.\n';
        cancelTimer();state.pending=[];state.events=[{kind:'summary',id:`review-reason-${++itemNumber}`,text:'Reviewing the retry path',detail:'Inspect the error path without changing the files.'},...chunkAnswer(review,`review-${++itemNumber}`),{kind:'done',status:'completed'}];
        state.cursor=0;state.phase='ready';state.panel=null;$('input').value='Review the retry path.';state.playing=true;next();return;
      }
      $('notice').textContent='Not available in this demo';return;
    }
    state.panel=null;
    if(state.phase==='running'){dispatch({kind:'input',delivery,text});$('input').value='';}
    else if(state.phase==='ready'){state.playing=true;next();}
    else {reset(state.scene);$('input').value=text;state.playing=true;next();}
  }
  $('play').addEventListener('click',play);
  $('step').addEventListener('click',()=>{state.playing=false;cancelTimer();next();});
  $('reset').addEventListener('click',()=>reset(state.scene));
  $('scene').addEventListener('change',()=>reset($('scene').value));
  $('transcript').addEventListener('click',toggleTranscript);
  $('interrupt').addEventListener('click',stop);
  $('composer').addEventListener('submit',event=>{event.preventDefault();submit();});
  $('motion').addEventListener('change',()=>{$('terminal').classList.toggle('motion-off',!$('motion').checked);});
  media.addEventListener('change',event=>{$('motion').checked=!event.matches;$('terminal').classList.toggle('motion-off',event.matches);});
  for (const button of document.querySelectorAll('.theme-picker button')) {
    button.addEventListener('click',event=>{
      const key=button.dataset.theme;
      document.body.dataset.theme=key;
      for(const choice of document.querySelectorAll('.theme-picker button'))choice.setAttribute('aria-pressed',String(choice===button));
      $('theme-description').textContent=themes[key].description;
      $('palette').innerHTML=Object.entries(themes[key].colors).map(([role,color])=>`<span title="${color}"><i style="--swatch:${color}" aria-hidden="true"></i>${role}</span>`).join('');
      history.replaceState(null,'',`#${key}/${document.body.dataset.visual}`);
      if(event.isTrusted&&state.phase!=='approval')$('input').focus({preventScroll:true});
    });
  }
  for(const button of document.querySelectorAll('.visual-picker button')) {
    button.addEventListener('click',()=>{
      document.body.dataset.visual=button.dataset.visual;
      for(const choice of document.querySelectorAll('.visual-picker button'))choice.setAttribute('aria-pressed',String(choice===button));
      history.replaceState(null,'',`#${document.body.dataset.theme}/${button.dataset.visual}`);
    });
  }
  $('terminal').addEventListener('click',event=>{
    const tool=event.target.closest('[data-tool]');
    if(tool){const key=`${state.view}:${tool.dataset.tool}`;state.expanded.set(key,!(state.expanded.get(key)??state.view==='transcript'));render();}
    const decision=event.target.closest('[data-decision]');if(decision)decide(decision.dataset.decision);
    const copy=event.target.closest('[data-code]');if(copy)copyText(copy.dataset.code);
    const file=event.target.closest('[data-file]');if(file){event.preventDefault();state.file=file.dataset.file;openPanel('file');}
    if(event.target.closest('[data-close-panel]'))closePanel();
    if(state.phase!=='approval'&&!event.target.closest('button,a,textarea')&&!getSelection()?.toString())$('input').focus({preventScroll:true});
  });
  $('terminal').addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    if(state.phase==='approval') {
      if(event.repeat){event.preventDefault();return;}
      if(event.key==='Escape'){event.preventDefault();decide('cancel');}
      else if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();state.approvalSelection=(state.approvalSelection+(event.key==='ArrowUp'?2:1))%3;render();$('approval').querySelectorAll('button')[state.approvalSelection].focus();}
      else if(event.key==='Enter'){event.preventDefault();decide(['once','session','deny'][state.approvalSelection]);}
      else if(/^[123]$/.test(event.key)){event.preventDefault();decide(['once','session','deny'][Number(event.key)-1]);}
      return;
    }
    if(event.ctrlKey&&event.key.toLowerCase()==='t'){event.preventDefault();toggleTranscript();return;}
    if(event.ctrlKey&&event.key.toLowerCase()==='o'){event.preventDefault();copyAnswer();return;}
    if(event.key==='Escape') {event.preventDefault();if(state.panel)closePanel();else if(state.view==='transcript')toggleTranscript();else stop();return;}
    if(state.phase==='stopping')return;
    if(event.target!==$('input')) {
      if(event.ctrlKey||event.metaKey||event.altKey)return;
      if(event.target.closest('button,a')&&['Enter',' '].includes(event.key))return;
      if(event.key.length===1) {
        event.preventDefault();$('input').focus({preventScroll:true});
        $('input').setRangeText(event.key,$('input').selectionStart,$('input').selectionEnd,'end');return;
      }
      if(!['Enter','Backspace','Delete'].includes(event.key))return;
      event.preventDefault();
      $('input').focus({preventScroll:true});
      if(event.key==='Backspace'||event.key==='Delete') {
        const input=$('input');let start=input.selectionStart,end=input.selectionEnd;
        const boundaries=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(input.value)].map(x=>x.index).concat(input.value.length);
        if(start===end&&event.key==='Backspace')start=boundaries.filter(x=>x<start).at(-1)??0;
        else if(start===end)end=boundaries.find(x=>x>end)??input.value.length;
        input.setRangeText('',start,end,'end');return;
      }
    }
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!event.repeat)submit();}
    else if(event.key==='Tab'&&state.phase==='running'&&$('input').value.trim()){event.preventDefault();submit('followUp');}
    else if(event.key==='ArrowLeft'&&event.shiftKey&&state.pending.length){event.preventDefault();const last=state.pending.pop();$('input').value=[$('input').value,last.text].filter(Boolean).join('\n');render();}
  });
  for(const button of document.querySelectorAll('.demo-controls button'))button.addEventListener('click',()=>{if(state.phase!=='approval')$('input').focus({preventScroll:true});});
  $('terminal').addEventListener('paste',event=>{
    if(state.phase==='approval'||state.phase==='stopping'||event.target===$('input'))return;
    const text=event.clipboardData?.getData('text/plain');
    if(!text)return;
    event.preventDefault();$('input').focus({preventScroll:true});
    $('input').setRangeText(text,$('input').selectionStart,$('input').selectionEnd,'end');
  });
  $('approval').addEventListener('paste',event=>event.preventDefault());
  $('approval').addEventListener('focusin',event=>{
    const index=[...$('approval').querySelectorAll('[data-decision]')].indexOf(event.target);
    if(index<0)return;
    state.approvalSelection=index;
    [...$('approval').querySelectorAll('[data-decision]')].forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));
  });
  window.addEventListener('pagehide',()=>{cancelTimer();clearInterval(clock);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.playing){state.playing=false;cancelTimer();render();}});
  const clock=setInterval(()=>{
    const now=performance.now();
    if(state.playing&&state.phase==='running')state.activeMs+=Math.min(now-state.lastTick,1500);
    state.lastTick=now;
    $('elapsed').textContent=state.phase==='ready'?'':`(${Math.floor(state.activeMs/1000)}s)`;
  },1000);
  /* ICON_DATA */
  $('terminal').classList.toggle('motion-off',!$('motion').checked);
  reset('coding');
  const [initialTheme,initialVisual]=location.hash.slice(1).split('/');
  document.querySelector(`.theme-picker button[data-theme="${Object.hasOwn(themes,initialTheme)?initialTheme:'prism'}"]`).click();
  document.querySelector(`.visual-picker button[data-visual="${visuals.includes(initialVisual)?initialVisual:'instrument-deepfield'}"]`).click();
  next();
  $('input').focus({preventScroll:true});
})();
