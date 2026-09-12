'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const F = require('../core/dev-file-workflow');
const W = require('../renderer/workflow-templates');
const D = require('../core/dev-discuss');
const Docs = require('../core/dev-task-docs');
const root = path.resolve(__dirname, '..');
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw Error('需要未占用的交付路径');
const base = execFileSync('git', ['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const entries=[];
function add(id,title,group,trigger,source,text,added=false){entries.push({id,title,group,trigger,source,original:text,added});}
const meeting={groupChat:true,scene:'dev',workspace:'{{项目根目录}}',serialWorkflow:{fileFlowVersion:2}};
const dir='{{任务目录}}';
add('one-click-start','一键开工','主流程','普通 session 点击后预填，用户发送后授权执行','renderer/one-click-start.js',require('../renderer/one-click-start').PROMPT,true);
add('prep','立项','主流程','点击立项，仅填入输入框','core/dev-file-workflow.js · PROJECT_PREP_PROMPT',F.PROJECT_PREP_PROMPT);
add('common','双 Agent 通用约束','主流程','每个 Agent 首次成功送达；协议或项目角色变化时更新','core/dev-file-workflow.js · common',F.common(meeting,dir));
for(const [phase,n,title] of [['kickoff',0,'开题'],['build',1,'首次实现'],['build',2,'返工实现'],['merge',1,'验证与合并']]){
  const prompt=F.phasePrompt(meeting,dir,F.spec(phase,n));
  add(phase+'-'+n,title,'主流程',phase==='kickoff'?'点击开题预填，检查后发送':'上一阶段文件交付后自动派发；轮次和路径动态替换','core/dev-file-workflow.js · phasePrompt',prompt);
}
add('locator','工作根下的项目定位','主流程','仅用户手动选择默认工作根时追加；项目列表为动态变量','renderer/workflow-templates.js · buildProjectLocatorPrompt',W.createTemplateConfig('dev-task',[{memberId:'m1'},{memberId:'m2'}],{workspace:{atWorkRoot:true,projects:[{name:'{{项目名称}}',path:'{{项目路径}}'}]}}).projectLocator);
add('solo-common','历史单 Agent 通用约束','旧版兼容','仅保留已存在单人群聊的接续','core/dev-file-workflow.js · soloCommon',F.soloCommon({...meeting,serialWorkflow:{...meeting.serialWorkflow,soloDevelopment:true}}),true);
add('independent','历史独立开工','旧版兼容','已移除按钮；仅供历史提示词查阅','core/dev-file-workflow.js · independentPrompt',F.independentPrompt(),true);
const room=fs.readFileSync(path.join(root,'renderer/meeting-room.js'),'utf8');
const start=room.indexOf('    dev: ['); const end=room.indexOf('\n    ],',start);
const hats=vm.runInNewContext('(['+room.slice(start+'    dev: ['.length,end)+'])');
for(const h of hats) add('hat-'+h.id,h.label,'可选职责帽','仅手动给成员戴此职责帽时生效；职责和输出格式合为一项','renderer/meeting-room.js · dev/'+h.id,h.duty+'\n输出格式：'+h.format);
for(const id of ['dev-task']){
  const c=W.createTemplateConfig(id,[{memberId:'m1'},{memberId:'m2'}],{devPhase:'build'});
  c.stepConfigs.forEach((s,i)=>add(id+'-'+i,s.name,'旧版兼容','旧版双席位循环；新版创建不使用','renderer/workflow-templates.js · '+id+'/'+i,s.prompt));
}
const discuss=D.buildDiscussBlock();
add('legacy-discuss','旧版讨论通用块','旧版兼容','旧版开发群聊讨论阶段','core/dev-discuss.js · buildDiscussBlock',discuss);
for(const role of ['worker','merger']){
  const lines=D.buildDiscussBlock({role}).split('\n').filter(l=>!discuss.split('\n').includes(l));
  add('legacy-discuss-'+role,'旧版讨论：'+(role==='worker'?'工作位':'合并位'),'旧版兼容','旧版讨论通用块中按角色插入','core/dev-discuss.js · ROLE_LINES.'+role,lines.join('\n'));
}
add('legacy-kickoff','旧版开题','旧版兼容','旧版开题按钮','core/dev-discuss.js · buildKickoffPrompt',D.buildKickoffPrompt());
add('legacy-converge','旧版收敛','旧版兼容','旧版收敛按钮','core/dev-discuss.js · CONVERGE_REQUEST',D.CONVERGE_REQUEST);
for(const [pos,label] of [[0,'开题'],[1,'实现'],[2,'合并']]) add('legacy-doc-'+pos,'旧版文件交接：'+label,'旧版兼容','旧版各阶段追加，路径和轮次动态替换','core/dev-task-docs.js · buildDocBlock',Docs.buildDocBlock({dir,pos}));
for(const t of [...W.TASK_PRESETS,...W.TEMPLATES].filter(t=>!t.id.startsWith('dev-task'))){
  const c=W.createTemplateConfig(t.id,[{memberId:'m1'},{memberId:'m2'},{memberId:'m3'}]);
  c.stepConfigs.forEach((s,i)=>add(t.id+'-'+i,t.name+' / '+s.name,'通用工作流','仅手动选择此工作流模板；不属于新建开发群聊的默认流程','renderer/workflow-templates.js · '+t.id+'/'+i,s.prompt));
}
const envelope=W.buildSerialStepPrompt('{{任务}}',{name:'{{步骤名称}}',prompt:'{{步骤正文}}'},0,3);
add('serial-envelope','通用串行派工包装','通用工作流','手动串行流程每一步外层包装；不是新增工作流','renderer/workflow-templates.js · buildSerialStepPrompt',envelope);
const data={base,generatedAt:new Date().toISOString(),entries};
const payload=JSON.stringify(data).replace(/</g,'\\u003c');
const html=String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI HUB 开发 prompt 编辑台</title><style>
.note{overflow-wrap:anywhere}
:root{color-scheme:light;--ink:#17312b;--muted:#62756f;--line:#d6e1da;--green:#12654f;--bg:#f3f6f0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 'Microsoft YaHei',system-ui,sans-serif}header{padding:30px 4vw 22px;background:#143b31;color:#f7faf3}header small{letter-spacing:2px;color:#a5c7b7}h1{margin:5px 0;font-size:30px}header p{max-width:1100px;margin:8px 0;color:#d5e4d8}.stats{display:flex;gap:25px;margin-top:16px;flex-wrap:wrap}.stats strong{font-size:25px;color:#dbf49f}.toolbar{position:sticky;top:0;z-index:3;padding:14px 4vw;background:#f3f6f0f5;border-bottom:1px solid var(--line);display:flex;gap:9px;flex-wrap:wrap}button,select,input{font:inherit;border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink);padding:7px 11px}button{cursor:pointer}button:hover{border-color:var(--green)}button.primary{background:var(--green);color:white}input[type=search]{flex:1;min-width:200px}main{padding:22px 4vw;display:grid;grid-template-columns:270px minmax(0,1fr);gap:26px}aside{position:sticky;top:144px;align-self:start;max-height:75vh;overflow:auto}nav button{display:block;width:100%;text-align:left;margin:5px 0;background:transparent}nav button.active{background:#dbe9da;border-color:#4b8365}.note{font-size:13px;color:var(--muted);padding:14px 0}article{background:white;border:1px solid var(--line);border-radius:14px;padding:23px;box-shadow:0 6px 25px #12352108;margin-bottom:20px}.tag{display:inline-block;font-size:12px;background:#e9f0e4;padding:2px 9px;border-radius:12px;margin-right:7px}.new{background:#fdf0cd}h2{font-size:22px;margin:10px 0 4px}.meta{color:var(--muted);font-size:13px;overflow-wrap:anywhere}.editgrid{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:17px}label{display:block;font-size:13px;font-weight:600}textarea,pre{font:14px/1.8 'Microsoft YaHei',sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line);border-radius:8px;background:#fafcf8;padding:14px;width:100%;min-height:250px;margin:7px 0;resize:vertical;color:var(--ink)}pre{max-height:540px;overflow:auto}textarea{background:white}textarea:focus{outline:2px solid #86ae8a}.comment{min-height:70px}.foot{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.dirty{color:#a15c00}.delta{border-left:3px solid #92ae67;padding-left:12px}.status{font-size:13px;color:var(--green)}details{margin:8px 0}summary{cursor:pointer}#toast{position:fixed;bottom:20px;right:25px;background:#153e31;color:white;padding:12px 20px;border-radius:10px;display:none;z-index:6}@media(max-width:900px){main{grid-template-columns:1fr}aside{position:static;max-height:none}nav{display:flex;flex-wrap:wrap;gap:6px}nav button{width:auto}.editgrid{grid-template-columns:1fr}header{padding-top:20px}}@media print{.toolbar,aside,button{display:none}main{display:block}.editgrid{display:block}article{break-inside:avoid}}
</style></head><body><header><small>AI HUB / PROMPT WORKBENCH / 2026.09.10</small><h1>先把流程变简单，再把 prompt 写短</h1><p>主流程包含普通会话「一键开工」与双 Agent 文件协作。单人群聊预设仅列为历史兼容。按可单独维护的文本块统计；共享约束只计一次，首次实现与返工分开。不是每轮都会发送全部内容。</p><div class="stats" id="stats"></div><p>改动：开发排第一并默认选中 · 默认选择已有路径 · 删除起手卡片 · 单人使用普通会话「一键开工」，开发群聊至少两人。</p></header>
<div class="toolbar"><input id="search" type="search" placeholder="搜索名称、原文或修改稿"><select id="filter"><option>主流程</option><option>可选职责帽</option><option>旧版兼容</option><option>通用工作流</option><option>全部</option><option>只看修改</option></select><button id="exportJson" class="primary">导出修改 JSON</button><button id="exportMd">导出审阅 Markdown</button><button id="saveHtml">保存含修改的 HTML</button><button id="import">导入修改</button><input id="file" type="file" accept=".json" hidden><span class="status" id="status"></span></div>
<main><aside><div class="delta"><b>建议从这 3 处下手</b><p>1. 首次协议与阶段指令分开维护。<br>2. 验证与合并正文最长。<br>3. 一键开工不要求固定文件流。</p></div><nav id="nav"></nav><details><summary>统计与修改边界</summary><div class="note">本页完整列出主流程、8 个职责帽、旧版开发协议，以及可选通用工作流。{{变量}} 表示运行时填入的路径或任务。共享聊天包装、英雄人格、模型系统指令和项目 AGENTS/合同属于其他层，不计入开发预置数。<br><br>这里修改的是本地审阅草稿，不会直接改生产 Hub。导出文件交回后才能应用。空修改稿表示建议清空该项，不自动删除流程功能。<br><br>普通会话由 Agent 自主完成；双 Agent 合并位独立验证，历史群聊记录保留。</div></details><div class="note" id="provenance"></div></aside><section><div id="count" class="note"></div><div id="cards"></div></section></main><div id="toast" role="status"></div>
<script id="catalog" type="application/json">${payload}</script><script id="embedded-drafts" type="application/json">{}</script>
<script>
const DATA=JSON.parse(document.getElementById('catalog').textContent),KEY='aihub-dev-prompts-20260910-'+DATA.base;let drafts=JSON.parse(document.getElementById('embedded-drafts').textContent),storage=true;
try{const saved=localStorage.getItem(KEY);if(saved)drafts={...drafts,...JSON.parse(saved)}}catch(e){storage=false}
const $=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function value(e){return Object.hasOwn(drafts,e.id)?drafts[e.id].text:e.original}function comment(e){return drafts[e.id]?.comment||''}function changed(e){return value(e)!==e.original||!!comment(e)}
function toast(t){$('toast').textContent=t;$('toast').style.display='block';setTimeout(()=>$('toast').style.display='none',2800)}
function persist(){try{localStorage.setItem(KEY,JSON.stringify(drafts));storage=true}catch(e){storage=false} $('status').textContent=storage?'草稿已保存到此浏览器':'自动保存不可用，请导出文件';}
const groups=['主流程','可选职责帽','旧版兼容','通用工作流'];$('stats').innerHTML=groups.map(g=>'<span><strong>'+DATA.entries.filter(e=>e.group===g).length+'</strong> '+g+'</span>').join('');
$('nav').innerHTML=groups.map(g=>'<button data-group="'+g+'">'+g+'</button>').join('');$('nav').onclick=e=>{if(e.target.dataset.group){$('filter').value=e.target.dataset.group;render();window.scrollTo({top:0,behavior:'smooth'})}};
$('provenance').textContent='来源基线 SHA：'+DATA.base+'。提取时间：'+DATA.generatedAt+'。标注“新增”的两项是本次候选，其余为当前代码原文或明确拆出的共享片段。';
function render(){const q=$('search').value.toLowerCase(),filter=$('filter').value;const rows=DATA.entries.filter(e=>(filter==='全部'||(filter==='只看修改'?changed(e):e.group===filter))&&[e.title,e.original,value(e)].join(' ').toLowerCase().includes(q));$('count').textContent='显示 '+rows.length+' / 全部 '+DATA.entries.length+' 项 · 已修改 '+DATA.entries.filter(changed).length+' 项';$('nav').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.group===filter));$('cards').innerHTML=rows.map(e=>'<article data-id="'+e.id+'"><span class="tag">'+e.group+'</span>'+(e.added?'<span class="tag new">本次新增，尚未合入</span>':'')+'<h2>'+esc(e.title)+'</h2><div class="meta">'+esc(e.trigger)+'<br>来源：'+esc(e.source)+' · ID: '+e.id+'</div><div class="editgrid"><div><label>代码原文 · '+e.original.length+' 字符</label><pre>'+esc(e.original)+'</pre></div><div><label>你的修改稿</label><textarea aria-label="修改 '+esc(e.title)+'" data-edit="text">'+esc(value(e))+'</textarea></div></div><label>修改意图 / 删除或合并建议</label><textarea class="comment" data-edit="comment" aria-label="备注 '+esc(e.title)+'">'+esc(comment(e))+'</textarea><div class="foot"><span class="measure '+(changed(e)?'dirty':'')+'">'+measure(e)+'</span><div><button data-action="copy">复制修改稿</button> <button data-action="reset">恢复本项原文</button></div></div></article>').join('')||'<article>没有匹配项。</article>';}
function measure(e){const n=value(e).length;return (changed(e)?'已修改 · ':'未修改 · ')+n+' 字符'+(n<e.original.length?' · 减少 '+Math.round((1-n/e.original.length)*100)+'%':'')}
$('cards').addEventListener('input',ev=>{const a=ev.target.closest('article'),kind=ev.target.dataset.edit;if(!a||!kind)return;const e=DATA.entries.find(e=>e.id===a.dataset.id);drafts[e.id]={text:value(e),comment:comment(e),...drafts[e.id],[kind]:ev.target.value};persist();a.querySelector('.measure').textContent=measure(e);a.querySelector('.measure').classList.toggle('dirty',changed(e));$('count').textContent='已修改 '+DATA.entries.filter(changed).length+' / '+DATA.entries.length+' 项';});
$('cards').addEventListener('click',async ev=>{const action=ev.target.dataset.action;if(!action)return;const e=DATA.entries.find(e=>e.id===ev.target.closest('article').dataset.id);if(action==='reset'){delete drafts[e.id];persist();render()}else{try{await navigator.clipboard.writeText(value(e));toast('已复制')}catch(err){toast('复制不可用，请在修改框中全选复制')}}});
$('search').oninput=render;$('filter').onchange=render;
function download(name,text,type){const u=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function snapshot(){return {schema:'aihub-dev-prompt-review-v1',base:DATA.base,exportedAt:new Date().toISOString(),entries:DATA.entries.map(e=>({...e,text:value(e),comment:comment(e),changed:changed(e)}))}}
$('exportJson').onclick=()=>download('20260910-AIHUB-prompt修改.json',JSON.stringify(snapshot(),null,2),'application/json;charset=utf-8');
$('exportMd').onclick=()=>{const s=snapshot();download('20260910-AIHUB-prompt审阅.md','# AI HUB 开发 prompt 审阅\n\n基线：'+s.base+'\n\n'+s.entries.map(e=>'## '+e.title+' ['+e.id+']\n\n类别：'+e.group+'；来源：'+e.source+'\n\n触发：'+e.trigger+'\n\n'+e.text+'\n\n备注：'+(e.comment||'无')+'\n').join('\n'),'text/markdown;charset=utf-8')};
$('saveHtml').onclick=()=>{const doc=document.documentElement.cloneNode(true);doc.querySelector('#embedded-drafts').textContent=JSON.stringify(drafts).replace(/</g,'\\u003c');download('20260910-AIHUB-prompt编辑稿.html','<!doctype html>\n'+doc.outerHTML,'text/html;charset=utf-8');toast('已下载可继续编辑的 HTML')};
$('import').onclick=()=>$('file').click();$('file').onchange=async()=>{try{const f=$('file').files[0];if(!f)return;const d=JSON.parse(await f.text());if(d.schema!=='aihub-dev-prompt-review-v1'||d.base!==DATA.base||!Array.isArray(d.entries))throw Error('文件格式或基线版本不匹配');const next={...drafts};for(const e of d.entries){if(!DATA.entries.some(x=>x.id===e.id)||typeof e.text!=='string'||typeof e.comment!=='string')throw Error('条目不合法');next[e.id]={text:e.text,comment:e.comment}}drafts=next;persist();render();toast('已导入修改')}catch(e){toast('导入失败：'+e.message)}finally{$('file').value=''}};
window.addEventListener('beforeunload',e=>{if(!storage&&Object.keys(drafts).length){e.preventDefault();e.returnValue=''}});render();$('status').textContent=storage?'修改后自动保存在此浏览器':'请用导出保存修改';
</script></body></html>`;
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html,'utf8');
console.log(JSON.stringify({output,base,total:entries.length,counts:Object.fromEntries([...new Set(entries.map(e=>e.group))].map(g=>[g,entries.filter(e=>e.group===g).length]))},null,2));
