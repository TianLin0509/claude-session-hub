'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const D=require('../../core/delivery-workflow');
const {getSessionRuntimeTruth}=require('../../core/session-runtime-truth');
const {SessionOpenOwnership}=require('../../core/session-open-ownership');
const terminal=r=>['done','cancelled'].includes(r?.status);
function createDeliveryEngine({meetingManager,sessionManager,getHubDataDir,getDispatcher,ensureMemberReady,getMembers=()=>[],getAttemptEvidence=()=>null,sendToRenderer=()=>{},logger=console}) {
  const owners=new Map(),busy=new Set(),watching=new Set(),actions=new Set(),retiring=new Map(),activeDispatches=new Set();let timer=null,events=null,suspended=false,ownership=null;
  async function action(id,fn){if(actions.has(id))throw new Error('正在处理本群的工作流操作，请稍后查看');actions.add(id);try{return await fn();}finally{actions.delete(id);}}
  const meeting=id=>meetingManager.getMeeting(id);
  const base=id=>D.directory(getHubDataDir(),id);
  const record=id=>path.join(base(id),'run.json');
  function read(id) {try{return JSON.parse(fs.readFileSync(record(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  function own(id) {
    if(!D.enabled(meeting(id)))throw new Error('此群未启用文件交付工作流');
    fs.mkdirSync(base(id),{recursive:true});
    // Reuse the Hub's transactional ownership mechanism: SQLite releases its
    // transaction lock after a crash; no stale file-lock deletion race.
    ownership ||= new SessionOpenOwnership({directory:path.join(getHubDataDir(),'workflow-owners')});
    const key=D.hash(id),local=owners.get(id),owner=ownership.owner(key);
    if(local && owner?.nonce===local.nonce)return;
    owners.set(id,ownership.claim(key));
  }
  function save(id,run) {
    if(ownership?.owner(D.hash(id))?.nonce!==owners.get(id)?.nonce || !owners.has(id))throw new Error('工作流归属已变化，停止写入');
    run.updatedAt=Date.now();const tmp=record(id)+'.'+crypto.randomUUID()+'.tmp';
    const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(run,null,2),'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,record(id));emit(id);
  }
  function status(id) {
    if(!D.enabled(meeting(id)))return null;
    const r=read(id),s=r?.steps.at(-1),names=getMembers(meeting(id));
    return {meetingId:id,runId:r?.id,status:r?.status || 'idle',running:r?.status==='running',paused:r?.status==='paused',done:r?.status==='done',
      finished:terminal(r),recoveryPending:!!r && !terminal(r) && !watching.has(id),
      dir:r?path.join(base(id),r.id):base(id),round:s?.number || 0,name:s?r.stages[s.index].name:'尚未开始',error:r?.error || '',
      stageIndex:s?.index ?? 0,stageNames:(r?.stages || meeting(id).serialWorkflow.deliveryStages || []).map(stage=>stage.name),
      missing:s?s.members.filter(m=>!s.deliveries[m]).map(m=>names.find(n=>n.memberId===m)?.displayName || m):[],
      delivered:s?Object.keys(s.deliveries).length:0,total:s?.members.length || 0,dispatches:s?.dispatches || [],
      label:!r?'输入任务，按流程执行':r.status==='cancelled'?'本次任务已结束，交付记录已保留':r.status==='done'?'全部步骤已交付':`${r.stages[s.index].name} · ${Object.keys(s.deliveries).length}/${s.members.length} 位已交付`};
  }
  function emit(id){sendToRenderer('delivery:changed',status(id));}
  function selectStep(id,step) {
    const m=meeting(id),indexes=step.members.map(member=>(m.slotSpecs || []).findIndex((s,i)=>(s.memberId || `m${i+1}`)===member));
    if(indexes.some(i=>i<0))throw new Error('工作流成员缺失，请核对成员设置');
    meetingManager.setParticipants(id,indexes);
    sendToRenderer('meeting-updated',{meeting:meeting(id)});
  }
  function current(id,runId,stepId) {if(!owners.has(id))return null;const r=read(id);return r?.id===runId && r.steps.at(-1)?.id===stepId?r:null;}
  function receipt(id,runId,stepId,dispatchId,item) {
    const r=current(id,runId,stepId);if(!r || terminal(r))return;
    const dispatch=r.steps.at(-1).dispatches.find(x=>x.id===dispatchId);if(!dispatch)return;
    dispatch.receipts[item.memberId]=item;
    if(!item.ok){r.error=`${item.memberId} 提交未确认：${item.reason || item.sendStatus || '请核对原生记录'}`;r.status='paused';}
    save(id,r);
  }
  async function dispatch(id,run,step,continuation='') {
    const targets=step.members.filter(m=>!step.deliveries[m]);if(!targets.length)return;
    const dispatchId=crypto.randomUUID();step.dispatches.push({id:dispatchId,targets,receipts:{},state:'intent',at:Date.now()});save(id,run);
    // Persist intent before any await/send. A recovered intent never auto-replays.
    const notSent=()=>{const r=current(id,run.id,step.id);if(!r || terminal(r))return;const d=r.steps.at(-1).dispatches.find(x=>x.id===dispatchId);d.state='settled';d.chatStatus='not_sent';save(id,r);};
    try{for(const member of targets){if(suspended || meeting(id)?.status==='dormant' || current(id,run.id,step.id)?.status!=='running'){notSent();return;}await ensureMemberReady(meeting(id),member);}}
    catch(error){notSent();throw error;}
    const prepared=current(id,run.id,step.id);if(!prepared || prepared.status!=='running' || suspended){notSent();return;}run=prepared;
    step=run.steps.at(-1);const d=step.dispatches.find(x=>x.id===dispatchId);d.state='sending';save(id,run);
    let promise;activeDispatches.add(dispatchId);
    try{promise=getDispatcher().dispatchGroupChatTurn(id,{userInput:[continuation,D.prompt(base(id),run,step,getMembers(meeting(id)))].filter(Boolean).join('\n\n'),
      dispatchPresentation:{goal:run.goal,stageName:run.stages[step.index].name},
      targetMemberIds:targets,appendUserMessage:true,dispatchMode:'serial',fileHandoff:true,turnTimeoutMs:0,
      workflowRun:{runId:run.id,kind:'delivery',stepIndex:step.number-1,attempt:step.dispatches.length},
      onSubmission:item=>receipt(id,run.id,step.id,dispatchId,item),
      shouldDispatch:()=>{const now=current(id,run.id,step.id);return !suspended && meeting(id)?.status!=='dormant' && now?.status==='running';}});}catch(error){activeDispatches.delete(dispatchId);throw error;}
    Promise.resolve(promise).then(result=>{
      const now=current(id,run.id,step.id);if(!now || terminal(now))return;
      const attempt=now.steps.at(-1).dispatches.find(x=>x.id===dispatchId);attempt.state='settled';
      attempt.chatStatus=result?.status || 'unknown';
      const failure=result?.results?.find(x=>['errored','absent','failed'].includes(x.status));
      if(result?.status==='error' || result?.status==='no_subs' || failure){now.error=String(failure?.reason || result.reason || result.status);now.status='paused';}
      // Completion changes diagnostics only. Files decide advancement, even after errors.
      save(id,now);tick(id);
    },error=>{const now=current(id,run.id,step.id);if(!now || terminal(now))return;now.error=error.message;now.status='paused';save(id,now);logger.error('[delivery] dispatch failed:',error);}).finally(()=>activeDispatches.delete(dispatchId)).catch(error=>{
      logger.error('[delivery] completion persistence failed:',error);
      sendToRenderer('delivery:changed',{meetingId:id,paused:true,error:error.message,label:'交付状态保存失败，请核对'});
    });
  }
  async function advance(id) {
    if(suspended || busy.has(id) || !owners.has(id))return;
    busy.add(id);let expectedRun;
    try {
      let r=read(id);if(!r || terminal(r))return;
      expectedRun=r.id;
      if(!D.enabled(meeting(id)) || meeting(id).status==='dormant'){r.status='paused';r.error='群聊已关闭、休眠或配置改变，核对交付后再接续';save(id,r);return;}
      const step=r.steps.at(-1);let changed=false;
      // After restart there is no old Promise to settle this record. Reconcile
      // only exact persisted attempts; an idle session alone proves nothing.
      for(const [index,d] of step.dispatches.entries()){if(d.state==='settled' || activeDispatches.has(d.id))continue;
        if(d.targets.every(member=>{
          const receipt=d.receipts[member];
          const evidence=getAttemptEvidence(id,receipt?.attemptId,{runId:r.id,stepIndex:step.number-1,attempt:index+1,memberId:member}),a=evidence?.attempt;
          return !!a && (!receipt?.attemptId || (a.attemptId===receipt.attemptId && a.sid===receipt.sid)) && a.memberId===member
            && a.workflowRun?.runId===r.id && a.workflowRun?.stepIndex===step.number-1
            && a.workflowRun?.kind==='delivery' && a.workflowRun?.attempt===index+1
            && (a.status==='completed' || a.status==='interrupted' || !!evidence.sourceCompletedAt);
        })){d.state='settled';d.chatStatus='reconciled';changed=true;}
      }
      for(const member of step.members){const found=D.readDelivery(base(id),r,step,member),old=step.deliveries[member];
        if(old && (!found || found.hash!==old.hash))throw new Error(`${member} 已接纳的交付被修改或移除`);
        if(found && !old){step.deliveries[member]=found;changed=true;}}
      // Revalidate pinned inputs before dispatching downstream work.
      for(const input of step.inputs)if(D.hash(fs.readFileSync(input.path))!==input.hash)throw new Error('前序交付已变化，请核对；未接续下一轮');
      if(changed)save(id,r);
      if(r.status!=='running')return;
      if(Object.values(step.deliveries).some(d=>d.outcome==='blocked')){r.status='paused';r.error='成员报告阻塞，请查看任务文件；可结束本次任务，保留记录后调整目标重开';save(id,r);return;}
      if(step.members.every(m=>step.deliveries[m])) {
        const stage=r.stages[step.index],rework=Object.values(step.deliveries).some(d=>d.outcome==='rework');
        const next=stage.after==='review'?(rework?1:null):stage.after==='end'?null:step.index+1;
        if(next===null || next>=r.stages.length){r.status='done';r.error='';save(id,r);getDispatcher().handoffMeetingTurn?.(id);return;}
        if(r.steps.length-r.budgetStart>=D.LIMIT){r.status='paused';r.error='已达 6 轮，保留交付；明确继续后授予新预算';save(id,r);return;}
        r.steps.push(D.newStep(r,next));D.prepare(base(id),r,r.steps.at(-1));save(id,r);
        selectStep(id,r.steps.at(-1));
        await dispatch(id,r,r.steps.at(-1));return;
      }
      if(!step.dispatches.length)await dispatch(id,r,step);
    }catch(error){logger.error('[delivery] advance:',error);try{const r=read(id);if(r && r.id===expectedRun && !terminal(r)){r.status='paused';r.error=error.message;save(id,r);}}catch(saveError){logger.error('[delivery] could not persist failure:',saveError);sendToRenderer('delivery:changed',{meetingId:id,status:'paused',paused:true,error:saveError.message,label:'工作流记录保存失败'});}}
    finally{busy.delete(id);}
  }
  function release(id){const lease=owners.get(id);if(!lease)return;ownership.release(lease);owners.delete(id);watching.delete(id);retiring.delete(id);}
  function retire(id){if(!D.enabled(meeting(id)))return;stop(id);retiring.set(id,[...(meeting(id).subSessions || [])]);}
  function tick(id){
    for(const [mid,sids] of retiring){if(sids.every(sid=>!sessionManager?.getSession(sid) && !sessionManager?.openLeases?.has(sid)) && !busy.has(mid)){
      try{release(mid);}catch(error){logger.error('[delivery] release after writer shutdown:',error);}
    }}
    if(id){if(watching.has(id))void advance(id);return;}for(const mid of watching)void advance(mid);
  }
  async function start(id,goal,recipientSids) {
    if(!D.enabled(meeting(id)) || !meeting(id).serialWorkflow.enabled)throw new Error('文件交付工作流未启用');
    if(recipientSids!==undefined){
      const selected=require('../../core/groupchat-recipients').memberIds(meeting(id),recipientSids),first=meeting(id).serialWorkflow.deliveryStages[0].members;
      if(selected.length!==first.length || first.some(m=>!selected.includes(m)))throw new Error('收件头像与工作流首步不一致，请核对后发送');
    }
    if(!String(goal || '').trim())throw new Error('请输入本次任务');
    own(id);const old=read(id);if(old && !terminal(old))throw new Error('本次任务尚未交付，请继续或结束当前任务');
    if(old)fs.writeFileSync(path.join(base(id),old.id,'已结束运行.json'),JSON.stringify(old,null,2),'utf8');
    const cfg=meeting(id).serialWorkflow;
    const r={id:crypto.randomUUID(),goal:String(goal),workspace:meeting(id).workspace,projectLocator:cfg.projectLocator || '',kind:cfg.deliveryKind,
      stages:JSON.parse(JSON.stringify(cfg.deliveryStages)),steps:[],status:'running',budgetStart:0,createdAt:Date.now(),error:''};
    r.steps.push(D.newStep(r,0));D.prepare(base(id),r,r.steps[0]);
    const dir=path.join(base(id),r.id);fs.writeFileSync(path.join(dir,'任务约定.md'),`# 本次目标\n\n${r.goal}\n\n项目：${r.workspace || '待核实'}\n\n${r.stages.map((s,i)=>`## ${i+1}. ${s.name}\n成员：${s.members.join('、')}；接续：${s.after}\n\n${s.prompt}`).join('\n\n')}`,'utf8');
    save(id,r);selectStep(id,r.steps[0]);watching.add(id);await advance(id);return status(id);
  }
  function stop(id,{interrupt=false}={}){if(!D.enabled(meeting(id)))return false;own(id);const r=read(id);if(r && !terminal(r)){r.controlRevision=(r.controlRevision || 0)+1;r.status='paused';r.error='用户已暂停，晚到交付只记录，不自动接续';save(id,r);}if(interrupt)getDispatcher().interruptMeetingTurn?.(id,{reason:'user_interrupt',targetSids:meeting(id).subSessions});return true;}
  function cancel(id){own(id);const r=read(id);if(r && !terminal(r)){r.controlRevision=(r.controlRevision || 0)+1;r.status='cancelled';r.error='';save(id,r);}getDispatcher().interruptMeetingTurn?.(id,{reason:'user_interrupt',targetSids:meeting(id).subSessions});return status(id);}
  async function resume(id) {
    if(busy.has(id))throw new Error('正在准备派工，请稍后核对');
    own(id);retiring.delete(id);watching.add(id);let r=read(id);if(!r || terminal(r))throw new Error('没有待继续的任务');
    // First collect late files under pause. Never replay before reconciling.
    const expectedRun=r.id,revision=r.controlRevision || 0;
    r.status='paused';save(id,r);
    await advance(id);r=read(id);
    if(!r || r.id!==expectedRun || terminal(r) || (r.controlRevision || 0)!==revision || suspended || retiring.has(id))return status(id);
    const step=r.steps.at(-1);
    if(Object.values(step.deliveries).some(d=>d.outcome==='blocked'))throw new Error('本轮已有阻塞交付，请保留记录；解决阻塞后新建任务，不能覆盖已交付结果');
    r.status='running';r.error='';if(r.steps.length-r.budgetStart>=D.LIMIT)r.budgetStart=r.steps.length;
    save(id,r);await advance(id);return status(id);
  }
  // Explicit user continuation is separate from reconciliation. It never starts a new run.
  async function continueWork(id,text) {
    const before=read(id)?.steps.at(-1);
    await resume(id);const r=read(id),step=r.steps.at(-1);
    if(before?.id!==step.id || !before?.dispatches.length)return status(id);
    if(r.status!=='running' || step.members.every(m=>step.deliveries[m]))return status(id);
    if(busy.has(id))throw new Error('正在接续派工，请稍后查看');
    if(step.dispatches.some(d=>d.state!=='settled'))throw new Error('上一条派工仍在执行、排队或提交待核对；未重复发送，请查看原会话');
    // Do not resend to a live/uncertain writer. The user can inspect its terminal.
    for(const member of step.members.filter(m=>!step.deliveries[m])){
      const m=meeting(id),slot=m.slotSpecs.findIndex((s,i)=>(s.memberId || `m${i+1}`)===member),session=sessionManager?.getSession(m.subSessions[slot]);
      const truth=getSessionRuntimeTruth(session);
      if(!session || !['idle','completed','interrupted','failed','dormant'].includes(truth.state))throw new Error('成员仍在运行、等待或状态未知，请在原会话核对；未重复发送');
    }
    busy.add(id);try{await dispatch(id,r,step,text || '继续当前任务，复用已有成果，补齐本轮交付。');}finally{busy.delete(id);}return status(id);
  }
  function registerIpc(ipcMain){
    for(const [name,fn] of Object.entries({'delivery:status':id=>status(id),'delivery:start':(id,a)=>start(id,a.userInput,a.recipientSids),'delivery:resume':id=>resume(id),'delivery:continue':(id,a)=>continueWork(id,a.userInput),'delivery:cancel':id=>cancel(id),'delivery:stop':id=>({ok:stop(id,{interrupt:true})})}))
      ipcMain.handle(name,async(_e,a={})=>{try{return {ok:true,...await (['delivery:start','delivery:resume','delivery:continue'].includes(name)?action(a.meetingId,()=>fn(a.meetingId,a)):fn(a.meetingId,a))};}catch(error){return {ok:false,error:error.message};}});
  }
  function startWatching(){suspended=false;if(timer)return;events=require('../../core/task-directory-events').subscribeTaskDirectory(getHubDataDir(),id=>tick(id),logger);timer=setInterval(()=>tick(),2000);timer.unref?.();}
  function freeze(){suspended=true;clearInterval(timer);timer=null;events?.dispose();events=null;}
  function dispose(){freeze();for(const id of owners.keys()){try{release(id);}catch(e){logger.error('[delivery] release owner:',e);}}owners.clear();watching.clear();retiring.clear();ownership?.close();ownership=null;}
  return {start:(id,goal)=>action(id,()=>start(id,goal)),status,stop,cancel,retire,resume:id=>action(id,()=>resume(id)),continueWork:(id,text)=>action(id,()=>continueWork(id,text)),tick,registerIpc,startWatching,freeze,dispose,handles:id=>D.enabled(meeting(id)),isBusy:id=>{const r=read(id);return !!r && !terminal(r);}};
}
module.exports={createDeliveryEngine};
