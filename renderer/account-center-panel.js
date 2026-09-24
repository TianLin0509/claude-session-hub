'use strict';
const {accountRows,isPrimary,bindingRows,isOpenAI,accountSections,needsAttention,accountAction}=require('./account-center-view');
function createAccountCenterPanel({document,ipcRenderer,escapeHtml:esc,configModal,closeOtherPanels=()=>{}}){
 const page=document.getElementById('account-page'),body=page.querySelector('.ac-content');
 let snapshot={connections:[],history:[],batches:[]},selected='',selectedGroup='',filter='primary',statusFilter='all',query='',tab='overview',layout='list';
 let epoch=0,viewEpoch=0,error='',notice='',loading=false,busy=new Set(),timer,previousFocus,showOther=false,familyOpen=false;
 const expandedGroups=new Set();
 const batchUI=require('./account-batch-ui').createAccountBatchUI({page,call,refresh,rerender:()=>render(),escapeHtml:esc,isBusy:id=>busy.has(id),notice:(message,failed=false)=>{if(failed)error=message;else notice=message;render();}});
 const labels={signed_in:'已登录',login_required:'需要登录',configured:'已配置',unknown:'尚未确认',offline:'未在线',unavailable:'工具不可用',opening:'等待验证'};
 const marks={claude:'CL',codex:'CX',chatgpt:'AI',images:'AI',bridge:'AI','chatgpt-web':'AI',deepseek:'D',doubao:'豆',kimi:'K',qwen:'Q',gemini:'G'};
 const when=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'尚未检查';
 const state=r=>r.pending&&needsAttention(r)?'等待本人验证':r.stale?'上次'+(labels[r.state]||'未确认'):labels[r.state]||'未确认';
 const badge=r=>`<span class="ac-badge ${esc(r.state)} ${r.stale?'stale':''} ${needsAttention(r)?'attention':''}">${esc(state(r))}</span>`;
 const btn=(title,action,id,cls='')=>`<button class="ac-btn ${cls}" data-ac="${action}" data-id="${esc(id||'')}" ${busy.has(id)?'disabled':''}>${esc(title)}</button>`;
 const mark=r=>`<span class="ac-avatar ac-avatar-${esc(isOpenAI(r)?'openai':r.provider)}" aria-hidden="true">${esc(marks[r.provider]||'·')}</span>`;
 async function call(action,args){const r=await ipcRenderer.invoke('accounts:'+action,args);if(!r?.ok)throw Error(r?.error||'账号服务未响应');return r.data;}
 function editing(){return !!page.querySelector('.ac-code-dialog[open]')||page.contains(document.activeElement)&&document.activeElement.matches('input:not([type="checkbox"]),textarea,select,[contenteditable="true"]');}
 function renderStatus(){
  const status=page.querySelector('.ac-status'),text=error||notice||(loading?'正在读取账号状态…':'');
  if(status.textContent!==text)status.textContent=text;
  status.classList.toggle('error',!!error);
  batchUI.setNotice(error||notice);
 }
 function renderPreservingView(){
  const top=body.scrollTop,left=body.scrollLeft,active=document.activeElement;
  const scope=active?.closest('.ac-detail,.ac-row,.ac-task-dialog'),scopeClass=scope?.classList.contains('ac-detail')?'.ac-detail':scope?.classList.contains('ac-row')?'.ac-row':scope?'.ac-task-dialog':'';
  const focus=page.contains(active)?{tag:active.tagName,id:active.id,data:{...active.dataset}}:null;
  const details=['.ac-family','.ac-members','.ac-batch-progress','.ac-recovery details'].map(selector=>({selector,open:body.querySelector(selector)?.open}));
  const scrolls=['.ac-batch-results','.ac-task-dialog'].map(selector=>({selector,top:page.querySelector(selector)?.scrollTop}));
  render();
  for(const {selector,open} of details)if(open!==undefined){const el=body.querySelector(selector);if(el)el.open=open;}
  if(focus&&!active.isConnected){
   const replacement=[...page.querySelectorAll((scopeClass?scopeClass+' ':'')+focus.tag)].find(el=>el.id===focus.id&&Object.keys(focus.data).length>0&&Object.entries(focus.data).every(([key,value])=>el.dataset[key]===value));
   replacement?.focus({preventScroll:true});
  }
  for(const {selector,top:scrollTop} of scrolls)if(scrollTop!==undefined){const el=page.querySelector(selector);if(el)el.scrollTop=scrollTop;}
  body.scrollTop=top;body.scrollLeft=left;
 }
 function position(){const rail=document.getElementById('scene-rail')?.getBoundingClientRect();if(rail){page.style.left=rail.right+'px';page.style.top=rail.top+'px';}}
 function rowHtml(r){
  const action=accountAction(r);
  return `<article class="ac-row ${selected===r.id?'selected':''}"><div class="ac-row-identity">${mark(r)}<div class="ac-row-copy"><button class="ac-name" data-ac="select" data-id="${esc(r.id)}">${esc(r.name)}${r.isDefault?'<span class="ac-tag">默认</span>':''}</button><p>${esc(r.identity||'身份未确认')}</p><small class="ac-row-uses">${esc(r.uses.join(' · '))}</small></div></div><div class="ac-row-status">${badge(r)}<small>${esc(r.webRecovery?.length?r.webRecovery.length+' 项任务待恢复':r.pending?'完成后检查登录':when(r.observedAt))}</small></div><div class="ac-row-actions">${btn(action.label,action.action,action.id,needsAttention(r)?'attention':'')}${btn('账号详情','select',r.id,'ac-link')}</div></article>`;
 }
 function listHtml(rows){return accountSections(rows).map(section=>{
  if(section.id!=='openai')return section.rows.map(rowHtml).join('');
  const active=section.rows.filter(r=>r.enabled!==false),confirmed=active.filter(r=>r.state==='signed_in'&&!r.stale).length,needed=active.filter(needsAttention).length;
  return `<details class="ac-family" data-account-family="openai" ${familyOpen||query.trim()||statusFilter!=='all'?'open':''}><summary><span class="ac-avatar ac-avatar-openai" aria-hidden="true">AI</span><span class="ac-family-title"><strong>OpenAI</strong><small>Codex · ChatGPT · 生图 · 公司中转</small></span><span class="ac-family-status">${confirmed}/${active.length} 处已确认${needed?`<span class="ac-family-needed">${needed} 处需处理</span>`:''}</span><span class="ac-family-toggle">展开</span></summary><p class="ac-muted ac-family-note">同平台集中管理，各用途授权分别确认；当前仍沿用各工具的登录资料。</p><div class="ac-family-connections">${section.rows.map(rowHtml).join('')}</div></details>`;
 }).join('');}
 function detailHtml(row){
  if(!row)return '<p class="ac-muted">选择一个账号查看用途与登录详情。</p>';
  const action=accountAction(row);
  const recovery=row.webRecovery||[];
  return `<div class="ac-detail-heading">${mark(row)}<div><h2>${esc(row.name)}</h2><p class="ac-muted">${esc(row.identity||'身份未确认')}</p></div></div>${badge(row)}${recovery.length?`<section class="ac-recovery"><h3>${recovery.length} 项网页任务等待继续</h3><p>完成官方验证后点「检查并继续任务」。其他网站已完成的回答会保留。</p><details><summary>查看任务进度</summary>${recovery.map(t=>`<p>${esc(t.message)}<br><small>${esc(t.id)}</small></p>`).join('')}</details></section>`:''}<div class="ac-detail-primary">${btn(action.label,action.action,action.id,'primary')}</div><h3>这个账号用在哪里</h3><div class="ac-uses">${row.uses.map(use=>`<div>${esc(use)}</div>`).join('')}</div>${isOpenAI(row)?'<p class="ac-note">网页登录与 Codex 客户端授权分别保存。此处登录成功不代表其他用途已授权。</p>':''}<h3>登录与保留</h3><dl><dt>确认来源</dt><dd>${esc(row.source||'配置发现')}</dd><dt>检查时间</dt><dd>${esc(when(row.observedAt))}</dd><dt>登录方式</dt><dd>${esc(row.loginHint||'沿用原工具登录')}</dd></dl><p class="ac-note">${esc(row.message||'尚未检查')}</p>${row.groupNote?`<p class="ac-muted">${esc(row.groupNote)}</p>`:''}${row.members?.length>1?`<details class="ac-members" data-group="${esc(row.loginGroup)}" ${expandedGroups.has(row.loginGroup)?'open':''}><summary>连接详情（${row.members.length}）</summary>${row.members.map(m=>`<div class="ac-member"><strong>${esc(m.accountId)}</strong><span>${esc(m.enabled===false?'已停用':state(m))}</span><div>${btn('打开网页','open',m.id)}${btn('登录','login',m.id)}${btn('检查','check',m.id)}${m.pending?btn('解除等待','release',m.id):''}</div></div>`).join('')}</details>`:''}${row.toolState?`<p class="ac-muted">${esc(row.toolState)}</p>`:''}<div class="ac-detail-actions">${btn(recovery.length?'检查并继续任务':'检查登录','check',row.id)}${row.action==='login'?btn('重新登录','login',row.id):''}${row.configProvider?btn('接入与账号配置','config',row.configProvider):''}${row.pending?btn('登录窗口已关闭，解除等待','release',row.id):''}</div><p class="ac-muted">${row.type==='native'?'切换默认账号只影响新会话，运行中的会话保持原身份。':row.type==='api'?'API Key 与网页登录独立。配置存在不代表有效或有余额。':'登录资料由原浏览器保留；关闭网页不代表退出登录。'}${row.stale?' 上次结果已超过 5 分钟，请重新检查。':''}</p>`;
 }
 function render(){
  if(page.hidden)return;position();
  const all=accountRows(snapshot.connections),primary=all.filter(isPrimary),otherCount=all.length-primary.length,attention=all.filter(needsAttention);
  const count=document.getElementById('accounts-attention');if(count){count.textContent=attention.length;count.hidden=!attention.length;count.title=`${attention.length} 处授权需要处理`;}
  page.querySelectorAll('[data-ac-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.acTab===tab);b.setAttribute('aria-selected',String(b.dataset.acTab===tab));});
  page.dataset.layout=layout;
  const editor=document.getElementById('account-editor');editor.hidden=tab!=='config';body.hidden=tab==='config';
  renderStatus();
  batchUI.update({...snapshot,connections:all});
  if(tab==='config')return;
  if(tab==='history'){body.innerHTML=`<h2>最近活动</h2><p class="ac-muted">仅记录操作结果，不保存验证码或密钥。</p>${snapshot.history.length?snapshot.history.map(x=>`<div class="ac-log"><time>${esc(when(x.at))}</time><strong>${esc(x.name)}</strong><span>${esc(x.message)}</span></div>`).join(''):'<p class="ac-empty">暂无账号操作记录</p>'}`;return;}
  if(tab==='bindings'){
   const groups=bindingRows(showOther?all:primary);
   body.innerHTML=`<div class="ac-bindings-head"><div><h2>功能与账号</h2><p class="ac-muted">每项功能只列一次，同一生图账号的并行浏览器合并展示。</p></div>${btn(showOther?'收起其他接入':`其他接入（${otherCount}）`,'scope')}</div><div class="ac-table"><table><thead><tr><th>功能</th><th>使用的账号</th><th>登录状态</th><th></th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.name)}</td><td>${g.accounts.map(r=>`<div class="ac-binding-item">${esc(r.name)}</div>`).join('')}</td><td>${g.accounts.map(r=>`<div class="ac-binding-item">${badge(r)}</div>`).join('')}</td><td>${g.accounts.map(r=>`<div class="ac-binding-item">${btn('查看账号','select',r.id)}</div>`).join('')}</td></tr>`).join('')}</tbody></table></div>`;return;
  }
  const list=all.filter(r=>(filter==='all'||(filter==='primary'?isPrimary(r):!isPrimary(r)))&&(statusFilter==='all'||(statusFilter==='attention'?needsAttention(r):r.state==='signed_in'&&!r.stale))&&[r.name,...r.uses,isOpenAI(r)?'OpenAI':''].join(' ').toLowerCase().includes(query.toLowerCase()));
  if(!list.some(r=>r.id===selected))selected=(list.find(r=>selectedGroup&&r.loginGroup===selectedGroup)||list.find(needsAttention)||list[0]||{}).id||'';
  const row=all.find(r=>r.id===selected);
  body.innerHTML=`<div class="ac-summary"><span><b>${accountSections(primary).length}</b>主要入口</span><span><b>${all.filter(r=>r.state==='signed_in'&&!r.stale&&r.enabled!==false).length}</b>已确认授权</span><span class="ac-summary-warn"><b>${attention.length}</b>需处理</span><span class="ac-muted">状态以实际检查结果为准</span></div>${attention.length?`<div class="ac-attention"><div><strong>${attention.length} 处授权需要你处理</strong><p>${esc(attention.slice(0,3).map(r=>r.name).join(' · '))}${attention.length>3?' 等':''}</p></div>${btn('集中处理 →','attention')}</div>`:''}<div class="ac-filters">${[['primary','主要账号'],['other',`其他接入（${otherCount}）`],['all','全部']].map(([id,name])=>btn(name,'filter',id,filter===id?'active':'')).join('')}<span class="ac-filter-divider"></span>${btn('需处理','status-filter','attention',statusFilter==='attention'?'active':'')}${btn('已登录','status-filter','signed_in',statusFilter==='signed_in'?'active':'')}<input id="ac-search" aria-label="搜索账号或用途" placeholder="搜索账号 / 用途" value="${esc(query)}"><div class="ac-layout-switch" aria-label="列表布局">${btn('列表','layout','list',layout==='list'?'active':'')}${btn('卡片','layout','cards',layout==='cards'?'active':'')}</div></div><div class="ac-grid"><div class="ac-list-area"><div class="ac-list-caption"><span>账号与用途</span><small>按已知身份收拢，不重复列生图通道</small></div><div class="ac-account-list">${list.length?listHtml(list):`<div class="ac-empty">没有匹配的账号${btn('清除筛选','clear-filter')}</div>`}</div><div class="ac-other-entry"><span>API 密钥、其他 CLI 与服务接入</span>${btn('管理 →','filter','other','ac-link')}</div><p class="ac-muted">网页圆桌复用对应网站的专用浏览器；生图与中转仍沿用原工具资料。</p></div><aside class="ac-detail">${detailHtml(row)}</aside></div>`;
  batchUI.decorate({...snapshot,connections:all});
 }
 async function refresh({background=false}={}){
  if(background&&(loading||editing()))return;
  const ticket=++epoch;loading=true;let changed=false;
  if(!background)renderStatus();
  try{
   const value=await call('snapshot');
   if(ticket!==epoch||page.hidden||background&&(editing()||busy.size||tab==='config'))return;
   changed=JSON.stringify(value)!==JSON.stringify(snapshot);snapshot=value;error='';
  }catch(e){if(ticket===epoch)error=e.message;}
  finally{if(ticket===epoch){loading=false;if(!page.hidden){if(changed||!background)renderPreservingView();else renderStatus();}}}
 }
 async function operate(action,id){if(busy.has(id))return;busy.add(id);error='';notice='';render();const ticket=viewEpoch;try{const result=await call(action,{id});if(page.hidden||ticket!==viewEpoch)return;notice=result?.message||(action==='release'?'已结束等待，没有退出账号。':'检查完成。');await refresh();}catch(e){if(!page.hidden&&ticket===viewEpoch){error=e.message;render();}}finally{busy.delete(id);render();}}
 async function configure(provider='codex'){const ticket=viewEpoch;try{batchUI.closeAttention();await configModal.openAccountConfig(provider);if(page.hidden||ticket!==viewEpoch)return;tab='config';render();}catch(e){error=e.message;render();}}
 function allRow(id){return accountRows(snapshot.connections).find(r=>r.id===id)||{};}
 function close(){if(page.hidden)return;page.hidden=true;batchUI.clear();epoch++;viewEpoch++;loading=false;clearInterval(timer);document.body.classList.remove('accounts-open');document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded','false');if(previousFocus?.isConnected)previousFocus.focus();}
 async function open(provider){closeOtherPanels();configModal.close();const ticket=++viewEpoch;clearInterval(timer);previousFocus=document.activeElement;page.hidden=false;document.body.classList.add('accounts-open');document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded','true');tab='overview';error='';notice='';render();await refresh();if(page.hidden||ticket!==viewEpoch)return;timer=setInterval(()=>{if(!page.hidden&&tab!=='config'&&busy.size===0)void refresh({background:true});},5000);if(provider)await configure(provider);}
 page.addEventListener('click',e=>{
  const summary=e.target.closest('.ac-family>summary,.ac-members>summary');
  if(summary&&!e.target.closest('input,button,a')){
   // The native toggle event is queued; save the click intent before another
   // action can replace this details element and discard that queued event.
   const details=summary.parentElement;
   if(details.matches('.ac-family')&&!query.trim()&&statusFilter==='all')familyOpen=!details.open;
   if(details.matches('.ac-members'))details.open?expandedGroups.delete(details.dataset.group):expandedGroups.add(details.dataset.group);
  }
  const b=e.target.closest('button');if(!b)return;if(b.dataset.acTab){tab=b.dataset.acTab;render();return;}
  const action=b.dataset.ac,id=b.dataset.id;
  if(action==='close')close();else if(action==='refresh')void refresh();
  else if(action==='select'){selected=id;selectedGroup=allRow(id).loginGroup||'';if(isOpenAI(allRow(id)))familyOpen=true;tab='overview';filter=isPrimary(allRow(id))?'primary':'other';statusFilter='all';query='';render();const detail=body.querySelector('.ac-detail');if(page.clientWidth<950)detail?.scrollIntoView({block:'start'});}
  else if(action==='scope'){showOther=!showOther;render();}
  else if(action==='filter'){filter=id;statusFilter='all';render();}
  else if(action==='status-filter'){statusFilter=statusFilter===id?'all':id;render();}
  else if(action==='clear-filter'){filter='primary';statusFilter='all';query='';render();}
  else if(action==='layout'){layout=id==='cards'?'cards':'list';render();}
  else if(action==='attention')batchUI.attention(id?[id]:undefined);
  else if(action==='config')void configure(id);
  else if(['check','login','open','release'].includes(action))void operate(action,id);
 });
 page.addEventListener('toggle',e=>{if(e.target.matches?.('.ac-family')&&e.target.isConnected&&!query.trim()&&statusFilter==='all')familyOpen=e.target.open;if(e.target.matches?.('.ac-members')&&e.target.isConnected){e.target.open?expandedGroups.add(e.target.dataset.group):expandedGroups.delete(e.target.dataset.group);}},true);
 page.addEventListener('input',e=>{if(e.target.id==='ac-search'){const pos=e.target.selectionStart;query=e.target.value;render();const field=page.querySelector('#ac-search');field.focus();field.setSelectionRange(pos,pos);}});
 document.addEventListener('click',e=>{if(e.target.closest('#btn-rail-accounts')){if(page.hidden)void open();else close();}else if(e.target.closest('#scene-rail button')&&!page.hidden)close();if(e.target.closest('#btn-config-accounts'))void open();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!page.hidden&&!page.querySelector('dialog[open]')){e.preventDefault();close();}});
 document.addEventListener('hub-account-config-saved',()=>{notice='账号配置已保存；Codex 全局账号对新建、恢复和重启生效，进行中的会话在本轮结束后切换。';void refresh();});
 window.addEventListener('resize',position);
 return {open,close,refresh};
}
module.exports={createAccountCenterPanel};
