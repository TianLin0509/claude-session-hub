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
const {nativeId}=require('./live-history');
const {AssistantWatches,reminderIntent}=require('./watches');
const {isAssistantSession,requireManagerCaller}=require('./permissions');
const {projectSessionStates}=require('./session-state');
const backends=require('./backends');
const profiles=require('./profiles');
class AssistantService {
  constructor(deps) {
    this.deps=deps; this.sessionViews=new Map(); this.store=new AssistantStore(path.join(deps.dataDir,'assistant'));
    this.history=new AssistantHistory(deps.historyDatabasePath||path.join(deps.dataDir,'cache','session-search-v3.sqlite'));
    this.bridge=new AssistantBridge(request=>this.invokeTool(request)); this.currentRequest=null; this.inputModes=new Map();
    this.endpointFile=path.join(deps.dataDir,'assistant','bridge-endpoint.json');
    this.snapshots=new AssistantSnapshots(deps.dataDir,this.store);
    this.dossier=new (require('./dossier').AssistantDossier)(deps.dataDir);
    this.liveHistory=new (require('./final-readers').AssistantFinalReaders)(deps);
    this.continuity=new (require('./continuity').AssistantContinuity)(path.join(deps.dataDir,'assistant'));
    this.watches=new AssistantWatches(this.store,{getSession:id=>this.sessionMetadata(id),getOpenSession:id=>this.deps.getSession(id)?this.sessionMetadata(id):null,readFinal:(meta,options)=>this.liveHistory.read(meta,options),onNotification:notice=>this.deps.onAssistantNotification?.(notice)});
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
  overview() {
    const sessionId=this.store.get('sessionId'),session=sessionId?this.deps.getSession(sessionId):null,lastContext=this.store.get('lastContext');
    const runtime=session?.cliRuntime||session?.nativeRuntime,issue=runtime?.connection==='disconnected'?runtime.reason||'原生后端连接中断':null;
    return{ok:true,sessionId,backendKind:this.store.get('backendKind')||'codex',profile:this.currentProfile(),backends:backends.BACKENDS,backendSessions:backends.bindings(this.store),available:!!session,submissionPending:!!this.deps.hasPendingPrompt?.(sessionId),status:session?.status||'not-created',summary:'',connectionSummary:issue?'助理后端未连接：'+issue:session?'助理会话已打开；账号可用性和执行结果以原生回执为准。':'首次启用后，助理作为独立会话运行，可选择 Hub 支持的后端并连接专属工具。',toolConfiguration:'助理专用 lean 配置，连接 Hub 助理工具；普通会话配置保持不变。',needsAttention:issue?[issue]:[],updatedAt:lastContext?.asOf||null,contextCoverage:lastContext,actions:this.store.list(),followedTasks:this.followedTasks(),watchableSessions:this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status,isOpen:s.isOpen})),...this.notifications({limit:10})};
  }
  async ensureSession() {
    if(this.creating)return this.creating;
    if(this.switching)throw new Error('助理正在切换后端，请稍候');
    // 迁移与创建放在同一个 creating 里串行，并发的就绪请求只会得到同一个助理。
    this.creating=(async()=>{
      if(this.store.get('assistantDefaultsVersion')!==2){const migrated=await this.migrateDefaults();if(migrated)return migrated;}
      return this._ensureSession(this.activeKind());
    })();
    try{return await this.creating;}finally{this.creating=null;}
  }
  activeKind(){return this.store.get('backendKind')||profiles.ASSISTANT_DEFAULT_KIND;}
  // 2026-10-03：助理默认改为快速档（Sonnet 5.5 · 低思考）。旧数据只迁移一次，之后完全按用户选择。
  // 老用户走正规的后端切换：助理忙时推迟到下次空闲；切换失败就留在原后端并不再重试。
  async migrateDefaults(){
    const kind=profiles.ASSISTANT_DEFAULT_KIND,previous=this.store.get('backendKind'),currentId=this.store.get('sessionId');
    const markProfile=()=>{this.store.set('profile:'+kind,profiles.ASSISTANT_DEFAULTS[kind]);this.store.set('profilePending:'+kind,true);};
    if(!currentId||previous===kind||!previous){markProfile();this.store.set('backendKind',kind);this.store.set('assistantDefaultsVersion',2);return null;}
    const current=this.deps.getSession(currentId);
    if(current&&(require('../session-runtime-truth').sessionRuntimeIsActive(current)||['running','waiting'].includes(current.status)||this.deps.hasPendingPrompt?.(currentId)))return null;
    const before={profile:this.store.get('profile:'+kind),pending:!!this.store.get('profilePending:'+kind)};
    markProfile();this.store.set('assistantDefaultsVersion',2);
    try{const result=await this.switchUnguarded(kind);if(result.ok)return result;}catch(error){console.warn('[assistant] default migration kept',previous,error.message);}
    this.store.set('profile:'+kind,before.profile);this.store.set('profilePending:'+kind,before.pending);
    return null;
  }
  currentProfile(){
    const kind=this.activeKind();
    const id=backends.bindings(this.store)[kind],live=id?this.deps.getSession(id):null,saved=this.store.get('profile:'+kind)||profiles.ASSISTANT_DEFAULTS[kind]||{};
    const {sessionModelId}=require('../session-capabilities');
    const pending=!!this.store.get('profilePending:'+kind);
    const model=(!pending&&live&&sessionModelId(live))||saved.model||sessionModelId(live)||null;
    return{...profiles.describe(kind,model,(!pending&&live?.effort)||saved.effort||null),pending};
  }
  // 切换助理的后端、模型或思考深度。设置先保存；助理空闲时立即按新模型重启原会话（保留历史），忙时等下一次就绪再生效。
  async setProfile({kind,model,effort}={}){
    backends.backendKind(kind);
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const picked=profiles.pick(kind,{model,effort},{...defaults,...(profiles.ASSISTANT_DEFAULTS[kind]||{})});
    this.store.set('assistantDefaultsVersion',2); // 用户亲自选择后不再做默认迁移
    const previous={profile:this.store.get('profile:'+kind),pending:!!this.store.get('profilePending:'+kind)};
    const restore=()=>{this.store.set('profile:'+kind,previous.profile);this.store.set('profilePending:'+kind,previous.pending);};
    this.store.set('profile:'+kind,picked);this.store.set('profilePending:'+kind,true);this.profileError=null;
    // 换后端失败（例如助理正在回答）时撤回本次设置，避免之后悄悄生效。
    let result;try{result=kind!==this.store.get('backendKind')?await this.switchBackend({kind}):await this.ensureSession();}catch(error){restore();throw error;}
    if(!result.ok){restore();return result;}
    if(this.profileError){const error=this.profileError;this.profileError=null;return{ok:false,error,profile:this.currentProfile()};}
    return{ok:true,profile:this.currentProfile()};
  }
  // 手机端选择面板的数据：当前助理设置 + 各后端可选型号与深度（手机不内置型号表）。
  async phoneProfile(){
    const defaults={};for(const kind of backends.BACKENDS)defaults[kind]=await this.deps.getDefaults?.(kind)||{};
    return{current:this.currentProfile(),kinds:profiles.phoneCatalog(backends.BACKENDS,kind=>defaults[kind])};
  }
  async applyProfile(kind,id){
    if(!this.store.get('profilePending:'+kind))return;
    const want=this.store.get('profile:'+kind),session=this.deps.getSession(id);
    if(!want||!session)return;
    const {sessionModelId}=require('../session-capabilities');
    if(sessionModelId(session)===want.model&&(session.effort||null)===(want.effort||null)){this.store.set('profilePending:'+kind,false);return;}
    const busy=require('../session-runtime-truth').sessionRuntimeIsActive(session)||['running','waiting'].includes(session.status)||this.deps.hasPendingPrompt?.(id);
    if(busy||!this.deps.restartSession){console.log('[assistant] profile deferred',kind,id,JSON.stringify({status:session.status,runtimeActive:require('../session-runtime-truth').sessionRuntimeIsActive(session),pendingPrompt:!!this.deps.hasPendingPrompt?.(id),cliRuntime:session.cliRuntime?.state,restart:!!this.deps.restartSession}));return;}
    console.log('[assistant] profile restart',kind,id,sessionModelId(session),'->',want.model,want.effort);
    const defaults=await this.deps.getDefaults?.(kind)||{};
    const opts=profiles.withModel(kind,{...defaults,model:sessionModelId(session)},want);
    const result=await this.deps.restartSession(id,{model:want.model,effort:want.effort||null,...(typeof opts.contextMax==='number'?{contextMax:opts.contextMax}:{})});
    // 重启失败不能卡住后续消息：记录原因、把设置还原为实际在跑的型号，由 setProfile 如实回报。
    if(!result||result.ok===false){
      this.store.set('profile:'+kind,{model:sessionModelId(session),effort:session.effort||null});
      this.profileError='助理按新模型重启失败：'+(result?.message||'未知原因')+'；原会话和历史已保留';
    }
    this.store.set('profilePending:'+kind,false);
  }
  async switchBackend({kind}={}) {
    backends.backendKind(kind);
    if(this.switching||this.creating)throw new Error('助理正在连接或切换，请稍候');
    return this.switchUnguarded(kind);
  }
  async switchUnguarded(kind){
    const current=this.deps.getSession(this.store.get('sessionId'));
    if(current&&this.deps.hasPendingPrompt?.(current.id))throw new Error('助理上一条消息的提交仍在核对，请稍候切换；原会话和草稿已保留');
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
      await this.connectBridge();backends.activate(this.store,kind,id);
      await this.applyProfile(kind,id);
      return{ok:true,sessionId:id,backendKind:kind,session:this.deps.getSession(id)||session};
    };
    if(old){const session=this.deps.getSession(old);if(session)return finish(session,old);
      // A reserved launch can have succeeded even when its receipt was lost.
      if(this.deps.resumeSession){const want=this.store.get('profilePending:'+kind)&&this.store.get('profile:'+kind);const session=await this.deps.resumeSession(old,this.getLaunchOptions(kind,old),want?{model:want.model,effort:want.effort||null}:undefined);if(session)return finish(session,old);}
      const pending=(this.store.get('backendCreation:'+kind)||this.store.get('assistantCreation'))?.state==='reserved';
      return{ok:false,sessionId:old,needsReconciliation:pending,error:pending?'上次助理创建结果未确认；已保留原编号，需核对该实体后恢复。':'助理原会话未打开，请从历史恢复该会话。'};
    }
    const hubDefaults=await this.deps.getDefaults?.(kind)||{};
    const defaults=profiles.withModel(kind,hubDefaults,profiles.assistantProfile(kind,this.store.get('profile:'+kind),hubDefaults));
    const id=randomUUID();backends.reserve(this.store,kind,id);
    await this.connectBridge();
    this.store.set('profilePending:'+kind,false);
    const session=await this.deps.createSession(kind,{...defaults,id,title:'AI Hub 助理 · '+backends.getKindLabel(kind),name:'AI Hub 助理',purpose:'hub-assistant',...this.getLaunchOptions(kind,id)});
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
    const text=buildBootstrapPrompt(request.text,{...manifest,clientSubmissionId:id},this.sessions().length,active?.kind||'codex',{inputMode:this.inputModes.get(id)||'text'});
    this.store.set('lastContext',{asOf:context.asOf,selectedChars:context.selectedChars,sources:context.sources.length,truncated:context.truncated,
      workbenchPath:context.workbench.markdownPath,workbenchRevision:context.workbench.revision,openedSessions:context.workbench.openedCount,activeSessions:context.workbench.activeCount,allActiveSessionsIncluded:true,contextMode:context.workbench.mode,
      requestToken:this.currentRequest.token,packetHash:manifest.packetHash,snapshotRead:false,snapshotReadAt:null,bootstrapChars:text.length,
      inputTransportNote:text.length>=2048?'用户原话较长，仍可能触发普通 Codex 编辑器输入通道':'短请求正文；完整资料通过本轮工具读取'});
    return{...request,text,clientSubmissionId:id};
  }
  async send(request) {
    if(typeof request.text!=='string'||!request.text.trim()||request.text.length>50000)throw new Error('请输入有效任务');
    const ensured=await this.ensureSession();if(!ensured.ok)return ensured;
    const requestId=request.requestId||randomUUID();
    if(request.inputMode==='voice')this.inputModes.set(requestId,'voice');
    let receipt;try{receipt=await this.deps.sendPrompt(ensured.sessionId,request.text,requestId);}finally{this.inputModes.delete(requestId);}
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
      const implicitCurrent=hasCaller&&callerSessionId===this.currentRequest?.sessionId&&Object.keys(args).length===0;
      const requestToken=args.requestToken||(implicitCurrent?this.currentRequest.token:null);
      if(requestToken){
        if(requestToken!==this.currentRequest?.token)throw new Error('资料请求不属于当前用户回合');
        const response=this.snapshots.read(requestToken),last=this.store.get('lastContext');
        this.dossier.noteServed(response.packet.workbench);
        if(last?.requestToken===requestToken)this.store.set('lastContext',{...last,snapshotRead:true,snapshotReadAt:response.snapshotReceipt.readAt,snapshotReadReceipt:response.snapshotReceipt});
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
    const action={type:name==='create_session'?'create':'send',targetSessionId:args.sessionId,title:args.title,text:args.text,
      ...(name==='create_session'?Object.fromEntries(['tier','kind','model','effort'].filter(key=>args[key]).map(key=>[key,args[key]])):{})};
    if(!manager)requireAuthorizedTarget(current,action,this.sessions());
    // 型号或深度写错时在占用本轮名额前报错，助理改正后可在同一轮重试。
    if(action.type==='create'){const kind=profiles.taskKind(action);backends.backendKind(kind);profiles.resolveTask(action,await this.deps.getDefaults?.(kind)||{});}
    if(typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    if(this.deps.authorizeAction&&!await this.deps.authorizeAction(action,current))throw new Error('目标不在本轮授权范围内');
    const requestId=bindOperation(this.store,current,args.operationKey,action);
    // 助理新建的任务总是关注：路由的承诺是把结果带回来（手机与助理页都会收到提醒）。
    const followed=reminderIntent(current.text)||action.type==='create';
    if(followed&&action.type==='send')this.followTask({sessionId:action.targetSessionId});
    const result=await this.execute({...action,requestId},{followNewReply:followed});
    return followed?{...result,followed:true,notificationMethod:'Hub监视原生最终回复并在助理页通知'}:result;
  }
  async execute(action,{followNewReply=false}={}) {
    if(!['send','create'].includes(action.type)||typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    const {requestId,...payload}=action;
    if(this.store.has(requestId)){
      const record=this.store.begin(requestId,payload);
      return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    }
    let resumeMeta=null,route=null;
    if(action.type==='create'){
      // 档位解析失败（型号不存在、深度不支持）在落账前报错，助理可以换个说法重试。
      const kind=profiles.taskKind(action);backends.backendKind(kind);
      route=profiles.resolveTask(action,await this.deps.getDefaults?.(kind)||{});
    }
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
        const desiredId=randomUUID();this.store.set('reserved:'+requestId,desiredId);
        // 助理新建的是后台会话，没有界面终端回应光标查询；与群聊成员一样关闭 ConPTY 继承光标，否则 Claude 会卡在启动。
        const session=await this.deps.createSession(route.kind,{...route.opts,id:desiredId,title:String(action.title||'助理委托任务').slice(0,100),noInheritCursor:true});sessionId=session.id;
        // Follow before submission: a fast target can reply before the manager
        // receives create_session's result and gets a chance to call watch.
        if(followNewReply)this.followTask({sessionId});
      }
      const wireText=require('./delegated-prompt').encodeDelegatedPrompt(action.text,this.deps.getSession(sessionId)?.kind);
      const receipt=await this.deps.sendPrompt(sessionId,wireText,requestId);
      const confirmed=receipt?.ok===true&&receipt?.receipt?.status==='confirmed'&&!receipt.notSent&&!receipt.contentMismatch;
      const result={sessionId,receipt,...(route?{route:{tier:route.tier,kind:route.kind,model:route.model,effort:route.effort,label:route.label}}:{})};this.store.finish(requestId,confirmed?'acknowledged':'unknown',result);
      return{ok:confirmed,state:confirmed?'acknowledged':'unknown',...result};
    } catch(error) {this.store.finish(requestId,'unknown',{sessionId,error:error.message});return{ok:false,state:'unknown',sessionId,error:error.message};}
  }
  close(){clearInterval(this.watchTimer);this.bridge.close();this.store.close();}
}
module.exports={AssistantService};
