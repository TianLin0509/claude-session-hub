'use strict';
const {ALL_AI_KINDS,getKindLabel}=require('../core/ai-kinds');
const TYPE_LABEL={skill:'Skill',mcp:'MCP',plugin:'插件',command:'命令',tool:'工具'};
const ICON={skill:'<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9Z"/>',
  mcp:'<rect x="7" y="7" width="10" height="10" rx="3"/><path d="M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
  plugin:'<path d="M9 3H4v6h2a3 3 0 1 1 0 6H4v6h5v-2a3 3 0 1 1 6 0v2h5v-6h-2a3 3 0 1 1 0-6h2V3h-5v2a3 3 0 1 1-6 0Z"/>',
  command:'<path d="m5 6 6 6-6 6m8 0h6"/>',tool:'<path d="m4 20 9-9m-2-7a6 6 0 0 0 9 9l-4-2-1-3 2-4a6 6 0 0 0-6 0Z"/>'};
const svg=(type)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[type] || ICON.plugin}</svg>`;
function createCapabilityPanel({document,ipcRenderer,escapeHtml:esc,getActiveSessionId}) {
  let page,catalog=null,runtime=null,tab='catalog',agent='all',type='all',query='',scope='all',selected='',sessionId='',busy=false,error='',epoch=0;
  const label=id=>getKindLabel(id) || id;
  const button=(text,attrs,cls='')=>`<button type="button" class="cp-button ${cls}" ${attrs}>${text}</button>`;
  const badge=(text,cls='')=>`<span class="cp-badge ${cls}">${esc(text)}</span>`;
  function position(){const rail=document.getElementById('scene-rail')?.getBoundingClientRect();if(page&&rail){page.style.left=rail.right+'px';page.style.top=rail.top+'px';}}
  function rows(){
    let result=tab==='runtime'?(runtime?.rows || []):(catalog?.rows || []);
    if(tab==='catalog')result=result.filter(r=>(agent==='all'||r.agents.includes(agent)) && (scope==='all'||scope==='shared'&&r.shared||scope==='conflict'&&r.conflict||scope==='disabled'&&r.sources.some(s=>s.enabled===false||s.missing)));
    return result.filter(r=>(type==='all'||r.type===type)&&(!query||`${r.name} ${r.description}`.toLowerCase().includes(query.toLowerCase())));
  }
  function status(r){
    if(tab==='runtime')return badge(r.status,/失败|禁用|未知|未启动|需要授权|未确认|取消/.test(r.status)?'warn':'native');
    const src=r.sources.filter(s=>agent==='all'||s.agent===agent);
    if(src.some(s=>s.missing))return badge('安装待核对','warn');
    if(src.every(s=>s.enabled===false))return badge('已禁用','muted');
    return badge(r.shared?'公共目录':'本地登记',r.shared?'shared':'');
  }
  function detail(r){
    if(!r)return '<div class="cp-placeholder">'+svg('plugin')+'<h3>探索你的 AI 能力</h3><p>选择左侧条目，查看来源、覆盖范围和状态。</p></div>';
    const sources=r.sources || [];
    return `<div class="cp-detail-head"><span class="cp-glyph ${r.type}">${svg(r.type)}</span>${badge(TYPE_LABEL[r.type] || r.type)}${status(r)}</div><h2>${esc(r.name)}</h2><p class="cp-description">${esc(r.description || '此条目未提供说明。')}</p>
      ${r.conflict?'<div class="cp-notice warn">同名入口的正文不同。可能是专用适配，请核对后再统一。</div>':''}
      ${tab==='catalog'?`<h4>可发现的客户端</h4><div class="cp-chips">${r.agents.map(a=>badge(label(a))).join('')}</div><p class="cp-fine">按本地目录和配置发现；不代表正在运行的会话已加载。</p><h4>来源与配置</h4>${sources.map(s=>`<div class="cp-source"><div><strong>${esc(label(s.agent))}</strong>${badge(s.enabled===false?'已禁用':s.missing?'未找到安装记录':'已登记',s.missing?'warn':'')}</div><small>${esc(s.scope==='shared'?'公共技能目录':s.scope==='user'?'用户目录':s.scope==='system'?'系统技能':s.scope==='plugin'?'插件提供':s.scope)}</small><code>${esc(s.path)}</code>${s.realPath&&s.realPath!==s.path?`<small>指向</small><code>${esc(s.realPath)}</code>`:''}${s.version?`<small>版本 ${esc(s.version)}</small>`:''}</div>`).join('')}`:`<div class="cp-notice">${esc(runtime?.note || '当前原生连接报告的能力。')}</div><h4>确认时间</h4><p>${esc(new Date(runtime?.observedAt || Date.now()).toLocaleString())}</p>`}`;
  }
  function render(){
    if(!page)return;
    const visible=rows(),all=catalog?.rows || [],active=visible.find(r=>r.id===selected) || visible[0];
    if(active)selected=active.id;
    const counts=t=>(tab==='runtime'?(runtime?.rows || []):all).filter(r=>r.type===t).length;
    page.innerHTML=`<header class="cp-header"><div><div class="cp-eyebrow">AI HUB / CAPABILITIES</div><h1>技能与工具 <span>让能力一目了然</span></h1></div><div class="cp-actions">${button(busy?'读取中…':'刷新','data-cp-action="refresh" '+(busy?'disabled':''))}${button('返回','data-cp-action="close"')}</div></header>
      <div class="cp-scroll"><div class="cp-summary"><div class="cp-summary-intro"><span class="cp-summary-symbol">${svg('plugin')}</span><div><strong>能力中心</strong><p>公共资源，各有专长。<br>从安装来源到会话回执，都有据可查。</p></div></div>${[['skill',counts('skill'),'工作流与专业知识'],['mcp',counts('mcp'),'连接工具与外部服务'],['plugin',counts('plugin'),'成套扩展与集成']].map(([t,n,sub])=>`<button type="button" class="cp-stat" data-cp-type="${t}"><span>${svg(t)}${TYPE_LABEL[t]}</span><strong>${n}</strong><small>${sub}</small></button>`).join('')}</div>
      <nav class="cp-tabs" aria-label="能力视图">${button('能力目录','data-cp-tab="catalog" aria-pressed="'+(tab==='catalog')+'"',tab==='catalog'?'selected':'')}${button('当前加载','data-cp-tab="runtime" aria-pressed="'+(tab==='runtime')+'"',tab==='runtime'?'selected':'')}<span>${catalog?`扫描于 ${esc(new Date(catalog.generatedAt).toLocaleTimeString())}`:'尚未扫描'}</span></nav>
      ${tab==='catalog'?`<div class="cp-agents" aria-label="按 AI 筛选">${[['all','全部 AI'],...ALL_AI_KINDS.map(a=>[a,label(a)])].map(([id,name])=>button(`<span class="cp-agent-dot ${id}">${id==='all'?'◈':esc(name.slice(0,1))}</span>${esc(name)}<small>${id==='all'?all.length:all.filter(r=>r.agents.includes(id)).length}</small>`,`data-cp-agent="${id}" aria-pressed="${agent===id}"`,agent===id?'selected':'')).join('')}</div>`:
      `<div class="cp-session"><label for="cp-session">查看会话</label><select id="cp-session"><option value="">选择一个已打开的会话</option>${(catalog?.sessions || []).map(s=>`<option value="${esc(s.id)}" ${sessionId===s.id?'selected':''}>${esc(label(s.kind)+' · '+s.title)}</option>`).join('')}</select><span>MCP 档位 <b>${esc(runtime?.profile || '未确认')}</b></span></div>`}
      <div class="cp-toolbar"><label class="cp-search"><span aria-hidden="true">⌕</span><input id="cp-search" type="search" placeholder="搜索名称或功能…" aria-label="搜索能力" value="${esc(query)}"></label><select id="cp-type" aria-label="类型"><option value="all">全部类型</option>${Object.entries(TYPE_LABEL).filter(([k])=>tab==='runtime'||['skill','mcp','plugin'].includes(k)).map(([k,v])=>`<option value="${k}" ${type===k?'selected':''}>${v}</option>`).join('')}</select>${tab==='catalog'?`<select id="cp-scope" aria-label="范围">${[['all','全部来源'],['shared','公共技能'],['conflict','同名差异'],['disabled','禁用 / 待核对']].map(([k,v])=>`<option value="${k}" ${scope===k?'selected':''}>${v}</option>`).join('')}</select>`:''}<span>${visible.length} 项</span></div>
      ${error?`<div class="cp-notice warn" role="alert">${esc(error)}</div>`:''}${busy?'<div class="cp-progress" role="status">正在读取能力信息…</div>':''}
      ${tab==='runtime' && (!sessionId||runtime?.unknown)?`<div class="cp-notice">${esc(runtime?.unknown || '选择已打开的会话查看确认回执。此操作不会创建会话或启动 AI。')}</div>`:''}
      ${tab==='runtime'&&runtime?.note?`<p class="cp-runtime-note">${esc(runtime.note)}</p>`:''}
      ${(tab==='runtime'?runtime?.warnings:catalog?.warnings)?.length?`<details class="cp-warnings"><summary>部分信息未能读取 · ${(tab==='runtime'?runtime.warnings:catalog.warnings).length} 项</summary>${(tab==='runtime'?runtime.warnings:catalog.warnings).map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
      <div class="cp-content"><div class="cp-list" aria-label="能力列表">${visible.length?visible.map(r=>`<button type="button" class="cp-row ${r.id===active?.id?'selected':''}" data-cp-row="${esc(r.id)}" aria-pressed="${r.id===active?.id}"><span class="cp-glyph ${r.type}">${svg(r.type)}</span><span class="cp-row-copy"><strong>${esc(r.name)}</strong><small>${esc(r.description || TYPE_LABEL[r.type])}</small></span><span class="cp-row-meta">${status(r)}${r.conflict?badge('同名差异','warn'):''}<small>${tab==='runtime'?esc(TYPE_LABEL[r.type]):r.agents.map(a=>esc(label(a))).join(' · ')}</small></span></button>`).join(''):`<div class="cp-empty">${svg('skill')}<h3>${busy?'正在发现能力':'这里还没有匹配的能力'}</h3><p>${query?'试试更短的关键词，或切换筛选条件。':tab==='runtime'?'已登记的本地能力可在“能力目录”查看。':'此客户端暂未发现对应入口；加载状态仍以会话回执为准。'}</p></div>`}</div><aside class="cp-detail" aria-label="能力详情">${detail(active)}</aside></div>
      <footer class="cp-footer">公共目录表示可发现的共享入口 · 同名技能可能有客户端适配 · 已登记不等于已加载</footer></div>`;
    position();
  }
  async function refresh(force=false){
    const ticket=++epoch;busy=true;error='';render();
    try {
      const response=await ipcRenderer.invoke('capabilities:catalog',{refresh:force});
      if(ticket!==epoch||page.hidden)return;
      if(!response?.ok)throw Error(response?.error || '能力目录读取失败');
      catalog=response.data;
      if(tab==='runtime'&&sessionId){
        const r=await ipcRenderer.invoke('capabilities:runtime',{sessionId});
        if(ticket!==epoch||page.hidden)return;
        if(!r?.ok)throw Error(r?.error || '会话能力读取失败');
        runtime=r.data;
      }
    }catch(e){if(ticket===epoch){error=e.message;runtime=null;}}
    finally {if(ticket===epoch&&!page.hidden){busy=false;render();}}
  }
  function close(){if(!page)return;page.hidden=true;epoch++;busy=false;document.body.classList.remove('capabilities-open');document.getElementById('btn-rail-capabilities')?.setAttribute('aria-expanded','false');}
  async function open(){
    if(!page){
      page=document.createElement('section');page.id='capability-page';page.className='cp-page';page.setAttribute('aria-label','技能与工具');document.body.appendChild(page);
      page.addEventListener('click',e=>{
        const b=e.target.closest('button');if(!b)return;
        if(b.dataset.cpAction==='close'){close();document.getElementById('btn-rail-capabilities')?.focus();return;}
        if(b.dataset.cpAction==='refresh'){runtime=null;void refresh(true);return;}
        if(b.dataset.cpTab){tab=b.dataset.cpTab;type='all';selected='';runtime=null;sessionId=getActiveSessionId() || catalog?.sessions[0]?.id || '';void refresh();return;}
        if(b.dataset.cpAgent){agent=b.dataset.cpAgent;selected='';render();return;}
        if(b.dataset.cpType){type=b.dataset.cpType;selected='';render();return;}
        if(b.dataset.cpRow){selected=b.dataset.cpRow;const scroll=page.querySelector('.cp-scroll').scrollTop;render();page.querySelector('.cp-scroll').scrollTop=scroll;page.querySelector(`[data-cp-row="${CSS.escape(selected)}"]`)?.focus({preventScroll:true});}
      });
      page.addEventListener('input',e=>{if(e.target.id==='cp-search'){query=e.target.value;render();const input=page.querySelector('#cp-search');input.focus();}});
      page.addEventListener('change',e=>{if(e.target.id==='cp-type')type=e.target.value;else if(e.target.id==='cp-scope')scope=e.target.value;else if(e.target.id==='cp-session'){sessionId=e.target.value;runtime=null;void refresh();return;}else return;selected='';render();});
    }
    page.hidden=false;document.body.classList.add('capabilities-open');document.getElementById('btn-rail-capabilities')?.setAttribute('aria-expanded','true');
    await refresh();
  }
  document.addEventListener('click',e=>{if(e.target.closest('[data-action="open-capabilities"]')){if(page&&!page.hidden)close();else void open();}else if(e.target.closest('#scene-rail button')&&page&&!page.hidden)close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&page&&!page.hidden){close();document.getElementById('btn-rail-capabilities')?.focus();}});
  window.addEventListener('resize',position);
  ipcRenderer.on('session-closed',(_event,event)=>{if(page&&!page.hidden&&event?.sessionId===sessionId){runtime=null;epoch++;busy=false;error='会话已关闭，原生加载回执已失效。';render();}});
  ipcRenderer.on('session-updated',(_event,{session}={})=>{
    if(!page||page.hidden||!runtime||session?.id!==sessionId)return;
    const state=session.nativeRuntime;
    if(state&&(state.epoch!==runtime.epoch||state.connection!=='connected')){
      runtime=null;epoch++;busy=false;error='会话连接已变化，请刷新以读取当前回执。';render();
    }
  });
  return {open,close};
}
module.exports={createCapabilityPanel};
