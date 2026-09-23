'use strict';
const {needsAttention}=require('./account-center-view');
function createAccountBatchUI({page,call,refresh,rerender,notice,escapeHtml:esc,isBusy=()=>false}) {
 const chosen=new Set();let phone='',submitting=false,current,attentionDialog,attentionIds,uiEpoch=0;
 const stages={queued:'排队',checking:'检查中',signed_in:'已登录',waiting_code:'等待验证码',manual:'需要本人验证',failed:'未完成'};
 const doc=page.ownerDocument;
 function updateSelection(){
  for(const input of page.querySelectorAll('[data-ab-select]'))input.checked=chosen.has(input.dataset.abSelect);
  for(const input of page.querySelectorAll('[data-ab-group]')){
   const ids=[...input.closest('.ac-family').querySelectorAll('[data-ab-select]')].map(el=>el.dataset.abSelect);
   input.checked=!!ids.length&&ids.every(id=>chosen.has(id));input.indeterminate=ids.some(id=>chosen.has(id))&&!input.checked;
  }
  const b=page.querySelector('[data-ab="start"]');if(b){b.textContent=`一键登录所选（${chosen.size} 处授权）`;b.disabled=!chosen.size||submitting||!!current?.batches?.at(-1)?.running;}
  const selected=page.querySelector('.ac-selection-count');if(selected)selected.textContent=`已选择 ${chosen.size} 处授权`;
  const phoneRow=page.querySelector('.ac-phone-row');if(phoneRow)phoneRow.hidden=!chosen.size;
 }
 function update(snapshot){current=snapshot;for(const id of chosen)if(!snapshot.connections.some(r=>r.id===id&&r.action==='login'))chosen.delete(id);renderAttention();}
 function decorate(snapshot){
  update(snapshot);const content=page.querySelector('.ac-content');if(!content.querySelector('.ac-grid'))return;
  for(const el of content.querySelectorAll('.ac-row')){
   const row=snapshot.connections.find(r=>r.id===el.querySelector('[data-ac="select"]')?.dataset.id);if(!row)continue;
   if(row.action==='login'){const input=doc.createElement('input');input.type='checkbox';input.dataset.abSelect=row.id;input.checked=chosen.has(row.id);input.setAttribute('aria-label','选择 '+row.name);input.className='ac-select-account';el.firstElementChild.prepend(input);}
  }
  for(const family of content.querySelectorAll('.ac-family')){
   if(!family.querySelector('[data-ab-select]'))continue;
   const input=doc.createElement('input');input.type='checkbox';input.dataset.abGroup=family.dataset.accountFamily;input.className='ac-select-account';input.setAttribute('aria-label','选择 OpenAI 的全部用途');family.querySelector('summary').prepend(input);
  }
  const batch=snapshot.batches?.at(-1),running=batch?.running||submitting;
  const box=doc.createElement('section');box.className='ac-batch';
  box.innerHTML=`<div class="ac-batch-buttons"><span class="ac-selection-count"></span><button class="ac-btn ac-link" data-ab="select">全选当前列表</button><button class="ac-btn ac-link" data-ab="needed">选择需处理</button><button class="ac-btn ac-link" data-ab="clear">清空</button><button class="ac-btn primary" data-ab="start" ${running||!chosen.size?'disabled':''}>一键登录所选</button></div><div class="ac-phone-row" ${!chosen.size?'hidden':''}><label>短信登录手机号 <input id="ac-batch-phone" type="tel" autocomplete="off" placeholder="可选，仅本次使用" value="${esc(phone)}" maxlength="11"></label><p class="ac-muted">已有有效登录会跳过，最多同时发起 3 个。DeepSeek、豆包支持填写手机号并申请验证码；验证码按站点提交，手机号和验证码不保存。</p></div>${batch?`<details class="ac-batch-progress" open><summary>本次登录进度 · ${batch.items.length} 处授权</summary><div class="ac-batch-results" role="status">${batch.items.map(item=>`<div><b>${esc(item.name)}</b><span>${esc(stages[item.stage]||'待确认')} · ${esc(item.message)}</span>${item.stage!=='signed_in'&&snapshot.connections.find(r=>r.id===item.id)?.phoneLogin?`<button class="ac-btn" data-ab="code" data-id="${esc(item.id)}">输入验证码</button>`:''}<button class="ac-btn" data-ac="check" data-id="${esc(item.id)}">检查结果</button></div>`).join('')}</div></details>`:''}`;
  content.querySelector('.ac-list-area').append(box);updateSelection();
 }
 function renderAgain(){if(rerender)rerender();else void refresh();}
 function closeAttention(){if(attentionDialog){attentionDialog.close();attentionDialog.remove();attentionDialog=null;}attentionIds=undefined;}
 function attention(ids){
  closeAttention();attentionIds=ids;
  attentionDialog=doc.createElement('dialog');attentionDialog.className='ac-task-dialog';attentionDialog.setAttribute('aria-labelledby','ac-task-title');
  attentionDialog.innerHTML='<header><div><h2 id="ac-task-title">集中处理登录</h2><p class="ac-muted">验证码、账号确认与登录结果在这里处理。</p></div><button class="ac-btn" data-ab="close-attention" aria-label="关闭集中处理">关闭</button></header><p class="ac-task-notice" role="status"></p><div class="ac-task-list"></div>';
  page.append(attentionDialog);attentionDialog.addEventListener('cancel',e=>{e.preventDefault();closeAttention();});renderAttention();attentionDialog.showModal();
 }
 function renderAttention(){
  if(!attentionDialog||!current)return;
  const rows=current.connections.filter(r=>attentionIds?attentionIds.includes(r.id):needsAttention(r));
  const latest=current.batches?.at(-1);
  attentionDialog.querySelector('.ac-task-list').innerHTML=rows.length?rows.map(row=>{
   const recovery=row.webRecovery||[];
   const item=latest?.items.find(i=>i.id===row.id),confirmed=row.state==='signed_in'&&!row.stale,code=row.phoneLogin&&row.pending;
   return `<div class="ac-task-item"><div><strong>${esc(row.name)}</strong><p>${esc(row.identity||'身份未确认')} · ${esc(recovery.length?recovery.length+' 项网页任务等待恢复':confirmed?'已登录':item?stages[item.stage]||'待确认':row.pending?'等待本人验证':'需要登录')}</p></div><div>${recovery.length?`<button class="ac-btn primary" data-ac="open" data-id="${esc(row.id)}">打开验证窗口</button>`:confirmed?'':code?`<button class="ac-btn primary" data-ab="code" data-id="${esc(row.id)}">输入验证码</button>`:`<button class="ac-btn primary" data-ac="${row.type==='web'&&row.pending?'open':'login'}" data-id="${esc(row.id)}">${row.pending?(row.type==='web'?'打开验证窗口':'查看登录提示'):'登录账号'}</button>`}${recovery.length?'<p class="ac-muted">补登后继续原任务；已发送的问题只补收，不重复提问。</p>':''}${code?`<button class="ac-btn" data-ac="open" data-id="${esc(row.id)}">官方窗口</button>`:''}<button class="ac-btn" data-ac="check" data-id="${esc(row.id)}">${recovery.length?'检查并继续任务':'检查登录'}</button>${row.pending?`<button class="ac-btn ac-link" data-ac="release" data-id="${esc(row.id)}">解除等待</button>`:''}</div></div>`;
  }).join(''):'<div class="ac-empty">当前没有需要处理的授权。登录未确认的账号仍可在总览中检查。</div>';
  for(const button of attentionDialog.querySelectorAll('[data-ac],[data-ab="code"]'))button.disabled=isBusy(button.dataset.id);
 }
 page.addEventListener('change',e=>{
  if(e.target.dataset.abGroup){for(const input of e.target.closest('.ac-family').querySelectorAll('[data-ab-select]'))e.target.checked?chosen.add(input.dataset.abSelect):chosen.delete(input.dataset.abSelect);updateSelection();}
  else if(e.target.dataset.abSelect){e.target.checked?chosen.add(e.target.dataset.abSelect):chosen.delete(e.target.dataset.abSelect);updateSelection();}
 });
 page.addEventListener('input',e=>{if(e.target.id==='ac-batch-phone')phone=e.target.value;});
 page.addEventListener('click',async e=>{
  const button=e.target.closest('[data-ab]');if(!button)return;const action=button.dataset.ab;
  if(action==='close-attention'){closeAttention();return;}
  if(action==='clear'){chosen.clear();renderAgain();return;}
  if(action==='select'||action==='needed'){
   const ids=[...page.querySelectorAll('[data-ab-select]')].map(el=>el.dataset.abSelect);
   for(const row of current.connections)if(ids.includes(row.id)&&(action==='select'||needsAttention(row)))chosen.add(row.id);
   renderAgain();return;
  }
  if(action==='start'){
   if(submitting)return;const ticket=uiEpoch;let failure='';submitting=true;button.disabled=true;
   try{const result=await call('login-many',{ids:[...chosen],phone:phone.trim()});phone='';if(ticket===uiEpoch){notice(result.message);await refresh();}}
   catch(err){failure=err.message;}finally{submitting=false;if(ticket===uiEpoch){await refresh();if(failure&&ticket===uiEpoch)notice(failure,true);}}return;
  }
  if(action==='code'){
   const row=current.connections.find(r=>r.id===button.dataset.id);if(!row?.phoneLogin||page.querySelector('.ac-code-dialog[open]'))return;
   const dialog=doc.createElement('dialog');dialog.className='ac-code-dialog';dialog.setAttribute('aria-label',row.name+'验证码');
   dialog.innerHTML=`<form><h3>${esc(row.name)} · 验证码</h3><p>只提交到该账号当前的官方登录页，提交后立即清空。</p><input name="code" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required aria-label="短信验证码"><p role="status"></p><div class="ac-dialog-actions"><button class="ac-btn" type="button" data-cancel>稍后处理</button><button class="ac-btn primary" type="submit">提交并检查</button></div></form>`;
   page.append(dialog);dialog.showModal();dialog.querySelector('input').focus();
   const close=()=>{dialog.querySelector('input').value='';dialog.close();dialog.remove();};dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.querySelector('[data-cancel]').onclick=close;
   dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const input=dialog.querySelector('input'),code=input.value;input.value='';const submit=dialog.querySelector('[type=submit]');submit.disabled=true;const ticket=uiEpoch;
    try{
     const r=await call('submit-code',{id:row.id,code});if(ticket!==uiEpoch||!dialog.isConnected)return;
     notice(r.message);close();
     let checkError='';try{await call('check',{id:row.id});}catch(err){checkError=err.message;}
     if(ticket===uiEpoch){await refresh();if(checkError&&ticket===uiEpoch)notice(checkError,true);}
    }catch{if(dialog.isConnected){dialog.querySelector('[role=status]').textContent='提交未完成，请检查官方窗口后再试';submit.disabled=false;}}
   };
  }
 });
 function setNotice(message){if(attentionDialog)attentionDialog.querySelector('.ac-task-notice').textContent=message;}
 function clear(){uiEpoch++;phone='';closeAttention();page.querySelectorAll('.ac-code-dialog').forEach(d=>{d.querySelector('input').value='';d.close();d.remove();});}
 return {decorate,update,clear,attention,closeAttention,setNotice};
}
module.exports={createAccountBatchUI};
