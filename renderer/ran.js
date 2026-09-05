/* AI 开发群聊工作台。保留 __ran* 导航入口。
 * 只呈现群聊写入时生成的摘要与执行状态：无轮询、逐任务 get-state、
 * 终端提取、仓库扫描或额外 AI 请求。人工操作由原群聊引擎处理。 */
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');
  const PAGE_SIZE = 40;
  const state = { opened:false, loading:false, request:0, epoch:null, sequence:-1,
    rows:new Map(), receipts:new Map(), pending:new Set(), expanded:new Set(),
    filter:'all', search:'', project:'', page:0, buffered:[], error:'', updatedAt:0 };
  let root, listEl, renderTimer, dialogResolve, focusBeforeDialog;
  const colors={ok:'var(--status-success)',run:'var(--status-info)',warn:'var(--status-warning)',bad:'var(--status-danger)',idle:'var(--fg-muted)'};
  const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=(value,max=4096)=>typeof value==='string'?value.slice(0,max):'';
  const button=(action,label,extra='')=>`<button type="button" data-devb-action="${action}" ${extra}>${label}</button>`;
  const sourceText=source=>source?`${text(source.speaker,100)||'Agent'} · 群聊第 ${Number(source.turnNum)||0} 轮`+(source.at?' · '+new Date(source.at).toLocaleString('zh-CN',{hour12:false}):''):'';
  const bucket=row=>row.stage?.tone==='bad'||row.stage?.tone==='warn'?'attention':row.stage?.tone==='run'?'running':row.stage?.tone==='ok'?'passed':'idle';
  function buildSkeleton(){
    if(root)return true;root=document.getElementById('ran-panel');if(!root)return false;
    root.innerHTML=`<header class="devb-head"><div><h2>开发群聊工作台</h2><p class="devb-subtitle">一个开发群聊对应一个任务。进展随群聊汇报同步，操作回到同一条流程。</p></div><div class="devb-head-actions">${button('reload','重新载入','id="devb-refresh"')}${button('create','新建开发群聊','class="devb-primary"')}</div></header>
      <div class="devb-toolbar"><div class="devb-filters" aria-label="按任务状态筛选">${[['all','全部'],['attention','需要处理'],['running','正在推进'],['passed','已通过'],['idle','未开始 / 已停止']].map(([key,label])=>button('filter',label,`class="devb-filter" data-filter="${key}" aria-pressed="${key==='all'}"`)).join('')}</div><input id="devb-search" type="search" aria-label="搜索开发群聊" placeholder="搜索任务或进展"><select id="devb-project" aria-label="按项目筛选"><option value="">所有项目</option></select></div>
      <div class="devb-summary"><span id="devb-status" aria-live="polite">准备载入…</span><span id="devb-sync">群聊汇报自动推送</span></div><div id="devb-banner" role="status"></div><div id="devb-list"><div class="devb-grid"></div><div class="devb-empty"></div><div class="devb-pager"></div></div>
      <dialog class="devb-dialog" id="devb-confirm" aria-labelledby="devb-confirm-title"><h3 id="devb-confirm-title"></h3><p id="devb-confirm-body"></p><div class="devb-head-actions">${button('cancel-confirm','取消')}${button('confirm','确认操作','class="devb-primary"')}</div></dialog>`;
    listEl=root.querySelector('#devb-list');
    root.addEventListener('click',event=>{const target=event.target.closest('[data-devb-action]');if(!target||target.disabled)return;void handleAction(target).catch(error=>{state.error=error.message||String(error);scheduleRender();});});
    root.querySelector('#devb-search').addEventListener('input',event=>{state.search=event.target.value;state.page=0;scheduleRender();});
    root.querySelector('#devb-project').addEventListener('change',event=>{state.project=event.target.value;state.page=0;scheduleRender();});
    root.addEventListener('toggle',event=>{if(!event.target.isConnected||!event.target.matches('details[data-detail-key]'))return;const id=event.target.dataset.detailKey;if(event.target.open)state.expanded.add(id);else state.expanded.delete(id);},true);
    root.querySelector('#devb-confirm').addEventListener('cancel',event=>{event.preventDefault();settleConfirm(false);});return true;
  }
  function receipt(id,message,error=false){state.receipts.set(id,{message,error});scheduleRender();}
  function rowHtml(row){
    const id=row.id,stage=row.stage||{},card=row.card||{},review=row.review||{},tone=colors[stage.tone]||colors.idle;
    const pending=state.pending.has(id),disabled=pending?'disabled':'',current=state.receipts.get(id),actions=row.actions||{};
    const round=Number(stage.round)>0?` · 第 ${Number(stage.round)} / ${Number(stage.maxRounds)||3} 轮`:'';
    return `<article class="devb-row" data-mid="${esc(id)}" style="--devb-tone:${tone}"><div class="devb-row-header"><h3>${esc(text(row.title,240)||'未命名开发群聊')}</h3><span class="devb-stage">${esc(text(stage.label,100)||'状态待确认')}</span></div><div class="devb-project">${esc(text(row.project,240)||text(row.workspace,2048)||'群聊未绑定项目')}${esc(round)}</div>
      ${row.goal?`<details class="devb-details" data-detail-key="${esc(id)}-goal" ${state.expanded.has(id+'-goal')?'open':''}><summary>本次任务目标</summary><div class="devb-goal">${esc(row.goal)}</div></details>`:''}
      <p class="devb-progress">${esc(row.progress||(row.loading?'正在载入已有群聊汇报…':'尚未收到进展汇报。Agent 按合同写出更新后会在这里显示。'))}</p><div class="devb-source">${esc(sourceText(row.progressSource)||'进展来源：本开发群聊')} ${row.receivedAt?' · 已同步':row.progress?' · 已保存的汇报':''}</div>
      ${row.feedError?`<div class="devb-warning">汇报载入失败：${esc(row.feedError)}。可重新载入或进入原群聊。</div>`:''}${row.lastError?`<div class="devb-warning">流程提示：${esc(row.lastError)}</div>`:''}${row.blockers?`<div class="devb-warning">最近审核要求修订：${esc(row.blockers)}</div>`:''}${card.risk?`<div class="devb-warning">工作席报告的风险：${esc(card.risk)}</div>`:''}
      <details class="devb-details" data-detail-key="${esc(id)}" ${state.expanded.has(id)?'open':''}><summary>汇报与审核记录</summary><dl><dt>实现</dt><dd>${esc(card.progress||'尚无最终交接汇报')}</dd><dt>自测</dt><dd>${esc(card.verified||'尚无自测汇报')}</dd><dt>审核</dt><dd>${esc(review.decision==='pass'?'最近一次审核报告 PASS':review.decision==='fail'?'最近一次审核报告 FAIL':'尚无审核裁决')}</dd><dt>验证</dt><dd>${esc(review.verified||'尚无独立验证汇报')}</dd>${review.next?`<dt>下一步</dt><dd>${esc(review.next)}</dd>`:''}</dl><p class="devb-source">${esc(sourceText(row.review||row.card))}。这里呈现席位汇报，不替代实际使用验收。${row.truncated?'长汇报已节选，完整内容请查看群聊原文。':''}</p></details>
      <div class="devb-actions">${button('open','进入群聊','class="devb-primary"')}${row.report?button('report','查看报告'):''}${actions.stop?button('stop','停止流程',disabled):''}${actions.resume?button('resume','恢复中断流程',disabled):''}${actions.takeover?button('takeover','手动接管',disabled):''}${actions.restore?button('restore','恢复自动设置',disabled):''}</div>
      ${pending?'<div class="devb-receipt" role="status">操作处理中；其他任务和群聊入口仍可使用。</div>':''}${current?`<div class="devb-receipt ${current.error?'error':''}" role="status">${esc(current.message)}</div>`:''}</article>`;
  }
  function scheduleRender(){if(renderTimer||!state.opened)return;renderTimer=setTimeout(()=>{renderTimer=null;render();},80);}
  function render(){
    if(!root||!state.opened)return;
    try{
      const rows=[...state.rows.values()],counts={all:rows.length,attention:0,running:0,passed:0,idle:0};rows.forEach(row=>counts[bucket(row)]++);
      const labels={all:'全部',attention:'需要处理',running:'正在推进',passed:'已通过',idle:'未开始 / 已停止'};
      root.querySelectorAll('[data-filter]').forEach(el=>{el.textContent=labels[el.dataset.filter]+' '+counts[el.dataset.filter];el.setAttribute('aria-pressed',String(state.filter===el.dataset.filter));});
      const projects=[...new Set(rows.map(row=>row.project||row.workspace).filter(Boolean))].sort(),projectEl=root.querySelector('#devb-project');
      const options='<option value="">所有项目</option>'+projects.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('');
      if(projectEl.innerHTML!==options){projectEl.innerHTML=options;projectEl.value=state.project;}
      const needle=state.search.trim().toLocaleLowerCase();
      const filtered=rows.filter(row=>(state.filter==='all'||bucket(row)===state.filter)&&(!state.project||(row.project||row.workspace)===state.project)&&(!needle||[row.title,row.project,row.workspace,row.progress].join(' ').toLocaleLowerCase().includes(needle))).sort((a,b)=>({attention:0,running:1,idle:2,passed:3}[bucket(a)]-{attention:0,running:1,idle:2,passed:3}[bucket(b)])||a.id.localeCompare(b.id));
      const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));state.page=Math.min(state.page,pages-1);
      const visible=filtered.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE),grid=listEl.querySelector('.devb-grid'),keep=new Set(visible.map(row=>row.id));
      const focus=document.activeElement,focusId=focus?.closest('.devb-row')?.dataset.mid,focusAction=focus?.dataset.devbAction;
      for(const el of [...grid.children])if(!keep.has(el.dataset.mid))el.remove();
      visible.forEach((row,index)=>{
        let html;try{html=rowHtml(row);}catch(error){html=`<article class="devb-row" data-mid="${esc(row.id)}"><h3>此任务暂时无法显示</h3><p class="devb-warning">${esc(error.message)}</p>${button('open','进入原群聊')}</article>`;}
        let el=[...grid.children].find(node=>node.dataset.mid===row.id);
        if(!el||el._devbHtml!==html){const template=document.createElement('template');template.innerHTML=html;const fresh=template.content.firstElementChild;fresh._devbHtml=html;if(el)el.replaceWith(fresh);el=fresh;}
        if(grid.children[index]!==el)grid.insertBefore(el,grid.children[index]||null);
      });
      if(focusId&&focusAction&&!focus.isConnected){const card=[...grid.children].find(el=>el.dataset.mid===focusId),next=card&&[...card.querySelectorAll('[data-devb-action]')].find(el=>el.dataset.devbAction===focusAction);if(next&&!next.disabled)next.focus({preventScroll:true});}
      const empty=listEl.querySelector('.devb-empty');empty.hidden=visible.length>0;empty.innerHTML=rows.length?'没有符合当前筛选条件的任务。':'<h3>从一个开发群聊开始</h3><p>新建群聊时选择“开发”场景，绑定项目并布置任务。<br>已有群聊的进展、审核与恢复入口会集中显示在这里。</p>';
      listEl.querySelector('.devb-pager').innerHTML=pages>1?button('previous','上一页',state.page===0?'disabled':'')+`<span>第 ${state.page+1} / ${pages} 页 · 每页最多 ${PAGE_SIZE} 项</span>`+button('next','下一页',state.page===pages-1?'disabled':''):'';
      root.querySelector('#devb-status').textContent=`${rows.length} 个开发群聊 · ${counts.attention} 个需要处理 · ${counts.running} 个正在推进`+(state.loading?' · 载入中…':'');
      root.querySelector('#devb-sync').textContent=state.updatedAt?'最近收到更新 '+new Date(state.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}):'群聊汇报自动推送';root.querySelector('#devb-banner').textContent=state.error;
    }catch(error){root.querySelector('#devb-banner').textContent='工作台显示异常，原群聊仍保留。请重新载入：'+(error.message||error);}
  }
  function bounded(promise,ms,message){let timeout;return Promise.race([promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timeout));}
  function acceptRows(rows){if(!Array.isArray(rows))throw new Error('任务摘要列表格式无效');for(const row of rows){if(!row||typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,255}$/.test(row.id))continue;state.rows.set(row.id,row);}}
  function applyChange(payload){
    if(!payload||typeof payload.epoch!=='string'||!Number.isFinite(payload.sequence))return;
    if(payload.epoch!==state.epoch){state.error='工作台服务已重建，请重新载入以接收最新状态。';scheduleRender();return;}
    if(payload.sequence<=state.sequence)return;if(payload.sequence>state.sequence+1)state.error='部分推送未收到，当前显示已知状态；请重新载入。';
    acceptRows(payload.rows);for(const id of Array.isArray(payload.removed)?payload.removed:[]){state.rows.delete(id);state.receipts.delete(id);state.expanded.delete(id);}
    state.sequence=payload.sequence;state.updatedAt=Date.now();scheduleRender();
  }
  async function reload(){
    if(!buildSkeleton())return;const request=++state.request;state.loading=true;state.buffered=[];state.error='';render();
    try{
      const payload=await bounded(ipcRenderer.invoke('dev-workbench:get-snapshot',{retryErrors:true}),5000,'摘要载入超时；已显示的任务保留，可重新载入或进入群聊。');
      if(request!==state.request)return;if(!payload||payload.ok!==true)throw new Error(payload?.reason||'工作台服务返回无效结果');if(!Array.isArray(payload.rows))throw new Error('任务列表格式无效');
      state.rows.clear();acceptRows(payload.rows);state.epoch=payload.epoch;state.sequence=payload.sequence;for(const delta of state.buffered)if(delta.epoch===state.epoch)applyChange(delta);state.updatedAt=Date.now();
    }catch(error){if(request===state.request)state.error=error.message||String(error);}finally{if(request===state.request){state.loading=false;state.buffered=[];render();}}
  }
  function confirmOperation(title,body){settleConfirm(false);focusBeforeDialog=document.activeElement;const dialog=root.querySelector('#devb-confirm');root.querySelector('#devb-confirm-title').textContent=title;root.querySelector('#devb-confirm-body').textContent=body;return new Promise(resolve=>{dialogResolve=resolve;dialog.showModal();});}
  function settleConfirm(value){const dialog=root?.querySelector('#devb-confirm');if(dialog?.open)dialog.close();const resolve=dialogResolve;dialogResolve=null;if(resolve)resolve(value);if(focusBeforeDialog?.isConnected)focusBeforeDialog.focus({preventScroll:true});}
  async function handleAction(target){
    const action=target.dataset.devbAction;
    if(action==='confirm'||action==='cancel-confirm'){settleConfirm(action==='confirm');return;}
    if(action==='reload'){await reload();return;}
    if(action==='create'){if(typeof window.openMeetingCreateModal!=='function')throw new Error('创建群聊入口暂不可用，请从启动中心打开。');window.openMeetingCreateModal('dev');return;}
    if(action==='filter'){state.filter=target.dataset.filter;state.page=0;render();return;}
    if(action==='previous'||action==='next'){state.page+=action==='next'?1:-1;render();listEl.scrollTop=0;return;}
    const id=target.closest('.devb-row')?.dataset.mid,row=state.rows.get(id);if(!row)return;
    if(action==='open'){try{const select=window.selectMeeting||(typeof selectMeeting==='function'?selectMeeting:null);if(!select)throw new Error('群聊入口尚未就绪');await bounded(Promise.resolve(select(id)),5000,'打开群聊超时，请重新载入后重试');}catch(error){setPanelVisible(true,false);receipt(id,error.message,true);}return;}
    if(action==='report'){
      try{
        if(typeof window.openPathInHub!=='function')throw new Error('报告预览尚未就绪');
        let reportPath=row.report;
        if(!/^https?:\/\//i.test(reportPath)){
          const path=require('node:path');reportPath=path.resolve(row.workspace||'.',reportPath);
          // Explicit user action only. The preview API can acknowledge a missing
          // HTML path before its webview fails, so verify this one chosen file.
          const stat=await bounded(require('node:fs').promises.stat(reportPath),3000,'报告文件检查超时');
          if(!stat.isFile())throw new Error('报告路径不是文件');
        }
        const result=await bounded(Promise.resolve(window.openPathInHub(reportPath,{cwd:row.workspace,requireExistsForRel:true,throwOnError:true})),5000,'报告打开超时，任务流程不受影响');
        if(result?.ok===false)throw new Error(result.error||'报告无法打开');
      }catch(error){receipt(id,'报告打不开：'+error.message,true);}return;
    }
    if(state.pending.has(id))return;
    const descriptions={stop:['停止这条任务的自动流程？','停止当前轮并阻止后续自动派发。已有群聊、工作树和成果均保留。'],resume:['恢复这条中断的开发任务？','使用原目标与已保存的步骤记录继续。不会重置返工额度，也不会跳过独立审核。'],takeover:['改为手动处理这条任务？','先停止自动流程，再关闭这条群聊的自动派发。你可以在原群聊检查、补充要求或调整成员；之后可以恢复原设置。'],restore:['恢复原来的自动流程设置？','恢复此群聊接管前的设置。本次仅恢复设置，不会自动发送新任务。']};
    if(!descriptions[action]||!row.actions?.[action])return;if(!await confirmOperation(descriptions[action][0],row.title+'\n\n'+descriptions[action][1]))return;
    state.pending.add(id);render();
    try{const result=await bounded(ipcRenderer.invoke('dev-workbench:action',{meetingId:id,action,controlToken:row.controlToken}),6500,'操作响应超时，结果尚未确认；请重新载入或进入群聊核对，避免重复提交。');if(!result||result.ok!==true)throw new Error(result?.reason||'操作未成功，请进入群聊处理');receipt(id,result.message||'操作请求已接收，请查看更新后的任务状态');}catch(error){receipt(id,error.message,true);}finally{state.pending.delete(id);scheduleRender();}
  }
  function setPanelVisible(visible,load=true){
    if(!buildSkeleton())return;state.opened=visible;root.style.display=visible?'flex':'none';const nav=document.getElementById('btn-ran');nav?.classList.toggle('active',visible);if(nav){if(visible)nav.setAttribute('aria-current','page');else nav.removeAttribute('aria-current');}
    if(visible){const home=document.getElementById('btn-home');home?.classList.remove('active');home?.removeAttribute('aria-current');window.__chuxinHide?.();window.__studyHide?.();for(const id of ['terminal-panel','meeting-room-panel']){const el=document.getElementById(id);if(el)el.style.display='none';}render();if(load)void reload();}else{settleConfirm(false);if(renderTimer){clearTimeout(renderTimer);renderTimer=null;}}
  }
  ipcRenderer.on('dev-workbench:changed',(_event,payload)=>{try{if(state.loading||!state.epoch){if(state.buffered.length<1000)state.buffered.push(payload);else state.error='更新积压，请重新载入最新摘要。';}else applyChange(payload);}catch(error){state.error='收到异常摘要，其他任务保留：'+error.message;scheduleRender();}});
  window.__ranHide=()=>{if(state.opened)setPanelVisible(false);};window.__ranShow=()=>setPanelVisible(true);window.__devBoardHide=window.__ranHide;window.__devBoardShow=window.__ranShow;
  function init(){buildSkeleton();document.querySelectorAll('#btn-ran,[data-ran-entry]').forEach(button=>button.addEventListener('click',()=>setPanelVisible(true)));}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
