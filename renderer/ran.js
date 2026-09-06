/* AI 开发群聊工作台。保留 __ran* 导航入口。
 * 只呈现群聊写入时生成的摘要与执行状态：无轮询、逐任务 get-state、
 * 终端提取、仓库扫描或额外 AI 请求。人工操作由原群聊引擎处理。 */
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');
  const Model = require('./dev-workbench-model');
  const PAGE_SIZE = 40;
  const state = { opened:false, loading:false, request:0, epoch:null, sequence:-1,
    rows:new Map(), receipts:new Map(), pending:new Set(), expanded:new Set(),
    filter:'all', search:'', project:'', mode:'tasks', sort:'updated-desc', density:'comfortable', projectLimits:new Map(), historyLimits:new Map(), page:0, buffered:[], error:'', updatedAt:0,
    readingTasks:null, readingProjects:null, updates:new Set() };
  try { const saved=JSON.parse(localStorage.getItem('hub.devWorkbench.view')||'{}'); if(['tasks','projects'].includes(saved.mode))state.mode=saved.mode;if(['updated-desc','updated-asc','created-desc','created-asc'].includes(saved.sort))state.sort=saved.sort; }
  catch(error){console.warn('[dev-workbench] 视图偏好读取失败',error);}
  try { if(JSON.parse(localStorage.getItem('hub.devWorkbench.view')||'{}').density==='compact')state.density='compact'; }catch(error){console.warn('[dev-workbench] 密度偏好读取失败',error);}
  function saveView(){try{localStorage.setItem('hub.devWorkbench.view',JSON.stringify({mode:state.mode,sort:state.sort,density:state.density}));}catch(error){state.error='视图偏好未能保存：'+error.message;}}
  function releaseOrder(){state.readingTasks=null;state.readingProjects=null;state.updates.clear();}
  let root, listEl, renderTimer, dialogResolve, focusBeforeDialog;
  const colors={ok:'var(--status-success)',run:'var(--status-info)',warn:'var(--status-warning)',bad:'var(--status-danger)',idle:'var(--fg-muted)'};
  const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=(value,max=4096)=>typeof value==='string'?value.slice(0,max):'';
  const button=(action,label,extra='')=>`<button type="button" data-devb-action="${action}" ${extra}>${label}</button>`;
  const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true" class="devb-icon">${{plus:'<path d="M12 5v14M5 12h14"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',reload:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',density:'<path d="M5 6h14M5 12h14M5 18h14"/>'}[name]||''}</svg>`;
  const sourceText=source=>source?`${text(source.speaker,100)||'Agent'}`+(source.at?' · '+new Date(source.at).toLocaleString('zh-CN',{hour12:false}):''):'';
  const bucket=row=>row.attention||row.stage?.tone==='bad'||row.stage?.tone==='warn'?'attention':row.stage?.tone==='run'?'running':row.stage?.tone==='ok'?'passed':'idle';
  function buildSkeleton(){
    if(root)return true;root=document.getElementById('ran-panel');if(!root)return false;
    root.innerHTML=`<div class="devb-context"><span>工作空间 <span class="devb-slash">/</span> <strong>开发群聊</strong></span><span class="devb-sync-indicator" id="devb-sync">准备同步</span></div><header class="devb-head"><div><h2>开发工作台</h2><p class="devb-subtitle" id="devb-subtitle">把注意力留给方向与结果。</p></div><div class="devb-head-actions">${button('reload',icon('reload'),'id="devb-refresh" class="devb-icon-button" aria-label="重新载入" title="重新载入群聊进展"')}${button('create',icon('plus')+'<span>新建任务</span>','class="devb-primary" aria-label="新建开发群聊"')}</div></header>
      <div class="devb-viewbar"><div class="devb-tabs" role="tablist" aria-label="工作台视图">${[['tasks','任务'],['projects','项目']].map(([mode,label])=>button('mode',label+` <span class="devb-tab-count" id="devb-count-${mode}"></span>`,`id="devb-tab-${mode}" role="tab" aria-controls="devb-list" data-mode="${mode}" aria-selected="${state.mode===mode}" tabindex="${state.mode===mode?'0':'-1'}"`)).join('')}</div><span class="devb-order-hint">群聊主动汇报 · 一条任务，一个协作空间</span></div>
      <div class="devb-toolbar"><div class="devb-filters" aria-label="按任务状态筛选">${[['all','全部'],['attention','需要处理'],['running','进行中'],['passed','已通过'],['idle','其他']].map(([key,label])=>button('filter',label,`class="devb-filter" data-filter="${key}" aria-pressed="${key==='all'}"`)).join('')}</div><div class="devb-list-tools"><label class="devb-search">${icon('search')}<input id="devb-search" type="search" aria-label="搜索开发群聊" placeholder="搜索任务…"></label><select id="devb-project" aria-label="按项目筛选"><option value="">所有项目</option></select><select id="devb-sort" aria-label="时间排序"><option value="updated-desc">最近更新</option><option value="created-desc">最近创建</option><option value="updated-asc">较早更新</option><option value="created-asc">较早创建</option></select>${button('density',icon('density')+'舒适','id="devb-density" aria-label="切换任务行密度" aria-pressed="false"')}</div></div>
      <div id="devb-banner" role="status"></div>${button('reorder','','id="devb-updates" hidden aria-live="polite"')}<div id="devb-list" role="tabpanel"><div class="devb-columns" aria-hidden="true"><span>任务 / 项目</span><span>最新进展</span><span>流程 / 当前节点</span><span>更新</span><span></span></div><div class="devb-grid"></div><div class="devb-empty"></div><div class="devb-pager"></div></div><footer class="devb-summary"><span id="devb-status" aria-live="polite">准备载入…</span><span>点击任务查看详情 · 行末进入群聊</span></footer>
      <dialog class="devb-dialog" id="devb-confirm" aria-labelledby="devb-confirm-title"><h3 id="devb-confirm-title"></h3><p id="devb-confirm-body"></p><div class="devb-head-actions">${button('cancel-confirm','取消')}${button('confirm','确认操作','class="devb-primary"')}</div></dialog>`;
    listEl=root.querySelector('#devb-list');
    root.addEventListener('click',event=>{const target=event.target.closest('[data-devb-action]');if(!target||target.disabled)return;void handleAction(target).catch(error=>{state.error=error.message||String(error);scheduleRender();});});
    root.querySelector('#devb-search').addEventListener('input',event=>{state.search=event.target.value;state.page=0;releaseOrder();scheduleRender();});
    root.querySelector('#devb-project').addEventListener('change',event=>{state.project=event.target.value;state.page=0;releaseOrder();scheduleRender();});
    root.querySelector('#devb-sort').value=state.sort;
    root.querySelector('#devb-sort').addEventListener('change',event=>{state.sort=event.target.value;state.page=0;releaseOrder();saveView();render();});
    root.querySelector('.devb-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const mode=event.key==='Home'?'tasks':event.key==='End'?'projects':state.mode==='tasks'?'projects':'tasks';const tab=root.querySelector(`[data-mode="${mode}"]`);tab.click();tab.focus();});
    root.addEventListener('toggle',event=>{if(!event.target.isConnected||!event.target.matches('details[data-detail-key]'))return;const id=event.target.dataset.detailKey;if(event.target.open)state.expanded.add(id);else state.expanded.delete(id);},true);
    root.querySelector('#devb-confirm').addEventListener('cancel',event=>{event.preventDefault();settleConfirm(false);});return true;
  }
  function receipt(id,message,error=false){state.receipts.set(id,{message,error});scheduleRender();}
  const timeText=at=>Number(at)>0?new Date(Number(at)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未记录';
  const relativeTime=at=>{if(!(Number(at)>0))return '未记录';const minutes=Math.max(0,Math.floor((Date.now()-Number(at))/60000));return minutes<1?'刚刚':minutes<60?minutes+' 分钟前':minutes<1440?Math.floor(minutes/60)+' 小时前':Math.floor(minutes/1440)+' 天前';};
  const CHRONICLE_KIND={plan:'方案',update:'进展',handoff:'交付',review:'审核',ask:'待你拍板'};
  function chronicleHtml(row){
    const list=Array.isArray(row.chronicle)?row.chronicle:[];
    if(!list.length)return '<p class="devb-chronicle-empty">还没有可展开的过程记录。Agent 写出方案（PLAN）或进展（UPDATE）后，会按时间排在这里。</p>';
    return `<ol class="devb-chronicle">${list.map(entry=>`<li class="k-${esc(entry.kind)}"><div class="devb-chron-head"><span class="devb-chron-kind">${esc(CHRONICLE_KIND[entry.kind]||'记录')}</span><span>${esc(text(entry.speaker,100)||'Agent')}</span><time>${esc(timeText(entry.at))}</time></div><p>${esc(text(entry.text,1600))}</p></li>`).join('')}</ol>`;
  }
  function rowHtml(row){
    const id=row.id,stage=row.stage||{},card=row.card||{},review=row.review||{},tone=colors[stage.tone]||colors.idle;
    const pending=state.pending.has(id),disabled=pending?'disabled':'',current=state.receipts.get(id),actions=row.actions||{};
    const round=Number(stage.round)>0?` · 第 ${Number(stage.round)} / ${Number(stage.maxRounds)||3} 轮`:'';
    const flow=Model.flowSteps(row);
    const warning=row.feedError?'汇报载入失败：'+row.feedError:row.attention?'':row.lastError||row.blockers||'';
    return `<article class="devb-row ${state.expanded.has(id)?'is-expanded':''}" data-mid="${esc(id)}" style="--devb-tone:${tone}"><div class="devb-row-main"><div class="devb-identity"><h3>${button('details',esc(text(row.title,240)||'未命名开发群聊'),`class="devb-task-title" aria-expanded="${state.expanded.has(id)}" title="查看任务目标与验收汇报"`)}</h3><div class="devb-project" title="${esc(row.workspace)}">${row.pinned?'<span class="devb-placement">置顶</span>':row.bottomed?'<span class="devb-placement bottom">置底</span>':''}${esc(Model.projectName(row))}</div></div>
      <div class="devb-latest"><p class="devb-progress">${esc(row.progress||(row.loading?'正在载入已有群聊汇报…':'尚未收到进展汇报。Agent 写出更新后会在这里显示。'))}</p><div class="devb-source" title="${esc(sourceText(row.progressSource))}">${esc(row.progressSource?(text(row.progressSource.speaker,100)||'Agent')+(row.progressSource.at?' · '+relativeTime(row.progressSource.at):''):'来源：本开发群聊')}${row.progressSource?.runId&&row.execution?.runId&&row.progressSource.runId!==row.execution.runId?' · 上一轮汇报，当前轮待更新':''}</div></div>
      <div class="devb-flow"><div class="devb-stage">${esc(text(stage.label,100)||'状态待确认')}</div><ol aria-label="开发流程位置">${flow.map(step=>`<li class="${step.state}" ${step.state==='current'?'aria-current="step"':''}><span>${step.state==='complete'?'✓':'●'}</span>${step.label}</li>`).join('')}</ol><div class="devb-time">${esc(round.replace(/^ · /,''))||'等待布置目标'}${row.flow?.manual?' · 自动流程已关闭':''}</div></div>
      <time class="devb-row-time" title="更新于 ${esc(timeText(row.activityAt))}；创建于 ${esc(timeText(row.createdAt))}">${esc(relativeTime(row.activityAt))}</time><div class="devb-row-links">${button('open',icon('arrow'),'class="devb-icon-button" aria-label="进入群聊" title="进入原群聊"')}<details class="devb-menu" data-detail-key="${esc(id)}-menu" ${state.expanded.has(id+'-menu')?'open':''}><summary aria-label="任务操作" title="置顶、置底与流程操作">•••</summary><div class="devb-menu-items">${button(row.pinned?'unpin':'pin',row.pinned?'取消置顶':'置顶',disabled)}${button(row.bottomed?'unbottom':'bottom',row.bottomed?'取消置底':'置底',disabled)}${actions.stop?button('stop','停止流程',disabled):''}${actions.resume?button('resume','恢复中断流程',disabled):''}${actions.takeover?button('takeover','手动接管',disabled):''}${actions.restore?button('restore','恢复自动设置',disabled):''}</div></details></div></div>
      ${row.attention?`<div class="devb-attention devb-attention-${esc(row.attention.kind||'stage')}"><strong>${esc(text(row.attention.label,40)||'需要你处理')}</strong><span>${esc(text(row.attention.text,600))}</span></div>`:''}
      ${warning?`<div class="devb-warning">${esc(warning)}</div>`:''}
      <div class="devb-details" ${state.expanded.has(id)?'':'hidden'}>${row.goal?`<div class="devb-goal"><strong>任务目标</strong>　${esc(row.goal)}</div>`:''}${row.plan?`<div class="devb-plan"><strong>打算怎么做</strong><p>${esc(text(row.plan,2000))}</p></div>`:''}<div class="devb-chronicle-block"><strong>任务纪事</strong>${chronicleHtml(row)}</div><dl><dt>实现</dt><dd>${esc(card.progress||'尚无最终交接汇报')}</dd><dt>自测</dt><dd>${esc(card.verified||'尚无自测汇报')}</dd><dt>风险</dt><dd>${esc(card.risk||'未报告风险')}</dd><dt>审核</dt><dd>${esc(review.decision==='pass'?'最近一次审核报告 PASS':review.decision==='fail'?'最近一次审核报告 FAIL':'尚无审核裁决')}</dd><dt>验证</dt><dd>${esc(review.verified||'尚无独立验证汇报')}</dd>${review.next?`<dt>下一步</dt><dd>${esc(review.next)}</dd>`:''}</dl>${card.notes||review.notes?`<div class="devb-notes"><strong>给你的说明</strong>${card.notes?`<p>${esc(text(card.notes,2000))}</p>`:''}${review.notes?`<p><em>合并位：</em>${esc(text(review.notes,2000))}</p>`:''}</div>`:''}<p class="devb-source">${esc(sourceText(row.review||row.card))}。席位汇报供你核对，审核通过不代表已经合并或发布。${row.truncated?'长汇报已节选，完整内容请查看群聊原文。':''}</p>${row.report?button('report','查看报告'):''}</div>
      ${pending?'<div class="devb-receipt" role="status">操作处理中；其他任务和群聊入口仍可使用。</div>':''}${current?`<div class="devb-receipt ${current.error?'error':''}" role="status">${esc(current.message)}</div>`:''}</article>`;
  }
  function projectHtml(group){
    const currentLimit=state.projectLimits.get(group.key)||3,historyLimit=state.historyLimits.get(group.key)||0;
    return `<section class="devb-project-row" data-project-key="${esc(group.key)}"><header class="devb-project-header"><div><h3>${esc(group.name)}</h3><p title="${esc(group.workspace)}">${esc(group.workspace||'这些群聊尚未绑定工作目录')}</p></div><div class="devb-project-count">${group.current.length} 个当前任务<span>更新 ${esc(timeText(group.activityAt))}</span></div>${button('history',`${historyLimit?'收起':'展开'}历史 ${group.history.length}`,`aria-expanded="${!!historyLimit}" ${group.history.length?'':'disabled'}`)}</header><div class="devb-project-current">${group.current.slice(0,currentLimit).map(safeRowHtml).join('')||'<p class="devb-no-current">当前没有待推进的任务</p>'}</div>${group.current.length>currentLimit?button('more-current',`再显示当前任务（剩余 ${group.current.length-currentLimit}）`,'class="devb-more"'):''}${historyLimit?`<div class="devb-project-history"><div class="devb-history-label">已通过或已停止 · ${group.history.length} 项</div>${group.history.slice(0,historyLimit).map(safeRowHtml).join('')}${group.history.length>historyLimit?button('more-history',`再显示历史任务（剩余 ${group.history.length-historyLimit}）`,'class="devb-more"'):''}</div>`:''}</section>`;
  }
  function safeRowHtml(row){try{return rowHtml(row);}catch(error){return `<article class="devb-row" data-mid="${esc(row.id)}"><h3>此任务暂时无法显示</h3><p class="devb-warning">${esc(error.message)}</p>${button('open','进入原群聊')}</article>`;}}
  function scheduleRender(){if(renderTimer||!state.opened)return;renderTimer=setTimeout(()=>{renderTimer=null;render();},80);}
  function render(){
    if(!root||!state.opened)return;
    try{
      const rows=[...state.rows.values()],counts={all:rows.length,attention:0,running:0,passed:0,idle:0};rows.forEach(row=>counts[bucket(row)]++);
      const labels={all:'全部',attention:'需要处理',running:'进行中',passed:'已通过',idle:'其他'};
      root.querySelectorAll('[data-filter]').forEach(el=>{el.innerHTML=labels[el.dataset.filter]+' <span>'+counts[el.dataset.filter]+'</span>';el.setAttribute('aria-pressed',String(state.filter===el.dataset.filter));});
      const projects=Model.groupProjects(rows,state.sort),projectEl=root.querySelector('#devb-project');
      const names=new Map();projects.forEach(p=>names.set(p.name,(names.get(p.name)||0)+1));
      const options='<option value="">所有项目</option>'+projects.map(p=>`<option value="${esc(p.key)}">${esc(p.name+(names.get(p.name)>1?' · '+p.workspace:''))}</option>`).join('');
      if(projectEl.innerHTML!==options){projectEl.innerHTML=options;projectEl.value=state.project;}
      const needle=state.search.trim().toLocaleLowerCase();
      const filtered=Model.readingOrder(rows.filter(row=>(state.filter==='all'||bucket(row)===state.filter)&&(!state.project||Model.projectKey(row)===state.project)&&(!needle||[row.title,row.project,row.workspace,row.progress].join(' ').toLocaleLowerCase().includes(needle))),state.sort,state.readingTasks);
      const showingProjects=state.mode==='projects',items=showingProjects?Model.groupProjects(filtered,state.sort,state.readingTasks,state.readingProjects):filtered,pageSize=showingProjects?12:PAGE_SIZE;
      const pages=Math.max(1,Math.ceil(items.length/pageSize));state.page=Math.max(0,Math.min(state.page,pages-1));
      const visible=items.slice(state.page*pageSize,(state.page+1)*pageSize),grid=listEl.querySelector('.devb-grid'),keep=new Set(visible.map(row=>row.id));
      root.querySelectorAll('[data-mode]').forEach(el=>{el.setAttribute('aria-selected',String(el.dataset.mode===state.mode));el.tabIndex=el.dataset.mode===state.mode?0:-1;});
      root.querySelector('.devb-order-hint').textContent=showingProjects?'当前任务优先展示 · 历史按需展开':'群聊主动汇报 · 置顶优先，置底最后';
      root.querySelector('.devb-columns').hidden=showingProjects;
      listEl.setAttribute('aria-labelledby','devb-tab-'+state.mode);
      const focus=document.activeElement,focusId=focus?.closest('.devb-row')?.dataset.mid,focusAction=focus?.dataset.devbAction,focusMenu=focus?.matches('summary');
      if(grid.dataset.mode!==state.mode){grid.replaceChildren();grid.dataset.mode=state.mode;}
      for(const el of [...grid.children])if(!keep.has(el.dataset.itemKey))el.remove();
      visible.forEach((row,index)=>{
        const html=showingProjects?projectHtml(row):safeRowHtml(row);
        let el=[...grid.children].find(node=>node.dataset.itemKey===row.id);
        if(!el||el._devbHtml!==html){const template=document.createElement('template');template.innerHTML=html;const fresh=template.content.firstElementChild;fresh._devbHtml=html;fresh.dataset.itemKey=row.id;if(el)el.replaceWith(fresh);el=fresh;}
        if(grid.children[index]!==el)grid.insertBefore(el,grid.children[index]||null);
      });
      if(focusId&&focusAction&&!focus.isConnected){const card=[...grid.querySelectorAll('.devb-row')].find(el=>el.dataset.mid===focusId),next=card&&[...card.querySelectorAll('[data-devb-action]')].find(el=>el.dataset.devbAction===focusAction);if(next&&!next.disabled)next.focus({preventScroll:true});}
      if(focusId&&focusMenu&&!focus.isConnected){[...grid.querySelectorAll('.devb-row')].find(el=>el.dataset.mid===focusId)?.querySelector('.devb-menu summary')?.focus({preventScroll:true});}
      const empty=listEl.querySelector('.devb-empty');empty.hidden=visible.length>0;empty.innerHTML=rows.length?'没有符合当前筛选条件的任务。':'<h3>从一个开发群聊开始</h3><p>新建群聊时选择“开发”场景，绑定项目并布置任务。<br>已有群聊的进展、审核与恢复入口会集中显示在这里。</p>';
      listEl.querySelector('.devb-pager').innerHTML=pages>1?button('previous','上一页',state.page===0?'disabled':'')+`<span>第 ${state.page+1} / ${pages} 页 · 每页最多 ${pageSize} ${showingProjects?'个项目':'个任务'}</span>`+button('next','下一页',state.page===pages-1?'disabled':''):'';
      root.querySelector('#devb-status').textContent=`${rows.length} 个开发群聊 · ${counts.attention} 个需要处理 · ${counts.running} 个正在推进`+(state.loading?' · 载入中…':'');
      root.querySelector('#devb-subtitle').textContent=projects.length+' 个项目'+(counts.attention?'，'+counts.attention+' 项需要你处理。':'，进展与审核汇报集中在这里。');
      root.querySelector('#devb-count-tasks').textContent=rows.length;root.querySelector('#devb-count-projects').textContent=projects.length;
      root.classList.toggle('devb-compact',state.density==='compact');
      const density=root.querySelector('#devb-density');density.innerHTML=icon('density')+(state.density==='compact'?'紧凑':'舒适');density.setAttribute('aria-pressed',String(state.density==='compact'));
      const updates=root.querySelector('#devb-updates');updates.hidden=!state.updates.size;updates.textContent=state.updates.size+' 项任务有新进展 · 内容已更新，点击按时间重排';
      const sync=root.querySelector('#devb-sync');sync.textContent=state.loading?'正在同步':state.error?'同步需检查':state.updatedAt?'进展已同步':'等待群聊汇报';sync.title=state.updatedAt?'最近收到更新 '+new Date(state.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}):'';sync.classList.toggle('has-error',!!state.error);root.querySelector('#devb-banner').textContent=state.error;
    }catch(error){root.querySelector('#devb-banner').textContent='工作台显示异常，原群聊仍保留。请重新载入：'+(error.message||error);}
  }
  function bounded(promise,ms,message){let timeout;return Promise.race([promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timeout));}
  function acceptRows(rows){if(!Array.isArray(rows))throw new Error('任务摘要列表格式无效');for(const row of rows){if(!row||typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,255}$/.test(row.id))continue;state.rows.set(row.id,row);}}
  function applyChange(payload){
    if(!payload||typeof payload.epoch!=='string'||!Number.isFinite(payload.sequence))return;
    if(payload.epoch!==state.epoch){state.error='工作台服务已重建，请重新载入以接收最新状态。';scheduleRender();return;}
    if(payload.sequence<=state.sequence)return;if(payload.sequence>state.sequence+1)state.error='部分推送未收到，当前显示已知状态；请重新载入。';
    if(state.opened&&!state.loading&&Array.isArray(payload.rows))for(const row of payload.rows){
      if(!row||typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,255}$/.test(row.id))continue;
      const before=state.rows.get(row.id);
      if(before?.loading||before&&(before.progress===row.progress&&before.activityAt===row.activityAt&&before.stage?.key===row.stage?.key))continue;
      if(!state.readingTasks){const rows=[...state.rows.values()];state.readingTasks=Model.sortRows(rows,state.sort).map(r=>r.id);state.readingProjects=Model.groupProjects(rows,state.sort).map(p=>p.id);}
      state.updates.add(row.id);
    }
    acceptRows(payload.rows);for(const id of Array.isArray(payload.removed)?payload.removed:[]){state.rows.delete(id);state.receipts.delete(id);state.expanded.delete(id);state.expanded.delete(id+'-menu');state.updates.delete(id);}
    state.sequence=payload.sequence;state.updatedAt=Date.now();scheduleRender();
  }
  async function reload(){
    if(!buildSkeleton())return;const request=++state.request;state.loading=true;state.buffered=[];state.error='';releaseOrder();render();
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
    if(action==='reorder'){releaseOrder();render();return;}
    if(action==='density'){state.density=state.density==='compact'?'comfortable':'compact';saveView();render();return;}
    if(action==='filter'){state.filter=target.dataset.filter;state.page=0;releaseOrder();render();return;}
    if(action==='mode'){state.mode=target.dataset.mode;state.page=0;releaseOrder();saveView();render();listEl.scrollTop=0;return;}
    if(['history','more-current','more-history'].includes(action)){
      const key=target.closest('[data-project-key]')?.dataset.projectKey;if(!key)return;
      if(action==='history')state.historyLimits.set(key,state.historyLimits.get(key)?0:10);
      else if(action==='more-current')state.projectLimits.set(key,(state.projectLimits.get(key)||3)+10);
      else state.historyLimits.set(key,(state.historyLimits.get(key)||10)+10);
      render();return;
    }
    if(action==='previous'||action==='next'){state.page+=action==='next'?1:-1;render();listEl.scrollTop=0;return;}
    const id=target.closest('.devb-row')?.dataset.mid,row=state.rows.get(id);if(!row)return;
    if(action==='details'){if(state.expanded.has(id))state.expanded.delete(id);else state.expanded.add(id);render();return;}
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
    const placement=['pin','unpin','bottom','unbottom'].includes(action);
    if(!placement){if(!descriptions[action]||!row.actions?.[action])return;if(!await confirmOperation(descriptions[action][0],row.title+'\n\n'+descriptions[action][1]))return;}
    state.expanded.delete(id+'-menu');
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
