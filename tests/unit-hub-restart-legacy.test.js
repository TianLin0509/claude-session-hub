'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createRestartLegacyTracker,observeLegacyPrompt,waitChildExit}=require('../core/hub-restart-legacy');
test('legacy recovery uses only current binding and fresh semantic events',()=>{
  const tap=new EventEmitter(),s={id:'s',kind:'kimi',kimiSid:'one'};
  const tracker=createRestartLegacyTracker(tap,{getSession:()=>s},100);
  const event={hubSessionId:'s',submittedAt:99,signalSource:'kimi_wire_turn_prompt'};
  tap.emit('prompt-submitted',event);assert.equal(tracker.state(s),null);
  tap.emit('prompt-submitted',{...event,submittedAt:101});assert.equal(tracker.state(s),'working');
  tap.emit('turn-complete',{hubSessionId:'s',completedAt:100});assert.equal(tracker.state(s),'working');
  tap.emit('turn-complete',{hubSessionId:'s',completedAt:102,signalSource:'idle_timer_5s'});assert.equal(tracker.state(s),'unknown');
  s.kimiSid='two';assert.equal(tracker.state(s),null);
});
test('legacy receipt rejects old history, other session, wrong text and terminal guesses',async()=>{
  for(const source of ['kimi_wire_turn_prompt','gemini_user_message']){
    const tap=new EventEmitter(),receipt=observeLegacyPrompt(tap,'s','继续原任务',200);
    const event={hubSessionId:'s',submittedAt:Date.now(),signalSource:source,text:'继续原任务'};
    for(const patch of [{submittedAt:1},{hubSessionId:'other'},{text:'其他任务'},{signalSource:'terminal'}])tap.emit('prompt-submitted',{...event,...patch});
    assert.equal(receipt.confirmed,false);tap.emit('prompt-submitted',event);
    assert.equal((await receipt.promise).ok,true);assert.equal(tap.listenerCount('prompt-submitted'),0);
  }
});
test('missing acceptance times out explicitly and removes listener',async()=>{
  const tap=new EventEmitter(),receipt=observeLegacyPrompt(tap,'s','task',10);
  assert.equal((await receipt.promise).sendStatus,'unknown');assert.equal(tap.listenerCount('prompt-submitted'),0);
});
test('relaunch barrier waits for actual child exit, not requested shutdown',async()=>{
  const child=new EventEmitter();let finished=false;
  const pending=waitChildExit(child,100).then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);child.emit('exit');await pending;assert.equal(finished,true);
  await assert.rejects(waitChildExit(new EventEmitter(),10),/尚未确认退出/);
});

test('legacy resumed providers use their real CLI readiness family',async()=>{
  const watcher=require('../core/group-chat-watcher');const observed=[];
  watcher.init({sessionManager:{getSessionBuffer:()=>''},cliReadyDetector:{isReady:(_id,kind)=>{observed.push(kind);return true;}}});
  for(const kind of ['deepseek','deepseek-resume','kimi-resume','gemini-resume','deepseek-legacy-resume'])await watcher.waitCliReady('s',kind,100);
  assert.deepEqual(observed,['codex','codex','kimi','gemini','claude']);
});

test('group legacy continuation publishes a receipt only after exact transcript acceptance',async()=>{
  const watcher=require('../core/group-chat-watcher');
  for(const [kind,signalSource] of [['kimi','kimi_wire_turn_prompt'],['gemini','gemini_user_message'],['deepseek','item_completed_user_message']]){
    const tap=new EventEmitter(),writes=[];
    const sm={restartContinuationSessions:new Set(['s']),getSession:()=>({kind}),getGroupChatReady:()=>true,getSessionBuffer:()=>'',
      writeToSession:(_id,text)=>{writes.push(text);if(text==='\r')tap.emit('prompt-submitted',{hubSessionId:'s',text:'continue task',signalSource,submittedAt:Date.now()});}};
    watcher.init({sessionManager:sm,transcriptTap:tap});
    const result=await watcher.sendToPty('s','continue task',kind,{clientSubmissionId:'group-current-stage'});
    assert.equal(result.ok,true);assert.equal(result.acknowledgementSource,signalSource);
    assert.deepEqual(sm.restartContinuationReceipts.get('s'),{id:'group-current-stage',status:'accepted'});
    assert.equal(writes.filter(x=>x==='\r').length,1);assert.equal(sm.restartContinuationSessions.size,0);
  }
});
