'use strict';
const path=require('node:path');
const fs=require('node:fs');
const { randomUUID }=require('node:crypto');
const { AssistantHistory }=require('./history');
const { AssistantStore }=require('./store');
const { AssistantBridge }=require('./bridge');
const { buildBootstrapPrompt,resolveTimeRange }=require('./context');
const {AssistantSnapshots}=require('./snapshots');
const { readGroupHistory }=require('./group-history');
const { requireAuthorizedTarget,requireBoundTarget,bindOperation }=require('./action-policy');
const {LiveHistory,nativeId}=require('./live-history');
const {AssistantWatches,reminderIntent}=require('./watches');
const {isAssistantSession,requireManagerCaller}=require('./permissions');
const {projectSessionStates}=require('./session-state');
const backends=require('./backends');
class AssistantService {
  constructor(deps) {
    this.deps=deps; this.sessionViews=new Map(); this.store=new AssistantStore(path.join(deps.dataDir,'assistant'));
    this.history=new AssistantHistory(deps.historyDatabasePath||path.join(deps.dataDir,'cache','session-search-v3.sqlite'));
    this.bridge=new AssistantBridge(request=>this.invokeTool(request)); this.currentRequest=null;
    this.endpointFile=path.join(deps.dataDir,'assistant','bridge-endpoint.json');
    this.snapshots=new AssistantSnapshots(deps.dataDir,this.store);
    this.dossier=new (require('./dossier').AssistantDossier)(deps.dataDir);
    this.liveHistory=new LiveHistory();
    this.continuity=new (require('./continuity').AssistantContinuity)(path.join(deps.dataDir,'assistant'));
    this.watches=new AssistantWatches(this.store,{getSession:id=>this.sessionMetadata(id),getOpenSession:id=>this.deps.getSession(id)?this.sessionMetadata(id):null,onNotification:notice=>this.deps.onAssistantNotification?.(notice)});
  }
  sessionMetadata(id){const persisted=this.deps.getSessionMetadata?.(id),live=this.deps.getSession(id);return persisted||live?{...persisted,...live,id}:null;}
  setSessionViews({changed=[],removed=[]}={}){
    for(const id of removed)this.sessionViews.delete(id);
    for(const row of changed){
      if(!this.deps.getSession(row.id)||!row.hubState||!['run','wait','error','unread','dorm','idle','unknown'].includes(row.hubState.state))continue;
      this.sessionViews.set(row.id,row);
    }
  }
  sessions() {const all=new Map();for(const s of this.deps.listKnownSessions?.()||[]){const id=s.id||s.hubId;if(id)all.set(id,{...s,id,isOpen:false,status:'closed'});}for(const s of this.deps.getAllSessions?.()||[])all.set(s.id,{...all.get(s.id),...s,isOpen:true,sidebarView:this.sessionViews.get(s.id)});return projectSessionStates([...all.values()].filter(s=>!this.assistantIds().includes(s.id)&&s.purpose!=='hub-assistant'));}
  assistantIds(){return Object.values(backends.bindings(this.store));}
  captureContinuity(){for(const id of this.assistantIds()){const meta=this.sessionMetadata(id);if(!meta)continue;for(const row of this.liveHistory.read(meta).records)this.continuity.add({...row,provider:meta.kind,timestamp:row.timestamp||Date.now()});}}
  liveInventory(){return this.sessions().map(s=>{const result=s.isOpen?this.liveHistory.read(s):null;return{...s,nativeSessionId:nativeId(s),latestFinal:result?.records.at(-1)||null,liveIssue:result?.issue||null};});}
  readLiveFinal(sessionId){const meta=this.sessionMetadata(sessionId);if(!meta)throw new Error('找不到原会话');const result=this.liveHistory.read(meta);return{sessionId,title:meta.title,...result};}
  startWatching({intervalMs=2000}={}){if(this.watchTimer)return;this.watchTimer=setInterval(()=>{try{const id=this.store.get('sessionId');if(id&&this.deps.getSession(id))this.pollWatches();}catch{}},Math.max(500,intervalMs));this.watchTimer.unref?.();}
  pollWatches(){const result=this.watches.poll();if(this.store.get('sessionId'))this.refreshDossier?.();return result;}
  notifications(request){return this.watches.notifications(request);}
  followedTasks(){return this.watches.list().map(({cursor,seen,...watch})=>watch);}
  observePromptReceipt(snapshot){
    if(snapshot?.status!=='confirmed'||snapshot.notSent||snapshot.contentMismatch||!snapshot.clientSubmissionId||!snapshot.sessionId)return false;
    if(snapshot.sessionId===this.currentRequest?.sessionId&&snapshot.clientSubmissionId===this.currentRequest.id)this.continuity.add({id:'user:'+snapshot.clientSubmissionId,sessionId:snapshot.sessionId,provider:this.store.get('backendKind')||'codex',role:'user',deliveryState:'confirmed',timestamp:this.currentRequest.createdAt,text:this.currentRequest.text});
    const row=this.store.db.prepare('SELECT state,result FROM actions WHERE id=?').get(snapshot.clientSubmissionId);
    if(!row||row.state!=='unknown'||!row.result)return false;
    const result=JSON.parse(row.result);if(result.sessionId!==snapshot.sessionId)return false;
    this.store.finish(snapshot.clientSubmissionId,'acknowledged',{...result,originalReceipt:result.receipt,lateReceipt:snapshot,
      receipt:{...result.receipt,ok:true,lateReconciled:true,receipt:{...result.receipt?.receipt,...snapshot,status:'confirmed'}}});return true;
  }
  followTask({sessionId}){if(this.assistantIds().includes(sessionId)||this.sessionMetadata(sessionId)?.purpose==='hub-assistant')throw new Error('助理不能关注自身回复');return{ok:true,watch:this.watches.follow(sessionId)};}
  overview() {const sessionId=this.store.get('sessionId'),session=sessionId?this.deps.getSession(sessionId):null,lastContext=this.store.get('lastContext');return{ok:true,sessionId,backendKind:this.store.get('backendKind')||'codex',backends:backends.BACKENDS,backendSessions:backends.bindings(this.store),available:!!session,status:session?.status||'not-created',summary:'',connectionSummary:session?'助理已连接；可以问进展、定位会话并转交任务。':'首次启用后，助理会作为一个独立助理会话运行，可选择 Codex 或 Claude，并连接 Hub 助理工具。',toolConfiguration:'助理专用 lean 配置，连接 Hub 助理工具；普通会话配置保持不变。',needsAttention:[],updatedAt:lastContext?.asOf||null,contextCoverage:lastContext,actions:this.store.list(),followedTasks:this.followedTasks(),watchableSessions:this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status,isOpen:s.isOpen})),...this.notifications({limit:10})};}
  async ensureSession() {
    if(this.switching)throw new Error('助理正在切换后端，请稍候');
    if(this.creating)return this.creating;
    this.creating=this._ensureSession(this.store.get('backendKind')||'codex');try{return await this.creating;}finally{this.creating=null;}
  }
  async switchBackend({kind}={}) {
    backends.backendKind(kind);
    if(this.switching||this.creating)throw new Error('助理正在连接或切换，请稍候');
    const current=this.deps.getSession(this.store.get('sessionId'));
    if(current&&(require('../session-runtime-truth').sessionRuntimeIsActive(current)||['running','waiting'].includes(current.status)))throw new Error('助理正在处理请求或等待响应，请先结束当前回合；原会话和草稿已保留');
    this.captureContinuity();
    this.switching=this._ensureSession(kind);
    try {const result=await this.switching;if(result.ok){this.currentRequest=null;this.store.set('lastContext',null);}return result;}
    finally{this.switching=null;}
  }
  async _ensureSession(kind) {
    const old=backends.bindings(this.store)[kind];
    const finish=async(session,id)=>{
      if(session.id!==id||session.purpose!=='hub-assistant'||session.kind!==kind)throw new Error('助理返回的会话编号或后端与预留身份不一致，需核对创建结果');
      await this.connectBridge();backends.activate(this.store,kind,id);return{ok:true,sessionId:id,backendKind:kind,session};
    };
    if(old){const session=this.deps.getSession(old);if(session)return finish(session,old);
      // A reserved launch can have succeeded even when its receipt was lost.
      if(this.deps.resumeSession){const session=await this.deps.resumeSession(old,this.getLaunchOptions(kind,old));if(session)return finish(session,old);}
      const pending=(this.store.get('backendCreation:'+kind)||this.store.get('assistantCreation'))?.state==='reserved';
      return{ok:false,sessionId:old,needsReconciliation:pending,error:pending?'上次助理创建结果未确认；已保留原编号，需核对该实体后恢复。':'助理原会话未打开，请从历史恢复该会话。'};
    }
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const id=randomUUID();backends.reserve(this.store,kind,id);
    await this.connectBridge();
    const session=await this.deps.createSession(kind,{...defaults,id,title:'AI Hub 助理 · '+(kind==='codex'?'Codex':'Claude'),name:'AI Hub 助理',purpose:'hub-assistant',...this.getLaunchOptions(kind,id)});
    return finish(session,id);
  }
  getLaunchOptions(kind,id){return backends.launchOptions(this,backends.backendKind(kind),id);}
  async connectBridge(){await this.bridge.start();const temporary=this.endpointFile+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify({url:this.bridge.url,token:this.bridge.secret}),{mode:0o600});fs.renameSync(temporary,this.endpointFile);}
  getMcpEntry(sessionId=this.store.get('sessionId')){return{name:'hub_assistant',command:this.deps.nodeExecutable||'node',args:[path.resolve(__dirname,'../../scripts/assistant-mcp.js')],env:{HUB_ASSISTANT_ENDPOINT_FILE:this.endpointFile,HUB_ASSISTANT_SESSION_ID:sessionId||''},toolApprovalModes:{list_sessions:'approve',history_context:'approve',session_evidence:'approve',watch_session:'approve',send_session:'approve',create_session:'approve'},toolOutputTokenLimits:{history_context:50000,session_evidence:50000}};}
  isAssistantSession(sessionId){return isAssistantSession(this.store,sessionId,this.deps.getSession(sessionId));}
  requireAssistantResume(meta){if(!meta?.hubId||!this.assistantIds().includes(meta.hubId)||(meta.kind&&backends.bindings(this.store)[meta.kind]!==meta.hubId))throw new Error('恢复实体不是固定助理，未授予专属工具');}
  context(request={}) {
    const sessionId=this.store.get('sessionId'),session=this.deps.getSession(sessionId);
    const board=this.refreshDossier();
    // Retrieval budgets limit supplemental historical excerpts, never which
    // current sessions the assistant can see or manage.
    const naturalBudget=Number(request.maxChars)||Math.max(6000,board.openedCount*1200);
    const natural=this.history.context({...request,maxChars:naturalBudget,excludeSessionId:sessionId,excludeNativeSessionId:nativeId(session),excludeSessionIds:this.assistantIds(),excludeNativeSessionIds:this.assistantIds().map(id=>nativeId(this.sessionMetadata(id))).filter(Boolean)});
    const groups=readGroupHistory({dataDir:this.deps.dataDir,since:request.query?undefined:(natural.since??request.from??((request.now||Date.now())-(request.hours||3)*3600000)),until:natural.until||natural.asOf,
      query:request.query||'',maxChars:Math.max(6000,board.openedCount*400),maxFiles:30,meetings:this.deps.getMeetings?.()});
    const {sources:groupSources,...groupCoverage}=groups;
    const groupChars=groupSources.reduce((n,s)=>n+s.text.length,0);
    const sources=[...board.sources.map(source=>({...source,timeScope:'当前原生最终答复快照；以该条timestamp为准，不代表它发生在历史检索窗口内'})),...natural.sources.filter(source=>!board.sources.some(live=>live.sessionId===source.sessionId&&source.role==='assistant'&&live.text===source.text)),...groups.sources];
    return {...natural,assistantContinuity:this.continuity.packet(),asOf:Date.now(),available:natural.available||sources.length>0,sources,
      selectedChars:sources.reduce((n,source)=>n+source.text.length,0),groupSelectedChars:groupChars,
      workbench:{revision:board.revision,mode:board.mode,markdownPath:board.markdownPath,markdown:board.markdown,
        inventory:board.openedInventory,activeCount:board.activeCount,openedCount:board.openedCount,unreadCount:board.unreadCount,needsInputCount:board.needsInputCount,knownCount:board.knownCount,timeMeaning:'这是当前工作台状态；历史变化请结合每条来源时间及请求窗口，不能把旧最终答复说成刚发生的变化。',
        catalogPath:path.join(this.dossier.directory,'ALL-SESSIONS.md'),allActiveSessionsIncluded:true,
        revisions:Object.fromEntries(board.openedInventory.map(row=>[row.id,row.revision])),
        changedSessionIds:board.changedSessionIds.filter(id=>board.openedInventory.some(row=>row.id===id)),removedSessionIds:board.removedSessionIds,
        baselineMeaning:board.baselineMeaning,fullReplyChars:board.fullReplyChars},
      truncated:natural.truncated||groups.truncated||board.sources.some(source=>source.truncated),coverage:{singleSessions:natural.coverage,groups:groups.coverage,
        currentSessions:`当前已打开的 ${board.openedCount} 个其他会话全部列出，其中活跃 ${board.activeCount} 个。最新原生答复变化优先提供；长正文可按来源读取，历史片段预算不会排除受管理会话。`,
        groupTimeMeaning:'群聊材料的文件修改时间只证明文件被观察到变化，不证明任务在该时刻完成。'},groupFileCoverage:groupCoverage};
  }
  refreshDossier(){const id=this.store.get('sessionId'),assistant=this.deps.getSession(id);if(id&&!assistant)throw new Error('助理原会话尚未在本窗口打开，工作档案保留原版本');this.captureContinuity();return this.dossier.publish(this.liveInventory(),`${id||''}:${nativeId(assistant)||''}:${assistant?.codexProfile||assistant?.kind||''}`);}
  preparePrompt(request) {
    if(this.switching)throw new Error('助理正在切换后端，请稍候；草稿已保留');
    if(!request||String(request.text||'').trimStart().startsWith('/'))return request;
    const envelope=require('../assistant-context-display').assistantContextDisplay(request.text,'hub-assistant');
    if(envelope)request={...request,text:envelope.userText};
    const active=this.deps.getSession(this.store.get('sessionId'));
    if(request.sessionId!==undefined&&!this.isAssistantSession(request.sessionId))throw new Error('请求不是固定助理会话，消息未发送');
    if(active&&(require('../session-runtime-truth').sessionRuntimeIsActive(active)||active.status==='running'))throw new Error('助理正在处理上一条请求，请等本轮结束后发送；草稿已保留');
    const context=this.context({...resolveTimeRange(request.text,{hours:request.hours,timeZone:this.deps.timeZone}),query:request.historyQuery||''});
    const id=request.clientSubmissionId||request.requestId||randomUUID();
    this.currentRequest={id,sessionId:request.sessionId,text:request.text,token:randomUUID(),createdAt:Date.now()};
    if(request.sessionId)this.continuity.add({id:'user:'+id,sessionId:request.sessionId,provider:active?.kind||'codex',role:'user',deliveryState:'prepared',timestamp:this.currentRequest.createdAt,text:request.text});
    const manifest=this.snapshots.save({requestId:id,requestToken:this.currentRequest.token,packet:context});
    const text=buildBootstrapPrompt(request.text,manifest,this.sessions().length,active?.kind||'codex');
    this.store.set('lastContext',{asOf:context.asOf,selectedChars:context.selectedChars,sources:context.sources.length,truncated:context.truncated,
      workbenchPath:context.workbench.markdownPath,workbenchRevision:context.workbench.revision,openedSessions:context.workbench.openedCount,activeSessions:context.workbench.activeCount,allActiveSessionsIncluded:true,contextMode:context.workbench.mode,
      requestToken:this.currentRequest.token,packetHash:manifest.packetHash,snapshotRead:false,snapshotReadAt:null,bootstrapChars:text.length,
      inputTransportNote:text.length>=2048?'用户原话较长，仍可能触发普通 Codex 编辑器输入通道':'短请求正文；完整资料通过本轮工具读取'});
    return{...request,text,clientSubmissionId:id};
  }
  async send(request) {
    if(typeof request.text!=='string'||!request.text.trim()||request.text.length>50000)throw new Error('请输入有效任务');
    const ensured=await this.ensureSession();if(!ensured.ok)return ensured;
    const receipt=await this.deps.sendPrompt(ensured.sessionId,request.text,request.requestId||randomUUID());
    return{ok:receipt?.ok!==false,sessionId:ensured.sessionId,receipt,contextSummary:this.store.get('lastContext')};
  }
  async invokeTool({name,arguments:args={},callerSessionId}) {
    if(this.switching)throw new Error('助理正在切换后端，本轮工具调用已暂停');
    // No caller is a conservative internal compatibility path only. The HTTP
    // bridge always supplies its host identity and never falls back to it.
    const hasCaller=callerSessionId!==undefined;
    if(hasCaller&&!this.isAssistantSession(callerSessionId))throw new Error('调用方不是固定助理会话，未授予专属工具');
    if(name==='list_sessions')return this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status,isOpen:s.isOpen,hubState:s.hubState,nativeSessionId:nativeId(s)}));
    if(name==='session_evidence')return this.readLiveFinal(args.sessionId);
    if(name==='history_context'){
      if(args.requestToken){
        if(args.requestToken!==this.currentRequest?.token)throw new Error('资料请求不属于当前用户回合');
        const response=this.snapshots.read(args.requestToken),last=this.store.get('lastContext');
        this.dossier.noteServed(response.packet.workbench);
        if(last?.requestToken===args.requestToken)this.store.set('lastContext',{...last,snapshotRead:true,snapshotReadAt:response.snapshotReceipt.readAt,snapshotReadReceipt:response.snapshotReceipt});
        return response;
      }
      return this.context(args);
    }
    if(!['send_session','create_session','watch_session'].includes(name))throw new Error('未知工具');
    const current=this.currentRequest;
    if(!current||Date.now()-current.createdAt>30*60000)throw new Error('本轮用户委托已过期，请重新发送任务');
    if(args.requestToken!==current.token)throw new Error('工具调用不属于当前用户委托');
    const manager=hasCaller&&requireManagerCaller(this.store,current,callerSessionId,this.deps.getSession(callerSessionId));
    if(name==='watch_session'){
      if(!manager){if(!reminderIntent(current.text))throw new Error('本轮没有明确要求新回复后提醒');
        requireBoundTarget(current,{targetSessionId:args.sessionId},this.sessions());}
      return this.followTask({sessionId:args.sessionId});
    }
    const action={type:name==='create_session'?'create':'send',targetSessionId:args.sessionId,title:args.title,text:args.text};
    if(!manager)requireAuthorizedTarget(current,action,this.sessions());
    if(typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    if(this.deps.authorizeAction&&!await this.deps.authorizeAction(action,current))throw new Error('目标不在本轮授权范围内');
    const requestId=bindOperation(this.store,current,args.operationKey,action);
    const followed=action.type==='send'&&reminderIntent(current.text);
    if(followed)this.followTask({sessionId:action.targetSessionId});
    const result=await this.execute({...action,requestId});
    return followed?{...result,followed:true,notificationMethod:'Hub监视原生最终回复并在助理页通知'}:result;
  }
  async execute(action) {
    if(!['send','create'].includes(action.type)||typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    const {requestId,...payload}=action;
    if(this.store.has(requestId)){
      const record=this.store.begin(requestId,payload);
      return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    }
    let resumeMeta=null;
    if(action.type==='send'){
      if(this.assistantIds().includes(action.targetSessionId)||this.sessionMetadata(action.targetSessionId)?.purpose==='hub-assistant')throw new Error('助理不能向自身循环派发');
      const target=this.deps.getSession(action.targetSessionId);
      if(!target){
        const stored=this.deps.getSessionMetadata?.(action.targetSessionId);
        if(!stored||!nativeId(stored)||!this.deps.resumeSession)throw new Error('原目标未打开或缺少原生身份；未创建替代会话');
        resumeMeta=stored;
      }
      const truth=require('../session-runtime-truth');
      if(target&&(truth.sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status)))throw new Error('目标会话正在运行或等待输入，请先明确处理当前任务');
    }
    const record=this.store.begin(requestId,payload);
    if(record.duplicate)return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    let sessionId=action.targetSessionId;
    try {
      if(resumeMeta){
        await this.deps.resumeSession(sessionId);const target=this.deps.getSession(sessionId);
        if(!target||target.id!==sessionId||nativeId(target)!==nativeId(resumeMeta))throw new Error('原目标恢复身份未确认，未发送任务');
        if(require('../session-runtime-truth').sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status))throw new Error('原目标恢复后仍在运行或等待输入，未发送任务');
      }
      if(action.type==='create'){
        const defaults=await this.deps.getDefaults?.('codex')||{};
        const desiredId=randomUUID();this.store.set('reserved:'+requestId,desiredId);
        const session=await this.deps.createSession('codex',{...defaults,id:desiredId,title:String(action.title||'助理委托任务').slice(0,100)});sessionId=session.id;
      }
      const receipt=await this.deps.sendPrompt(sessionId,action.text,requestId);
      const confirmed=receipt?.ok===true&&receipt?.receipt?.status==='confirmed'&&!receipt.notSent&&!receipt.contentMismatch;
      const result={sessionId,receipt};this.store.finish(requestId,confirmed?'acknowledged':'unknown',result);
      return{ok:confirmed,state:confirmed?'acknowledged':'unknown',...result};
    } catch(error) {this.store.finish(requestId,'unknown',{sessionId,error:error.message});return{ok:false,state:'unknown',sessionId,error:error.message};}
  }
  close(){clearInterval(this.watchTimer);this.bridge.close();this.store.close();}
}
module.exports={AssistantService};
