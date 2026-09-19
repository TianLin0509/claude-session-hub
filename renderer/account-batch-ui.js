'use strict';
function createAccountBatchUI({page,call,refresh,notice,escapeHtml:esc}) {
  const chosen=new Set();let phone='',submitting=false,current;
  const stages={queued:'排队',checking:'检查中',signed_in:'已登录',waiting_code:'等待验证码',manual:'需要本人验证',failed:'未完成'};
  function decorate(snapshot) {
    current=snapshot;
    for(const id of chosen)if(!snapshot.connections.some(r=>r.id===id&&r.action==='login'))chosen.delete(id);
    const content=page.querySelector('.ac-content');
    if(!content.querySelector('.ac-grid'))return;
    for(const el of content.querySelectorAll('.ac-row')) {
      const row=snapshot.connections.find(r=>r.id===el.querySelector('[data-ac="select"]')?.dataset.id);
      if(!row)continue;
      if(row.action==='login'){
        const input=page.ownerDocument.createElement('input');input.type='checkbox';input.dataset.abSelect=row.id;input.checked=chosen.has(row.id);input.setAttribute('aria-label','选择 '+row.name);input.className='ac-select-account';el.firstElementChild.prepend(input);
      }
      const hint=page.ownerDocument.createElement('small');hint.textContent=row.loginHint||'复用原工具已记住的账号';el.firstElementChild.append(hint);
    }
    const batch=snapshot.batches?.at(-1),running=batch?.running||submitting;
    const box=page.ownerDocument.createElement('section');box.className='ac-batch';
    box.innerHTML=`<div class="ac-batch-buttons"><button class="ac-btn" data-ab="select">全选当前列表</button><button class="ac-btn" data-ab="needed">选择需登录账号</button><button class="ac-btn" data-ab="clear">清空选择</button><button class="ac-btn primary" data-ab="start" ${running||!chosen.size?'disabled':''}>一键登录所选（${chosen.size}）</button></div><label>短信登录手机号 <input id="ac-batch-phone" type="tel" autocomplete="off" placeholder="可选，仅本次使用" value="${esc(phone)}" maxlength="11"></label><p class="ac-muted">已有有效登录会自动跳过，最多同时发起 3 个。填写手机号后，为支持的站点自动填入并申请验证码；验证码、人机验证或扫码按站点分别完成。手机号和验证码不保存。</p>${batch?`<div class="ac-batch-results" role="status">${batch.items.map(item=>`<div><b>${esc(item.name)}</b><span>${esc(stages[item.stage]||'待确认')} · ${esc(item.message)}</span>${item.stage!=='signed_in'&&snapshot.connections.find(r=>r.id===item.id)?.phoneLogin?`<button class="ac-btn" data-ab="code" data-id="${esc(item.id)}">输入验证码</button>`:''}<button class="ac-btn" data-ac="check" data-id="${esc(item.id)}">检查结果</button></div>`).join('')}</div>`:''}`;
    content.prepend(box);
  }
  function rerender(){if(!current)return;void refresh();}
  page.addEventListener('change',e=>{if(e.target.dataset.abSelect){e.target.checked?chosen.add(e.target.dataset.abSelect):chosen.delete(e.target.dataset.abSelect);const b=page.querySelector('[data-ab="start"]');if(b){b.textContent=`一键登录所选（${chosen.size}）`;b.disabled=!chosen.size||submitting||!!current?.batches?.at(-1)?.running;}}});
  page.addEventListener('input',e=>{if(e.target.id==='ac-batch-phone')phone=e.target.value;});
  page.addEventListener('click',async e=>{
    const button=e.target.closest('[data-ab]');if(!button)return;const action=button.dataset.ab;
    if(action==='clear'){chosen.clear();rerender();return;}
    if(action==='select'||action==='needed'){
      const ids=[...page.querySelectorAll('[data-ab-select]')].map(e=>e.dataset.abSelect);
      for(const row of current.connections)if(ids.includes(row.id)&&(action==='select'||row.state==='login_required'))chosen.add(row.id);
      rerender();return;
    }
    if(action==='start'){
      if(submitting)return;submitting=true;button.disabled=true;
      try{const result=await call('login-many',{ids:[...chosen],phone:phone.trim()});phone='';notice(result.message);await refresh();}
      catch(err){notice(err.message,true);}finally{submitting=false;await refresh();}return;
    }
    if(action==='code'){
      const row=current.connections.find(r=>r.id===button.dataset.id);if(!row?.phoneLogin)return;
      const dialog=page.ownerDocument.createElement('dialog');dialog.className='ac-code-dialog';
      dialog.innerHTML=`<form><h3>${esc(row.name)} · 验证码</h3><p>只提交到该账号当前的官方登录页，提交后立即清空。</p><input name="code" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required aria-label="短信验证码"><p role="status"></p><button class="ac-btn primary" type="submit">提交验证码</button><button class="ac-btn" type="button" data-cancel>取消</button></form>`;
      page.append(dialog);dialog.showModal();dialog.querySelector('input').focus();
      const close=()=>{dialog.querySelector('input').value='';dialog.close();dialog.remove();};dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.querySelector('[data-cancel]').onclick=close;
      dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const input=dialog.querySelector('input'),code=input.value;input.value='';const submit=dialog.querySelector('[type=submit]');submit.disabled=true;
        try{const r=await call('submit-code',{id:row.id,code});notice(r.message);close();await refresh();}catch{dialog.querySelector('[role=status]').textContent='提交未完成，请检查官方窗口后再试';submit.disabled=false;}
      };
    }
  });
  function clear(){phone='';page.querySelectorAll('.ac-code-dialog').forEach(d=>{d.close();d.remove();});}
  return {decorate,clear};
}
module.exports={createAccountBatchUI};
