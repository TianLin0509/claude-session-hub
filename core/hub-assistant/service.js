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
const { requireAuthorizedTarget,bindOperation }=require('./action-policy');
class AssistantService {
  constructor(deps) {
    this.deps=deps; this.store=new AssistantStore(path.join(deps.dataDir,'assistant'));
    this.history=new AssistantHistory(deps.historyDatabasePath||path.join(deps.dataDir,'cache','session-search-v3.sqlite'));
    this.bridge=new AssistantBridge(request=>this.invokeTool(request)); this.currentRequest=null;
    this.endpointFile=path.join(deps.dataDir,'assistant','bridge-endpoint.json');
    this.snapshots=new AssistantSnapshots(deps.dataDir,this.store);
  }
  sessions() {return (this.deps.getAllSessions?.()||[]).filter(s=>s.id!==this.store.get('sessionId'));}
  overview() {const sessionId=this.store.get('sessionId'),session=sessionId?this.deps.getSession(sessionId):null,lastContext=this.store.get('lastContext');return{ok:true,sessionId,available:!!session,status:session?.status||'not-created',summary:'',connectionSummary:session?'助理已连接；可以问进展、定位会话并转交任务。':'首次启用后，助理会作为一个独立 Codex 会话运行，并连接 Hub 助理工具。',toolConfiguration:'助理专用 lean 配置，连接 Hub 助理工具；普通会话配置保持不变。',needsAttention:[],updatedAt:lastContext?.asOf||null,contextCoverage:lastContext,actions:this.store.list()};}
  async ensureSession() {
    if(this.creating)return this.creating;
    this.creating=this._ensureSession();try{return await this.creating;}finally{this.creating=null;}
  }
  async _ensureSession() {
    const old=this.store.get('sessionId');
    if(old){const session=this.deps.getSession(old);if(session){await this.connectBridge();this.store.confirmAssistant(old);return{ok:true,sessionId:old,session};}
      // Never silently replace a historical assistant with a fresh thread.
      if(this.deps.resumeSession){const session=await this.deps.resumeSession(old,{purpose:'hub-assistant',mcpProfile:'lean',codexMcpEntries:[this.getMcpEntry()]});if(session){await this.connectBridge();this.store.confirmAssistant(old);return{ok:true,sessionId:old,session};}}
      const pending=this.store.get('assistantCreation')?.state==='reserved';
      return{ok:false,sessionId:old,needsReconciliation:pending,error:pending?'上次助理创建结果未确认；已保留原编号，需核对该实体后恢复。':'助理原会话未打开，请从历史恢复该会话。'};
    }
    const defaults=await this.deps.getDefaults?.('codex')||{};
    const id=randomUUID();
    // Reserve identity durably before launching anything. If launch succeeds
    // but its response is lost, retries reconcile this identity only.
    this.store.reserveAssistant(id);
    await this.connectBridge();
    const entry=this.getMcpEntry();
    const session=await this.deps.createSession('codex',{...defaults,id,title:'AI Hub 助理',name:'AI Hub 助理',purpose:'hub-assistant',mcpProfile:'lean',codexMcpEntries:[entry]});
    if(session.id!==id)throw new Error('助理返回的会话编号与预留编号不一致，需核对创建结果');
    this.store.confirmAssistant(id);return{ok:true,sessionId:id,session};
  }
  async connectBridge(){await this.bridge.start();const temporary=this.endpointFile+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify({url:this.bridge.url,token:this.bridge.secret}),{mode:0o600});fs.renameSync(temporary,this.endpointFile);}
  getMcpEntry(){return{name:'hub_assistant',command:this.deps.nodeExecutable||'node',args:[path.resolve(__dirname,'../../scripts/assistant-mcp.js')],env:{HUB_ASSISTANT_ENDPOINT_FILE:this.endpointFile},toolApprovalModes:{list_sessions:'approve',history_context:'approve',send_session:'approve',create_session:'approve'},toolOutputTokenLimits:{history_context:50000}};}
  context(request={}) {
    const sessionId=this.store.get('sessionId'),session=this.deps.getSession(sessionId);
    const totalBudget=Math.max(2000,Math.min(48000,Number(request.maxChars)||24000));
    const naturalBudget=Math.floor(totalBudget*.75);
    const natural=this.history.context({...request,maxChars:naturalBudget,excludeSessionId:sessionId,excludeNativeSessionId:session?.codexSid});
    const groups=readGroupHistory({dataDir:this.deps.dataDir,since:request.query?undefined:(natural.since??request.from??((request.now||Date.now())-(request.hours||3)*3600000)),until:natural.until||natural.asOf,
      query:request.query||'',maxChars:totalBudget-naturalBudget,maxFiles:30,meetings:this.deps.getMeetings?.()});
    const {sources:groupSources,...groupCoverage}=groups;
    const groupChars=groupSources.reduce((n,s)=>n+s.text.length,0);
    return {...natural,available:natural.available||groups.sources.length>0,sources:[...natural.sources,...groups.sources],
      selectedChars:(natural.selectedChars||0)+groupChars,groupSelectedChars:groupChars,
      truncated:natural.truncated||groups.truncated,coverage:{singleSessions:natural.coverage,groups:groups.coverage,
        groupTimeMeaning:'群聊材料的文件修改时间只证明文件被观察到变化，不证明任务在该时刻完成。'},groupFileCoverage:groupCoverage};
  }
  preparePrompt(request) {
    if(!request||String(request.text||'').trimStart().startsWith('/'))return request;
    const envelope=require('../assistant-context-display').assistantContextDisplay(request.text,'hub-assistant');
    if(envelope)request={...request,text:envelope.userText};
    const active=this.deps.getSession(this.store.get('sessionId'));
    if(active&&(require('../session-runtime-truth').sessionRuntimeIsActive(active)||active.status==='running'))throw new Error('助理正在处理上一条请求，请等本轮结束后发送；草稿已保留');
    const context=this.context({...resolveTimeRange(request.text,{hours:request.hours,timeZone:this.deps.timeZone}),query:request.historyQuery||''});
    const id=request.clientSubmissionId||request.requestId||randomUUID();
    this.currentRequest={id,text:request.text,token:randomUUID(),createdAt:Date.now()};
    const manifest=this.snapshots.save({requestId:id,requestToken:this.currentRequest.token,packet:context});
    const text=buildBootstrapPrompt(request.text,manifest,this.sessions().length);
    this.store.set('lastContext',{asOf:context.asOf,selectedChars:context.selectedChars,sources:context.sources.length,truncated:context.truncated,
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
  async invokeTool({name,arguments:args={}}) {
    if(name==='list_sessions')return this.sessions().map(s=>({id:s.id,title:s.title||s.name,kind:s.kind,status:s.status}));
    if(name==='history_context'){
      if(args.requestToken){
        if(args.requestToken!==this.currentRequest?.token)throw new Error('资料请求不属于当前用户回合');
        const response=this.snapshots.read(args.requestToken),last=this.store.get('lastContext');
        if(last?.requestToken===args.requestToken)this.store.set('lastContext',{...last,snapshotRead:true,snapshotReadAt:response.snapshotReceipt.readAt,snapshotReadReceipt:response.snapshotReceipt});
        return response;
      }
      return this.context(args);
    }
    if(!['send_session','create_session'].includes(name))throw new Error('未知工具');
    const current=this.currentRequest;
    if(!current||Date.now()-current.createdAt>30*60000)throw new Error('本轮用户委托已过期，请重新发送任务');
    if(args.requestToken!==current.token)throw new Error('工具调用不属于当前用户委托');
    const action={type:name==='create_session'?'create':'send',targetSessionId:args.sessionId,title:args.title,text:args.text};
    requireAuthorizedTarget(current,action,this.sessions());
    if(typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    if(this.deps.authorizeAction&&!await this.deps.authorizeAction(action,current))throw new Error('目标不在本轮授权范围内');
    const requestId=bindOperation(this.store,current,args.operationKey,action);
    return this.execute({...action,requestId});
  }
  async execute(action) {
    if(!['send','create'].includes(action.type)||typeof action.text!=='string'||!action.text.trim()||action.text.length>50000)throw new Error('任务无效');
    const {requestId,...payload}=action;
    if(this.store.has(requestId)){
      const record=this.store.begin(requestId,payload);
      return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    }
    if(action.type==='send'){
      if(action.targetSessionId===this.store.get('sessionId'))throw new Error('助理不能向自身循环派发');
      const target=this.deps.getSession(action.targetSessionId);if(!target)throw new Error('目标会话未打开；未自动创建替代会话');
      const truth=require('../session-runtime-truth');
      if(truth.sessionRuntimeIsActive(target)||['running','waiting'].includes(target.status))throw new Error('目标会话正在运行或等待输入，请先明确处理当前任务');
    }
    const record=this.store.begin(requestId,payload);
    if(record.duplicate)return{ok:record.state==='acknowledged',duplicate:true,state:record.state,result:record.result,needsReconciliation:record.state==='dispatching'||record.state==='unknown'};
    let sessionId=action.targetSessionId;
    try {
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
  close(){this.bridge.close();this.store.close();}
}
module.exports={AssistantService};
