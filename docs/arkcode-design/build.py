from datetime import datetime, timezone, timedelta
from html import escape
from html.parser import HTMLParser
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parent
REPOS = {
    'pi': ('earendil-works/pi', '1cedd32724abfcb0915f76cc61b6827e2c16dbad'),
    'codex': ('openai/codex', 'be2e129ecd67d900c016eda12d5d193e33d9c3da'),
    'kimi-code': ('MoonshotAI/kimi-code', '5b936697670ed15444bcb4720bd91e6ee776a941'),
    'ZCode': ('zai-org/ZCode', '29628c9acdb81b703bbd4080c207a0e7ce5e276e'),
}
borrowed_claims = {
    'C03': 'Codex 的模型回合使用 StepContext 组织执行时的工具与上下文。ArkCode 据此提出固定整次运行设置。',
    'K06': 'Kimi 将状态归约、持久记录与可观察事件组织为明确流程。不能据事件发布推断 fsync 完成。',
    'K24': 'Kimi 的客户端事件 envelope 区分 epoch、seq 与 session，用于识别事件流和恢复范围。',
    'Z02': 'ZCode 的 CommandInbox 对命令去重并按会话准入，运行中的命令保持有效记录。',
}
evidence = json.loads((ROOT/'research/sdk-evidence.json').read_text(encoding='utf-8-sig'))
previous = json.loads((ROOT.parent.parent/'research/architecture/harness-report/sources.json').read_text(encoding='utf-8-sig'))
for item in previous:
    if item['id'] in borrowed_claims:
        row = {key:item[key] for key in ('id','repo','path','start','end')}
        row['claim'] = borrowed_claims[row['id']]
        evidence.append(row)
checks = []
lookup = {}
for row in evidence:
    row['repo'] = row['repo'].split('/')[-1]
    owner, sha = REPOS[row['repo']]
    source = Path('E:/Github Programs')/row['repo']/row['path']
    lines = source.read_text(encoding='utf-8-sig').splitlines()
    assert 1 <= row['start'] <= row['end'] <= len(lines), row
    assert row['id'] not in lookup, row['id']
    row['url'] = f'https://github.com/{owner}/blob/{sha}/{row["path"]}#L{row["start"]}-L{row["end"]}'
    row['excerpt_sha256'] = hashlib.sha256('\n'.join(lines[row['start']-1:row['end']]).encode()).hexdigest()
    lookup[row['id']] = row
    checks.append({'id':row['id'],'range_valid':True,'sha256':row['excerpt_sha256']})
snapshots = []
for repo, (owner, sha) in REPOS.items():
    cwd = Path('E:/Github Programs')/repo
    head = subprocess.check_output(['git','rev-parse','HEAD'],cwd=cwd,text=True).strip()
    status = subprocess.check_output(['git','status','--porcelain'],cwd=cwd,text=True).strip()
    assert head == sha, (repo,head)
    assert not status, (repo,status)
    snapshots.append({'repo':repo,'sha':head,'clean':True})

icons = {
 'arrow':'<path d="M4 12h15m-6-6 6 6-6 6"/>',
 'layers':'<path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5"/>',
 'folder':'<path d="M3 6h6l2 2h10v12H3V6Z"/>',
 'message':'<path d="M4 4h16v12H9l-5 4V4Zm4 5h8M8 12h5"/>',
 'tool':'<path d="M14 4a6 6 0 0 0-7 7l-4 4a3 3 0 0 0 4 4l4-4a6 6 0 0 0 8-7l-4 4-3-3 3-4Z"/>',
 'diff':'<path d="M7 3H4v18h3M17 3h3v18h-3M9 8h6M12 5v6M9 16h6"/>',
 'target':'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m14 10 7-7M17 3h4v4"/>',
 'pulse':'<path d="M2 12h4l3-7 5 14 3-7h5"/>',
 'route':'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M5 7v7a5 5 0 0 0 5 5h7M8 5h7a4 4 0 0 1 4 4v3m-3-3 3 3 3-3"/>',
 'shield':'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
 'memory':'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z"/>',
 'refresh':'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
 'people':'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a5 5 0 0 0-2-4"/>',
 'plug':'<path d="M8 3v6m8-6v6M5 9h14v3a7 7 0 0 1-14 0V9Zm7 10v3"/>',
 'cloud':'<path d="M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 2 4 4 0 0 1 0 8H7Z"/>',
 'spark':'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>',
 'print':'<path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6v-7Z"/><path d="M17 11h1"/>',
 'check':'<path d="m5 12 4 4L19 6"/>',
 'bookmark':'<path d="M6 3h12v19l-6-4-6 4V3Z"/>',
}
sprite = '<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">'+''.join(f'<symbol id="i-{key}" viewBox="0 0 24 24">{value}</symbol>' for key,value in icons.items())+'</svg>'
def icon(match):
    key = match.group(1)
    assert key in icons, key
    return f'<svg class="icon" aria-hidden="true"><use href="#i-{key}"/></svg>'
def cite(match):
    return ''.join(f'<a class="cite" target="_blank" rel="noopener" href="{escape(lookup[key]["url"])}" title="{escape(lookup[key]["claim"])}" aria-label="查看源码证据 {key}">{key}</a>' for key in match.group(1).split())
body = (ROOT/'body.html').read_text(encoding='utf-8-sig')
body = re.sub(r'\{\{icon:([a-z]+)\}\}', icon, body)
body = re.sub(r'\[\[([A-Z0-9 ]+)\]\]', cite, body)
source_cards = ''.join(f'<article class="source" id="source-{row["id"]}"><span class="source-id">{row["id"]}</span><strong>{escape(row["repo"])}</strong><p>{escape(row["claim"])}</p><a href="{escape(row["url"])}" target="_blank" rel="noopener">{escape(row["path"])} · L{row["start"]}–L{row["end"]}</a></article>' for row in evidence)
body = body.replace('{{SOURCES}}',source_cards)
body = body.replace('{{REVIEW}}',(ROOT/'review-note.html').read_text(encoding='utf-8-sig'))
body = body.replace('{{SNAPSHOTS}}','<ul>'+''.join(f'<li>{row["repo"]} · <code>{row["sha"]}</code></li>' for row in snapshots)+'</ul>')
css = (ROOT/'style.css').read_text(encoding='utf-8')
js = (ROOT/'interactions.js').read_text(encoding='utf-8')
nav = ''.join(f'<a href="#{key}">{label}</a>' for key,label in [('principles','产品'),('experience','体验'),('architecture','架构'),('lifecycle','契约'),('delivery','交付'),('sources','源码')])
page = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="description" content="ArkCode 基于 pi-coding-agent SDK 的首版产品与架构设计，包含交互工作台、SVG 架构图、状态机、权限和交付验收。"><title>ArkCode · 产品与架构设计</title><style>{css}</style></head><body>{sprite}<a class="skip" href="#main">跳到正文</a><header class="topbar"><a class="brand" href="#overview"><span class="brand-mark"><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg></span>arkcode</a><nav class="topnav" aria-label="主要章节">{nav}</nav><span class="version">DESIGN PROPOSAL / 01</span></header><div class="reading-progress" aria-hidden="true"></div><main id="main" class="shell">{body}</main><script>{js}</script></body></html>'''
assert '{{' not in page and '[[' not in page
class CheckHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids=[]
        self.anchors=[]
        self.external_assets=[]
        self.svg_count=0
    def handle_starttag(self,tag,attrs):
        row=dict(attrs)
        if 'id' in row:self.ids.append(row['id'])
        if tag in ('a','use') and row.get('href','').startswith('#'):self.anchors.append(row['href'][1:])
        if tag in ('script','img','iframe','link') and (row.get('src') or row.get('href')):self.external_assets.append(row)
        if tag=='svg' and row.get('role')=='img':self.svg_count+=1
parser=CheckHTML()
parser.feed(page)
assert len(set(parser.ids))==len(parser.ids),'Duplicate IDs'
assert set(parser.anchors)<=set(parser.ids),set(parser.anchors)-set(parser.ids)
assert not parser.external_assets,parser.external_assets
assert parser.svg_count==3
(ROOT/'arkcode-design.html').write_text(page,encoding='utf-8')
(ROOT/'sources.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
old=json.loads((ROOT/'validation.json').read_text(encoding='utf-8')) if (ROOT/'validation.json').exists() else {}
result={'generated_at':datetime.now(timezone(timedelta(hours=8))).isoformat(),'source_count':len(evidence),'source_checks':checks,'snapshots':snapshots,'unique_ids':True,'resolved_anchors_and_svg_symbols':True,'external_assets':0,'accessible_svg_diagrams':parser.svg_count,'standalone_html_bytes':len(page.encode()),'browser':old.get('browser','pending'),'review':old.get('review','pending'),'application_implemented':False,'real_model_or_recovery_tests':'not run; design artifact only'}
(ROOT/'validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({key:value for key,value in result.items() if key not in ('source_checks','snapshots')},ensure_ascii=False,indent=2))
