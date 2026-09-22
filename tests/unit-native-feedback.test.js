'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {recordNativeContent,nativeContentAge,promptReceipt,hasNativeReceipt}=require('../core/native-feedback');
const {claudeTranscriptTurns}=require('../core/claude-native-transcript');
const {ClaudeNativeSession,digest}=require('../core/claude-native-session');
const {refreshDelay}=require('../renderer/native-card-refresh');
const {compactCodexTools,toolResult}=require('../core/codex-tool-details');
const {CodexNativeSession}=require('../core/codex-native-session');
const {createHubFeedbackHealth}=require('../renderer/hub-feedback-health');
const {deriveSessionRuntimeStatus}=require('../renderer/session-runtime-status');
for(const backend of ['codex-app-server','claude-stream-json']) {
  const session=()=>({runtimeBackend:backend,nativeRuntime:{epoch:2,connection:'connected',state:'running',threadId:'t',turnId:'turn',providerSessionId:'c',userMessageId:'u'}});
  const event={epoch:2,threadId:'t',turnId:'turn',providerSessionId:'c',userMessageId:'u'};
  test(backend+' content clock rejects old identity without changing execution truth',()=>{
    const s=session(),original=JSON.stringify(s.nativeRuntime);
    assert(recordNativeContent(s,event,1000));
    assert.match(nativeContentAge(s,1000),/刚收到/);
    assert.match(nativeContentAge(s,46000),/45 秒没有新输出/);
    assert.equal(recordNativeContent(s,{...event,epoch:1},47000),false);
    assert.equal(recordNativeContent(s,{...event,turnId:'old',userMessageId:'old'},47000),false);
    assert.equal(JSON.stringify(s.nativeRuntime),original);
    s.currentCardActivity={label:'node '+ 'very-long-path/'.repeat(40)};
    assert.match(deriveSessionRuntimeStatus(s,{now:46000}).visibleDetail,/45 秒没有新输出/);
    s.nativeRuntime.connection='disconnected';assert.equal(nativeContentAge(s,48000),'');
    s.nativeRuntime.connection='connected';s.nativeRuntime.state='waiting';assert.equal(nativeContentAge(s,48000),'');
    s.nativeRuntime.state='running';s.nativeRuntime.epoch++;assert.equal(nativeContentAge(s,48000),'');
  });
  test(backend+' distinguishes local input, exact receipt, queue and uncertainty',()=>{
    const s=session();s.nativeRuntime.submission={id:'one',status:'accepted'};
    assert.equal(promptReceipt(s,'one'),'引擎已收到');
    assert.match(promptReceipt(s,'two'),/Hub 已接收/);
    s.nativeRuntime.queued=[{submissionId:'two'}];assert.match(promptReceipt(s,'two'),/已排队/);
    s.nativeRuntime.submission={clientSubmissionId:'one',sendStatus:'unknown'};
    assert.equal(promptReceipt(s,'one'),'提交结果未确认');
    assert.match(promptReceipt(s,'one',{authoritative:true}),/执行结果未确认/);
  });
}
test('Claude local transcript records do not claim engine receipt before acknowledgement, including historical cards',()=>{
  const session={runtimeBackend:'claude-stream-json',nativeRuntime:{submission:{submissionId:'newer',sendStatus:'accepted'}}};
  for(const [status,accepted,expected] of [
    ['queued',false,'已排队 · 等待发送'],['submitting',false,'Hub 已接收 · 正在提交'],
    ['unknown',false,'提交结果未确认'],['rejected',false,'提交失败'],['interrupted',false,'提交已中断'],
    ['accepted',true,'引擎已收到'],['unknown',true,'引擎已收到 · 执行结果未确认']]){
    const [turn]=claudeTranscriptTurns([{submissionId:'older',userMessageId:'u',text:'same input',status,accepted}]);
    assert.equal(hasNativeReceipt(turn),accepted);
    assert.equal(promptReceipt(session,turn.clientSubmissionId,{authoritative:hasNativeReceipt(turn),deliveryStatus:turn.deliveryStatus}),expected);
  }
  assert.equal(hasNativeReceipt({source:'claude-stream-json'}),false);
});

test('reopening a cancelled unsent Claude submission preserves the explicit lack of engine acknowledgement',()=>{
  const id='11111111-2222-4333-8444-555555555555',content=[{type:'text',text:'cancelled before send'}];
  const promptFingerprint=digest(content);
  const native=new ClaudeNativeSession({sessionId:id,restoredRecords:[{submissionId:'cancelled',userMessageId:'u',
    providerSessionId:id,content,text:'cancelled before send',promptFingerprint,status:'interrupted',accepted:false}]});
  const [turn]=claudeTranscriptTurns([...native.records.values()]);
  assert.equal(hasNativeReceipt(turn),false);
  assert.equal(promptReceipt({runtimeBackend:'claude-stream-json'},turn.clientSubmissionId,
    {authoritative:hasNativeReceipt(turn),deliveryStatus:turn.deliveryStatus}),'提交已中断');
});

test('native cadence has backpressure while PTY history keeps its old cadence',()=>{
  const s={runtimeBackend:'codex-app-server'},state={lastReloadAt:1000,lastDurationMs:20};
  assert.equal(refreshDelay(s,state,1000),100);
  assert.equal(refreshDelay(s,state,2000),16);
  assert.equal(refreshDelay(s,{...state,lastDurationMs:300},1000),600);
  assert.equal(refreshDelay({runtimeBackend:'pty'},state,1000),1200);
});
test('live command preview carries latest tail but detail keeps the complete received output',()=>{
  const output='HEAD'+'.'.repeat(1024*1024)+'LATEST';
  const cards=[{providerTurnId:'turn',toolCalls:[{id:'cmd',input:{id:'cmd',type:'commandExecution',status:'inProgress',command:'test'},output}]}];
  const compact=compactCodexTools(cards,{hubSessionId:'hub',threadId:'t'});
  assert(compact[0].toolCalls[0].output.endsWith('LATEST'));
  assert.equal(compact[0].toolCalls[0].output.length,2048);
  assert(JSON.stringify(compact).length<4096);
  assert.equal(toolResult(cards,{threadId:'t',turnId:'turn',itemId:'cmd'},'t'),output);
});
test('command output updates current card, not a stale turn; runtime state stays authoritative',()=>{
  const s=new CodexNativeSession({id:'unit-feedback'});
  s.threadId='t';s.runtime={...s.runtime,threadId:'t',turnId:'turn',state:'running'};
  s.backstage.notification=()=>{};s.terminalPresentation.toolDelta=()=>{};
  s.items.set('cmd',{id:'cmd',type:'commandExecution',status:'inProgress'});
  let emitted=0;s.on('items',()=>emitted++);
  const event={method:'item/commandExecution/outputDelta',params:{threadId:'t',turnId:'turn',itemId:'cmd',delta:'one\n'}};
  s.notification(event);s.notification({...event,params:{...event.params,turnId:'old',delta:'STALE'}});
  assert.equal(emitted,1);assert.equal(s.items.get('cmd').aggregatedOutput,'one\n');assert.equal(s.runtime.state,'running');
});

test('local health never claims model health and cannot overlap a stuck ping',async()=>{
  let at=1000,active=true,resolve,calls=0;
  const timers=[];
  const health=createHubFeedbackHealth({now:()=>at,enabled:()=>active,schedule:fn=>{timers.push(fn);return fn;},cancel:()=>{},
    ping:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  health.start();assert.equal(calls,1);assert.match(health.text(),/正在检测/);
  at=5000;assert.match(health.text(),/已等待 4 秒/);assert.equal(timers.length,0,'no concurrent probe during an unresolved call');
  active=false;assert.equal(health.text(),'');active=true;
  resolve({ok:true});await new Promise(r=>setImmediate(r));
  assert.equal(health.text(),'Hub 本地有响应');assert.equal(timers.length,1);
  active=false;await timers.shift()();assert.equal(calls,1,'hidden/idle observation does not poll Main');
  health.dispose();assert.equal(health.text(),'');
});
