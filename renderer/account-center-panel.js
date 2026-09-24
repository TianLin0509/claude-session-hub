'use strict';
const {accountRows,accountCards,featureName,featureAction,cardAction,needsAttention,describe}=require('./account-center-view');
function createAccountCenterPanel({document,ipcRenderer,escapeHtml:esc,configModal,closeOtherPanels=()=>{}}){
 const page=document.getElementById('account-page'),body=page.querySelector('.ac-content');
 let snapshot={connections:[],history:[]},view='list',error='',notice='',loading=false,timer,previousFocus;
 let showOthers=false,showHistory=false,sweeping=false,epoch=0,viewEpoch=0;
 const busy=new Set();
 const marks={claude:'CL',codex:'CX',chatgpt:'AI',images:'AI',bridge:'AI','chatgpt-web':'AI',deepseek:'D',doubao:'豆',kimi:'K',qwen:'Q',gemini:'G','token-plan':'百',feishu:'飞',server:'服'};
 async function call(action,args){const r=await ipcRenderer.invoke('accounts:'+action,args);if(!r?.ok)throw Error(r?.error||'账号服务未响应');return r.data;}
 function editing(){return page.contains(document.activeElement)&&document.activeElement.matches('input:not([type="checkbox"]),textarea,select,[contenteditable="true"]');}
 const btn=(label,action,id,cls='')=>`<button class="ac-btn ${cls}" data-ac="${action}" data-id="${esc(id||'')}" ${busy.has(id)?'disabled':''}>${esc(label)}</button>`;
 function renderStatus(){
  const status=page.querySelector('.ac-status'),text=error||notice||(loading?'正在读取账号状态…':'');
  if(status.textContent!==text)status.textContent=text;
  status.classList.toggle('error',!!error);
  status.hidden=!text;
  page.querySelector('[data-ac="refresh"]').disabled=sweeping;
 }
 function featureHtml(row,showMark){
  const act=featureAction(row),name=featureName(row),state=describe(row);
  const detail=[state.text,row.groupNote].filter(Boolean).join(' · ');
  return `<li class="ac-feature" data-feature="${esc(row.id)}">${showMark?`<span class="ac-avatar small ac-avatar-${esc(row.provider)}" aria-hidden="true">${esc(marks[row.provider]||'·')}</span>`:`<span class="ac-dot ${state.tone}" aria-hidden="true"></span>`}<span class="ac-feature-name">${esc(name)}</span><span class="ac-feature-state">${esc(detail)}</span>${btn(act.label,act.action,act.id,'ghost')}</li>`;
 }
 // A single-use account is one line: repeating its name as a sub-row would say nothing new.
 function soloHtml(card){
  const row=card.features[0],act=featureAction(row),state=describe(row);
  const detail=[state.text,row.groupNote].filter(Boolean).join(' · ');
  const sub=[featureName(row),card.identity].filter(Boolean).join(' · ');
  return `<article class="ac-card solo ${card.attention?'attention':''}" data-card="${esc(card.key)}">
  <div class="ac-feature ac-card-head" data-feature="${esc(row.id)}"><span class="ac-avatar ac-avatar-${esc(card.platform)}" aria-hidden="true">${esc(card.mark)}</span>
  <div class="ac-card-title"><strong>${esc(card.name)}</strong><small>${esc(sub)}</small></div>
  <span class="ac-dot ${state.tone}" aria-hidden="true"></span><span class="ac-feature-state">${esc(detail)}</span>
  ${btn(act.label,act.action,act.id,'ghost')}</div></article>`;
 }
 function cardHtml(card){
  if(card.features.length===1)return soloHtml(card);
  const act=cardAction(card);
  const summary=[card.identity,`${card.signedIn}/${card.total} 项已登录`].filter(Boolean).join(' · ');
  return `<article class="ac-card ${card.attention?'attention':''}" data-card="${esc(card.key)}">
  <div class="ac-card-head"><span class="ac-avatar ac-avatar-${esc(card.platform)}" aria-hidden="true">${esc(card.mark)}</span>
  <div class="ac-card-title"><strong>${esc(card.name)}</strong><small>${esc(summary)}</small></div>
  ${card.attention?`<span class="ac-pill warn">${card.attention} 项待登录</span>`:card.signedIn===card.total?'<span class="ac-pill ok">全部已登录</span>':''}
  <button class="ac-btn ${act.primary?'primary':'ghost'}" data-ac="card-login" data-card="${esc(card.key)}" ${act.ids.some(id=>busy.has(id))?'disabled':''}>${esc(act.label)}</button></div>
  ${card.note?`<p class="ac-card-note">${esc(card.note)}</p>`:''}
  <ul class="ac-features">${card.features.map(r=>featureHtml(r,false)).join('')}</ul></article>`;
 }
 function render(){
  if(page.hidden)return;position();
  const rows=accountRows(snapshot.connections),{cards,others}=accountCards(rows);
  const attention=rows.filter(needsAttention);
  const count=document.getElementById('accounts-attention');
  if(count){count.textContent=attention.length;count.hidden=!attention.length;count.title=`${attention.length} 处账号需要登录`;}
  const editor=document.getElementById('account-editor');
  editor.hidden=view!=='config';body.hidden=view==='config';
  page.querySelector('[data-ac="back"]').hidden=view!=='config';
  renderStatus();
  if(view==='config')return;
  body.innerHTML=`<div class="ac-cards">${cards.map(cardHtml).join('')}</div>
  <section class="ac-extra"><button class="ac-extra-head" data-ac="toggle-others" aria-expanded="${showOthers}"><span>其他接入</span><small>API 密钥、服务授权 ${others.length} 项</small><i aria-hidden="true">${showOthers?'▾':'▸'}</i></button>${showOthers?`<ul class="ac-features plain">${others.map(r=>featureHtml(r,true)).join('')}</ul>`:''}</section>
  <section class="ac-extra"><button class="ac-extra-head" data-ac="toggle-history" aria-expanded="${showHistory}"><span>最近活动</span><small>只记录操作结果，不保存验证码或密钥</small><i aria-hidden="true">${showHistory?'▾':'▸'}</i></button>${showHistory?(snapshot.history.length?`<ul class="ac-log">${snapshot.history.map(x=>`<li><time>${esc(new Date(x.at).toLocaleString('zh-CN',{hour12:false}))}</time><strong>${esc(x.name)}</strong><span>${esc(x.message)}</span></li>`).join('')}</ul>`:'<p class="ac-empty">暂无账号操作记录</p>'):''}</section>`;
 }
 function renderPreservingView(){
  const top=body.scrollTop,active=document.activeElement;
  const focus=page.contains(active)?{tag:active.tagName,data:{...active.dataset}}:null;
  render();
  if(focus&&!active.isConnected&&Object.keys(focus.data).length){
   const replacement=[...page.querySelectorAll(focus.tag)].find(el=>Object.entries(focus.data).every(([k,v])=>el.dataset[k]===v));
   replacement?.focus({preventScroll:true});
  }
  body.scrollTop=top;
 }
 function position(){const rail=document.getElementById('scene-rail')?.getBoundingClientRect();if(rail){page.style.left=rail.right+'px';page.style.top=rail.top+'px';}}
 async function refresh({background=false}={}){
  if(background&&(loading||editing()))return;
  const ticket=++epoch;loading=true;let changed=false;
  if(!background)renderStatus();
  try{
   const value=await call('snapshot');
   if(ticket!==epoch||page.hidden||background&&(editing()||busy.size||view==='config'))return;
   changed=JSON.stringify(value)!==JSON.stringify(snapshot);snapshot=value;error='';
  }catch(e){if(ticket===epoch)error=e.message;}
  finally{if(ticket===epoch){loading=false;if(!page.hidden){if(changed||!background)renderPreservingView();else renderStatus();}}}
 }
 async function operate(action,id){
  if(!id||busy.has(id))return;
  busy.add(id);error='';notice='';render();
  const ticket=viewEpoch;
  try{
   if(action==='relogin'){await call('release',{id});await call('login',{id});}
   else if(action==='resume')await call('check',{id});
   else await call(action,{id});
   if(page.hidden||ticket!==viewEpoch)return;
   notice=action==='open'?'已打开原账号网页；登录资料保留在原浏览器。':action==='resume'?'已请求继续等待登录的网页任务；已发送的问题只补收。':'已打开官方登录窗口；完成后这里会自动确认。';
   await refresh();
  }catch(e){if(!page.hidden&&ticket===viewEpoch){error=e.message;render();}}
  finally{busy.delete(id);render();}
 }
 async function loginCard(key){
  const {cards}=accountCards(accountRows(snapshot.connections));
  const card=cards.find(c=>c.key===key);if(!card)return;
  const ids=cardAction(card).ids.filter(id=>!busy.has(id));
  if(!ids.length)return;
  if(ids.length===1)return operate('login',ids[0]);
  for(const id of ids)busy.add(id);
  error='';notice='';render();
  const ticket=viewEpoch;
  try{
   const result=await call('login-many',{ids});
   if(page.hidden||ticket!==viewEpoch)return;
   notice=result?.message||'已逐个打开官方登录窗口；已登录的会跳过。';
   await refresh();
  }catch(e){if(!page.hidden&&ticket===viewEpoch){error=e.message;render();}}
  finally{for(const id of ids)busy.delete(id);render();}
 }
 async function checkAll(){
  if(sweeping)return;
  sweeping=true;error='';notice='';loading=true;renderStatus();
  const ticket=viewEpoch;
  try{const result=await call('check-all');if(page.hidden||ticket!==viewEpoch)return;notice=result?.message||'状态已刷新。';}
  catch(e){if(!page.hidden&&ticket===viewEpoch)error=e.message;}
  finally{sweeping=false;loading=false;if(!page.hidden&&ticket===viewEpoch)await refresh();else renderStatus();}
 }
 async function configure(provider='codex'){
  const ticket=viewEpoch;
  try{await configModal.openAccountConfig(provider);if(page.hidden||ticket!==viewEpoch)return;view='config';render();}
  catch(e){error=e.message;render();}
 }
 function close(){
  if(page.hidden)return;
  page.hidden=true;epoch++;viewEpoch++;loading=false;clearInterval(timer);
  document.body.classList.remove('accounts-open');
  document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded','false');
  if(previousFocus?.isConnected)previousFocus.focus();
 }
 async function open(provider){
  closeOtherPanels();configModal.close();
  const ticket=++viewEpoch;clearInterval(timer);previousFocus=document.activeElement;
  page.hidden=false;document.body.classList.add('accounts-open');
  document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded','true');
  view='list';error='';notice='';render();await refresh();
  if(page.hidden||ticket!==viewEpoch)return;
  timer=setInterval(()=>{if(!page.hidden&&view!=='config'&&busy.size===0)void refresh({background:true});},5000);
  if(provider)await configure(provider);
 }
 page.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  const action=b.dataset.ac;if(!action)return;
  if(action==='close')close();
  else if(action==='back'){view='list';render();}
  else if(action==='refresh')void checkAll();
  else if(action==='toggle-others'){showOthers=!showOthers;render();}
  else if(action==='toggle-history'){showHistory=!showHistory;render();}
  else if(action==='card-login')void loginCard(b.dataset.card);
  else if(action==='config')void configure(b.dataset.id);
  else if(['login','open','relogin','resume'].includes(action))void operate(action,b.dataset.id);
 });
 document.addEventListener('click',e=>{
  if(e.target.closest('#btn-rail-accounts')){if(page.hidden)void open();else close();}
  else if(e.target.closest('#scene-rail button')&&!page.hidden)close();
  if(e.target.closest('#btn-config-accounts'))void open();
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!page.hidden&&!page.querySelector('dialog[open]')){e.preventDefault();close();}});
 document.addEventListener('hub-account-config-saved',()=>{notice='账号配置已保存；Codex 全局账号对新建、恢复和重启生效，进行中的会话在本轮结束后切换。';void refresh();});
 window.addEventListener('resize',position);
 return {open,close,refresh};
}
module.exports={createAccountCenterPanel};
