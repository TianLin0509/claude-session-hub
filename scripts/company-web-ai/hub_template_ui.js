// Company template edition: fixed layouts; content is supplied by CodeAgent.
const priorSyncDesign=syncDesign;
syncDesign=function(){
 creationMode='template';
 if(!templateCatalog.some(t=>t.code===style))style=templateCode='C1';
 priorSyncDesign();
 $('#templateModeButton').disabled=!!readLocal(pendingKey());
 $('#freeModeButton').hidden=true;$('#freeSection').hidden=true;$('#templateSection').hidden=false;
 $('#manualReferenceHint').hidden=true;$('#copyPrompt').hidden=true;
 $('#styleRecommendation').textContent='选固定模板，由 CodeAgent 提炼内容，自动生成清晰海报和可编辑 PPT。';
 $('#autoPpt').checked=true;$('#autoPpt').disabled=true;
};
prepareDesignScope=function(){const saved=readLocal('weekly-poster-design');creationMode='template';style=templateCode=templateCatalog.some(t=>t.code===saved?.template)?saved.template:'C1';styleChosen=true;};
chooseDesign=function(_mode,code){if(readLocal(pendingKey()))return;clearSummary();creationMode='template';style=templateCode=templateCatalog.some(t=>t.code===code)?code:templateCode;styleChosen=true;writeLocal('weekly-poster-design',{mode:'template',template:templateCode});pendingUI();rememberPosterPreferences();};
const priorLoadJobs=loadJobs;
loadJobs=async function(){await priorLoadJobs();$('#connectionState').textContent='文字由当前公司的 CodeAgent 处理，固定模板生成图片与可编辑 PPT。请保持 Hub 运行。';};
const priorPosterProgress=posterProgress;
posterProgress=function(job){
 if(!String(job.phase).startsWith('codeagent')){
  if(job.state==='complete')return priorPosterProgress(job);
  const note='旧版外部生图流程已停用，原记录与素材保留。可用原素材新建模板任务。';
  return {label:'旧版任务已保留',kind:'error',note,timing:'',html:`<div class="poster-progress"><p>${note}</p><button data-retry-image="${esc(job.id)}">用原素材改为模板生成</button></div>`};
 }
 const done=job.state==='complete',failed=job.state==='failed';
 const label=done?'海报与可编辑 PPT 已生成':failed?'本次未完成':'CodeAgent 正在整理内容';
 const note=done?'模板直接排版，没有外部生图。请核对事实后发布。':failed?(job.message||'原素材已保留，可重试。'):'正在等待当前 Hub 的 CodeAgent 会话，随后自动排版。通常需要1至3分钟，请保持 Hub 运行。';
 const kind=done?'done':failed?'error':'working',timing='任务历时 '+duration(((done||failed)?job.updated:Date.now()/1000)-job.created);
 return {label,kind,note,timing,html:`<div class="poster-progress ${kind}"><div class="poster-steps"><span>CodeAgent 整理内容</span><span>模板排版</span><span>保存图片与 PPT</span></div><p class="progress-detail">${esc(note)}</p><p class="progress-time-text">${esc(timing)}</p>${failed?`<button data-retry-image="${esc(job.id)}">用原素材重新生成</button>`:''}</div>`};
};
states.submitted='CodeAgent 已接收';
for(const [group,label] of [['A','横向'],['B','对照'],['C','四项']]){const el=document.querySelector(`[data-template-filter="${group}"]`);if(el)el.textContent=label;}
$('#freeModeButton').hidden=true;$('#copyPrompt').hidden=true;
// Retire manual external-image handoff while leaving historical downloads intact.
for(const selector of ['#resumeHandoff','#copyHandoff','#downloadHandoff','#uploadHandoff','#handoffFile','#conversationHandoff']){const el=$(selector);if(el)el.hidden=true;}
for(const el of document.querySelectorAll('a[href*="chatgpt.com"]'))el.hidden=true;
