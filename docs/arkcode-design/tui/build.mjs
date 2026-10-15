import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root=path.dirname(fileURLToPath(import.meta.url));
const read=filename=>readFile(path.join(root,filename),'utf8');
const escape=text=>String(text).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const product=JSON.parse(await read('product.json'));
const scenes=JSON.parse(await read('scenes.json'));
const scripts=await read('interactions.js');
const styles=await read('style.css');
const repos={codex:{owner:'openai/codex',sha:'be2e129ecd67d900c016eda12d5d193e33d9c3da'},'kimi-code':{owner:'MoonshotAI/kimi-code',sha:'5b936697670ed15444bcb4720bd91e6ee776a941'},pi:{owner:'earendil-works/pi',sha:'1cedd32724abfcb0915f76cc61b6827e2c16dbad'}};
const evidence=[
 {id:'D01',kind:'official',label:'Codex CLI 官方说明',url:'https://learn.chatgpt.com/docs/codex/cli',claim:'在终端查看、编辑与运行代码；目录、模型和常用命令构成启动信息。'},
 {id:'D02',kind:'official',label:'Codex CLI 命令与快捷键',url:'https://learn.chatgpt.com/docs/developer-commands?surface=cli',claim:'斜杠补全、模型/权限/差异/会话控制及运行中输入具有各自操作语义。'},
 {id:'D03',kind:'official',label:'Kimi Code CLI 开始使用',url:'https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html',claim:'从项目目录启动交互 TUI，配置来源，使用帮助与恢复会话。'},
 {id:'D04',kind:'official',label:'Kimi 交互与输入',url:'https://www.kimi.com/code/docs/kimi-code-cli/guides/interaction.html',claim:'输入、对话、状态栏以及 Enter、多行、文件补全、审批和权限模式。'},
 {id:'D05',kind:'official',label:'Kimi 会话与上下文',url:'https://www.kimi.com/code/docs/kimi-code-cli/guides/sessions.html',claim:'会话继续、恢复、导出及有效模型上下文压缩。'},
 {id:'D06',kind:'official',label:'Kimi 键盘快捷键',url:'https://www.kimi.com/code/docs/kimi-code-cli/reference/keyboard',claim:'按焦点区分编辑、面板、运行与审批快捷键；不作为 ArkCode 默认键位。'},
 {id:'D07',kind:'official',label:'Kimi 斜杠命令',url:'https://www.kimi.com/code/docs/kimi-code-cli/reference/slash-commands.html',claim:'命令表区分运行中可用性；上下文撤销不等同于文件回滚。'}
];
for(const [file,prefix,repo] of [['codex','C','codex'],['kimi','K','kimi-code']]){
 const markdown=await read('research/'+file+'.md');
 const links=[...markdown.matchAll(/\[([^\]]+)\]\((https:\/\/github\.com\/[^)]+\/blob\/[^)]+#L\d+)\)/g)];
 if(links.length!==10)throw new Error('Expected 10 verified source references in '+file);
 for(const [index,match] of links.entries()){
  const url=new URL(match[2]);
  const marker='/blob/'+repos[repo].sha+'/';
  if(!url.pathname.includes(marker))throw new Error('Wrong pinned revision '+url.href);
  const sourcePath=decodeURIComponent(url.pathname.split(marker)[1]);
  const start=Number(url.hash.slice(2));
  evidence.push({id:prefix+(index+1),kind:'source',repo,path:sourcePath,start,end:start,label:match[1],url:url.href,claim:'固定提交源码或已提交测试快照，行为解释见独立研究记录。'});
 }
}
const previous=JSON.parse(await read('../sources.json'));
for(const id of ['A01','A05','A06','A07','A12','A13','A17','A18','A20','A21']){
 const row=previous.find(item=>item.id===id);
 if(!row)throw new Error('Missing SDK evidence '+id);
 evidence.push({...row,kind:'source',label:'Pi SDK · '+id});
}
for(const row of [{id:'P1',path:'packages/tui/README.md',start:59,end:62,claim:'Pi 提供 TuiMainScreen 保留主缓冲区滚动记录，TuiAltScreen 提供应用拥有的全屏视口。'},{id:'P2',path:'packages/tui/src/index.ts',start:40,end:84,claim:'Pi TUI 公共导出 Editor、Input、Markdown、SettingsList 及宽度/组件能力。'}]){
 evidence.push({...row,kind:'source',repo:'pi',label:'Pi TUI · '+row.id,url:'https://github.com/'+repos.pi.owner+'/blob/'+repos.pi.sha+'/'+row.path+'#L'+row.start+'-L'+row.end});
}
const snapshots=[];
for(const [repo,expected] of Object.entries(repos)){
 const cwd=path.join('E:/Github Programs',repo);
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
 const status=execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}).trim();
 if(head!==expected.sha||status)throw new Error('Repository snapshot changed: '+repo);
 snapshots.push({repo,sha:head,clean:true});
}
for(const row of evidence.filter(x=>x.kind==='source')){
 const text=await readFile(path.join('E:/Github Programs',row.repo,row.path),'utf8');
 const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
 if(row.start<1||row.end<row.start||row.end>lines.length)throw new Error('Invalid source range '+row.id);
 row.excerpt_sha256=createHash('sha256').update(lines.slice(row.start-1,row.end).join('\n')).digest('hex');
}
const lookup=new Map(evidence.map(row=>[row.id,row]));
if(lookup.size!==evidence.length)throw new Error('Duplicate source IDs');
let body=await read('body.html');
body=body.replace(/\[\[([A-Z0-9 ]+)\]\]/g,(_,ids)=>ids.split(' ').map(id=>{
 const row=lookup.get(id);if(!row)throw new Error('Unknown evidence '+id);
 return '<a class="cite" href="'+escape(row.url)+'" target="_blank" rel="noopener" title="'+escape(row.label)+'" aria-label="查看证据 '+id+'">'+id+'</a>';
}).join(''));
body=body.replace('{{SCENES}}',Object.entries(scenes).map(([key,scene])=>'<option value="'+key+'">'+escape(scene.label)+'</option>').join(''));
body=body.replace('{{FEATURES}}',product.features.map(row=>'<tr><td>'+escape(row.area)+'</td><td>'+escape(row.v1)+'</td><td>'+escape(row.later)+'</td></tr>').join(''));
body=body.replace('{{COMMANDS}}',product.commands.map(row=>'<tr><td><code>'+escape(row.name)+'</code></td><td>'+escape(row.purpose)+'</td><td class="'+(row.active?'active-tag':'idle-tag')+'">'+(row.active?'运行中可用':'仅空闲')+'</td><td>'+escape(row.effect)+'。'+escape(row.detail)+'</td></tr>').join(''));
body=body.replace('{{SHORTCUTS}}',product.shortcuts.map(row=>'<tr><td><code>'+escape(row.key)+'</code></td><td>'+escape(row.scope)+'</td><td>'+escape(row.action)+'</td></tr>').join(''));
body=body.replace('{{SOURCES}}',evidence.map(row=>'<article class="source" id="source-'+row.id+'"><div class="source-head"><span class="source-id">'+row.id+'</span><strong>'+escape(row.label)+'</strong><span>'+(row.kind==='official'?'官方文档':'固定源码')+'</span></div><p>'+escape(row.claim)+'</p><a href="'+escape(row.url)+'" target="_blank" rel="noopener">'+escape(row.kind==='official'?row.url:row.repo+'/'+row.path+' · L'+row.start+(row.end===row.start?'':'–L'+row.end))+'</a></article>').join(''));
body=body.replace('{{REVIEW}}',await read('review-note.html'));
const nav=[['prototype','体验'],['startup','启动'],['layout','界面'],['input','输入'],['permissions','批准'],['changes','审阅'],['commands','命令'],['architecture','实现'],['sources','证据']].map(([id,label])=>'<a href="#'+id+'">'+label+'</a>').join('');
const page='<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="description" content="ArkCode 首版 TUI 产品规格，包含交互终端原型、完整命令与按键、权限、会话、改动审阅、停止恢复及实施验收。"><title>ArkCode TUI · 产品与交互规格</title><style>'+styles+'</style></head><body><a class="skip" href="#main">跳到正文</a><header class="topbar"><a class="brand" href="#overview"><span>&gt;_</span> arkcode</a><nav class="topnav" aria-label="报告章节">'+nav+'</nav><span class="edition">TUI SPEC / 02</span></header><main id="main" class="shell">'+body+'</main><script>const PRODUCT='+JSON.stringify(product).replace(/</g,'\\u003c')+';\nconst SCENES='+JSON.stringify(scenes).replace(/</g,'\\u003c')+';\n'+scripts+'</script></body></html>';
if(page.includes('{{')||page.includes('[['))throw new Error('Unresolved template');
const ids=[...page.matchAll(/\bid="([^"\s]+)"/g)].map(x=>x[1]);
if(new Set(ids).size!==ids.length)throw new Error('Duplicate HTML IDs');
for(const match of page.matchAll(/href="#([^"\s]+)"/g))if(!ids.includes(match[1]))throw new Error('Broken anchor '+match[1]);
if(/<(?:script|img|iframe|link)\b[^>]*\b(?:src|href)\s*=/.test(page))throw new Error('External asset dependency');
let old={};try{old=JSON.parse(await read('validation.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
async function optionalJson(filename){try{return JSON.parse(await read(filename));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const browser=await optionalJson('browser-validation.json');
const review=await optionalJson('review-validation.json');
const validation={generated_at:new Date().toISOString(),commands:product.commands.length,scenes:Object.keys(scenes).length,source_count:evidence.length,source_snapshots:snapshots,source_ranges_valid:true,unique_ids:true,internal_anchors_valid:true,external_assets:0,svg_diagrams:(body.match(/<svg /g)||[]).length,html_bytes:Buffer.byteLength(page),browser:browser||old.browser||'pending',review:review||old.review||'pending',native_tui_implemented:false,native_terminal_and_model_tests:'not run; implementation acceptance gates'};
await writeFile(path.join(root,'arkcode-tui-v2.html'),page,'utf8');
await writeFile(path.join(root,'sources.json'),JSON.stringify(evidence,null,2),'utf8');
await writeFile(path.join(root,'validation-v2.json'),JSON.stringify({...validation,spec_revision:2,superseded_by:'arkcode-tui.html'},null,2),'utf8');
console.log(JSON.stringify(validation,null,2));
