'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ClaudeStreamClient}=require('../main/claude-stream-client');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const {ClaudeNativeSession}=require('../core/claude-native-session');
const {NATIVE_CONFIRMATION_MS}=require('../core/native-confirmation-policy');
const {classifyProviderFailure}=require('../core/groupchat-attempt-protocol');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function modelSession(client) {
  const session=Object.create(ClaudeNativeSession.prototype);
  Object.assign(session,{client,start:async()=>{},queue:[],activities:{pending:()=>[]},tasks:new Map(),options:{launchArgs:[]},
    runtime:{epoch:1,actualModel:'old'},update(patch){Object.assign(this.runtime,patch);},emit(){}});
  return session;
}
function writable(client) {
  const written=[];
  client.proc={stdin:{destroyed:false,write(bytes,encoding,callback){written.push(JSON.parse(bytes));callback();}}};
  return written;
}
test('expired unsent Claude control never writes later or changes model',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const client=new ClaudeStreamClient(),written=writable(client),session=modelSession(client);
  let release;client.writeQueue=new Promise(resolve=>{release=resolve;});
  const result=session.setModel('new').catch(error=>error);await flush();
  t.mock.timers.tick(NATIVE_CONFIRMATION_MS+1);
  const error=await result;assert.equal(error.notSent,true);assert.equal(error.uncertain,false);
  release();await flush();assert.equal(written.length,0);assert.equal(session.runtime.actualModel,'old');
  assert.equal(session.configurationChange,null);assert.equal(client.pending.size,0);
});
for(const setting of ['model','mode','fast']) test('late Claude '+setting+' control reconciles exact request without replay',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const client=new ClaudeStreamClient(),written=writable(client),session=modelSession(client);
  const result=(setting==='model'?session.setModel('new'):setting==='mode'?session.setPermissionMode('plan'):session.setFastMode(true)).catch(error=>error);
  await flush();t.mock.timers.tick(NATIVE_CONFIRMATION_MS+1);
  assert.equal((await result).uncertain,true);assert.equal(session.runtime.configurationChange.status,'unknown');
  assert.ok(session.configurationChange);await assert.rejects(session.setModel('other'));
  await assert.rejects(session.submit('do not run with unknown config'),/设置结果待核对/);
  const confirmation=session.configurationChange;
  client.receive({type:'control_response',response:{subtype:'success',request_id:'foreign',response:{mode:'other'}}});
  assert.ok(session.configurationChange);
  client.receive({type:'control_response',response:{subtype:'success',request_id:written[0].request_id,response:{mode:'plan'}}});
  await confirmation;
  assert.equal(session.configurationChange,null);assert.equal(session.runtime.configurationChange,null);
  assert.equal(written.length,1);
  assert.equal(setting==='model'?session.runtime.actualModel:setting==='mode'?session.runtime.permissionMode:session.runtime.fastMode,
    setting==='model'?'new':setting==='mode'?'plan':true);
});
test('late setting rejection and old epoch never apply requested model',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const stale of [false,true]) {
    const client=new ClaudeStreamClient(),written=writable(client),session=modelSession(client);
    const response=session.setModel('new').catch(error=>error);await flush();t.mock.timers.tick(NATIVE_CONFIRMATION_MS+1);await response;
    const pending=session.configurationChange;if(stale)session.runtime.epoch++;
    client.receive({type:'control_response',response:{subtype:stale?'success':'error',request_id:written[0].request_id,error:'rejected',response:{}}});
    await assert.rejects(pending);assert.equal(session.runtime.actualModel,'old');assert.equal(session.configurationChange,null);
  }
});
test('disconnect rejects retained control confirmation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const client=new ClaudeStreamClient();writable(client);const session=modelSession(client);
  const response=session.setModel('new').catch(error=>error);await flush();t.mock.timers.tick(NATIVE_CONFIRMATION_MS+1);await response;
  const pending=session.configurationChange;client.fail(new Error('real disconnect'));
  await assert.rejects(pending,/real disconnect/);assert.equal(client.pending.size,0);assert.equal(session.configurationChange,null);
});
test('expired queued Codex request never writes after backlog drains',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const client=new CodexAppServerClient(),written=writable(client);
  let release;client.writeTail=new Promise(resolve=>{release=resolve;});
  const response=client.request('turn/start',{threadId:'thread'}).catch(error=>error);
  t.mock.timers.tick(NATIVE_CONFIRMATION_MS+1);const error=await response;
  assert.equal(error.notSent,true);assert.equal(error.uncertain,false);
  release();await flush();assert.equal(written.length,0);assert.equal(client.closed,false);
});
test('structured unknown-delivery evidence takes precedence over network wording',()=>{
  for(const input of [{uncertain:true,message:'ECONNRESET'},{code:'CLAUDE_SUBMISSION_UNKNOWN'},
    {message:'ACP 未在期限内返回执行证据；消息结果待核对'}]) {
    const failure=classifyProviderFailure({...input,force:true});
    assert.equal(failure.category,'reconciliation');assert.equal(failure.autoRetry,false);
  }
  assert.equal(classifyProviderFailure({fromAssistantText:true,text:'Discuss CLAUDE_SUBMISSION_UNKNOWN',uncertain:true}),null);
});
for(const provider of ['claude','codex','acp'])test('group stop routes '+provider+' through one native interrupt',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {createGroupChatDispatcher}=require('../main/groupchat/dispatcher');let count=0;const keys=[];
  const native={interrupt:async()=>{count++;},emit(){}};
  const dispatcher=createGroupChatDispatcher({sessionManager:{getNativeClaude:()=>provider==='claude'?native:null,
    getNativeSession:()=>provider!=='claude'?native:null,getGroupChatReady:()=>true,
    getSession:()=>({id:'seat',kind:provider}),writeToSession:(sid,key)=>keys.push(key)},
    meetingManager:{getMeeting:()=>({id:'m',groupChat:true,subSessions:['seat']})},
    groupchat:{getOrchestrator:()=>({state:{currentTurn:1,currentMode:'idle',revision:0,messages:[]}})},
    sendToRenderer(){},getHubDataDir:()=>__dirname,logger:{log(){},warn(){}}});
  const result=dispatcher.interruptMeetingTurn('m',{targetSids:['seat']});
  t.mock.timers.tick(1000);assert.equal(result.ok,true);assert.equal(count,1);assert.deepEqual(keys,[]);
});
test('a queued group supplement is not presented as immediate delivery or dispatched again',async()=>{
  const {registerGroupchatSupplementIpc}=require('../main/ipc/groupchat-supplement-handlers');
  const handlers=new Map(),marked=[],events=[];
  const orch={state:{},appendUserSupplement:()=>({seq:1}),markUserSupplementsDelivered:(...args)=>marked.push(args)};
  registerGroupchatSupplementIpc({handle:(name,fn)=>handlers.set(name,fn)}, {
    meetingManager:{getMeeting:()=>({groupChat:true,subSessions:['claude','codex','dormant']})},
    groupchat:{getOrchestrator:()=>orch},getHubDataDir:()=>__dirname,
    getActiveWatchers:()=>new Map([['claude',{}],['codex',{}]]),
    sessionManager:{getSession:sid=>({kind:sid})},
    groupChatWatcher:{sendToPty:async sid=>({ok:true,sendStatus:sid==='claude'?'queued':'ok'})},
    sendToRenderer:(...args)=>events.push(args),
  });
  const result=await handlers.get('groupchat:user-supplement')(null,{meetingId:'m',text:'same instruction'});
  assert.deepEqual(result.deliveredNow,['codex']);assert.deepEqual(result.queuedSids,['claude']);assert.deepEqual(result.pendingSids,['dormant']);
  assert.equal(marked.length,2);assert.deepEqual(events.at(-1)[1].queuedSids,['claude']);
});
test('Claude stderr reaches the same paged backstage diagnostic store',async t=>{
  const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-diagnostics-'));
  const session=new ClaudeNativeSession({cwd:root,executable:process.execPath,
    commandArgs:[path.join(__dirname,'fixtures/claude-stream.js')],env:{...process.env,CLAUDE_CONFIG_DIR:root}});
  t.after(()=>session.close());await session.start();
  session.client.emit('diagnostic',{type:'stderr',message:'STDERR_ORIGINAL 原始诊断'});
  const page=session.readBackstage();
  assert.match(JSON.stringify(page),/STDERR_ORIGINAL 原始诊断/);
  assert.ok(page.entries.some(entry=>entry.title==='Claude stderr'));
});
