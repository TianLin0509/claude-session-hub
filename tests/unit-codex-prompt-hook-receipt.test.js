'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const watcher=require('../core/group-chat-watcher');
const {registerPromptSubmitIpc}=require('../main/ipc/prompt-submit-handlers');
const {createCodexPtyHookHandler}=require('../main/codex-pty-hook');
const {PromptSubmissionReceipts}=require('../core/prompt-submission-receipts');

test('Codex prompt hook confirms exact submitted text before a delayed transcript and never needs a retry',async()=>{
  const manager=new EventEmitter(),tap=new EventEmitter(),handlers=new Map(),updates=[];
  const session={id:'hub',kind:'codex',agentRuntime:'pty',codexSid:'native-thread',transcriptPath:'rollout'};
  manager.getSession=id=>id===session.id?session:null;
  manager.noteAgentTurnStarted=(sessionId,event)=>manager.emit('agent-turn-started',{...event,sessionId,observedAt:event.startedAt});
  tap.bindCodexFromHook=async()=>true;tap.notePrompt=()=>{};
  const registration=registerPromptSubmitIpc({handle:(name,handler)=>handlers.set(name,handler)},{sessionManager:manager,transcriptTap:tap,sendToRenderer:(channel,payload)=>updates.push({channel,payload})});
  const hook=createCodexPtyHookHandler({sessionManager:manager,transcriptTap:tap,sendToRenderer:()=>{},readCodexRolloutMeta:()=>({id:'native-thread'}),isCodexTopLevelRolloutMeta:()=>true});
  const original=watcher.sendToPty;let submittedAt;
  watcher.sendToPty=async(sid,text,kind,options)=>{
    submittedAt=Date.now();
    await hook(session,'prompt',{claudeSessionId:'native-thread',transcriptPath:'rollout',prompt:text,turnId:'turn-a'});
    assert.equal(options.submissionReceipt.status,'confirmed','early authoritative Codex prompt hook must acknowledge the actual message');
    return{ok:true,sendStatus:'ok',enterAttempts:1,acknowledgementSource:options.submissionReceipt.acknowledgement.source};
  };
  try{
    const result=await handlers.get('session:send-prompt')(null,{sessionId:'hub',text:'本轮请求正文',clientSubmissionId:'request-a'});
    assert.equal(result.receipt.status,'confirmed');assert.equal(result.enterAttempts,1);
    assert.equal(result.receipt.acknowledgementSource,'codex-user-prompt-submit');
    tap.emit('prompt-submitted',{hubSessionId:'hub',text:'本轮请求正文',submittedAt:submittedAt+22000,turnId:'turn-a',signalSource:'item_completed_user_message'});
    assert.equal(updates.filter(x=>x.channel==='session:prompt-receipt'&&x.payload.status==='confirmed').length,1);
  }finally{watcher.sendToPty=original;registration.dispose?.();}
});

test('Codex hook still rejects wrong text, another session, old event, or lifecycle without body',()=>{
  const receipts=new PromptSubmissionReceipts(),attempt=receipts.begin('hub','request-a','exact text',1000);
  for(const event of [
    {sessionId:'hub',text:'different text',observedAt:1010},
    {sessionId:'other',text:'exact text',observedAt:1010},
    {sessionId:'hub',text:'exact text',observedAt:999},
    {sessionId:'hub',observedAt:1010},
  ])assert.equal(receipts.observe({...event,signalSource:'codex-user-prompt-submit'}),false);
  assert.equal(attempt.status,'pending');
  assert.equal(receipts.observe({sessionId:'hub',text:'exact text',observedAt:1010,signalSource:'task_started'}),false);
  assert.equal(receipts.observe({sessionId:'hub',text:'exact text',observedAt:1010,signalSource:'codex-user-prompt-submit'}),true);
  assert.equal(attempt.status,'confirmed');
});

test('a late Codex transcript corrects an earlier unconfirmed RPC snapshot',()=>{
  const receipts=new PromptSubmissionReceipts(),attempt=receipts.begin('hub','request-a','exact text',1000);
  receipts.finish(attempt,{ok:true,sendStatus:'stuck'});
  const initial=receipts.snapshot(attempt);assert.equal(initial.status,'unconfirmed');
  receipts.observe({sessionId:'hub',text:'exact text',submittedAt:23000,turnId:'turn-a',signalSource:'item_completed_user_message'});
  assert.equal(attempt.status,'confirmed');assert.equal(initial.status,'unconfirmed','initial response is immutable evidence, not final state');
});
