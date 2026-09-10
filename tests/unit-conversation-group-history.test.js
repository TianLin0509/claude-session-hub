'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {GroupChatOrchestrator}=require('../core/group-chat-orchestrator')._private;
const {groupDisplayMessages}=require('../core/conversation-display');
const {captureConversationMessages}=require('../core/conversation-capture');
const {createGroupConversationCollector}=require('../core/group-conversation-history');
test('native collector still records final items after a dispatch watcher handed off',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-handoff-'));
  const orch=new GroupChatOrchestrator(root,'meeting');
  const {turnNum,runId}=orch.beginTurn('prompt');
  const receipt=orch.recordTurnPrompt(turnNum,'sid','prompt',{runId,kind:'codex',memberId:'m1'});
  orch.setSendStatus(turnNum,'sid','ok',{attemptId:receipt.attemptId,acknowledgementSource:'codex-app-server',providerTurnId:'t',providerThreadId:'thread'});
  orch.completeTurn(turnNum,'prompt',[{sid:'sid',text:'',status:'handed_off',attemptId:receipt.attemptId,providerTurnId:'t'}],{sid:{sid:'sid',memberId:'m1'}},{},{runId});
  const messages=[{id:'p',text:'Still working',phase:'commentary',providerTurnId:'t',clientSubmissionId:receipt.attemptId}];
  const native={threadId:'thread',contentRevision:1,runtime:{turnId:'t',revision:1},readTranscript:()=>[{id:'a',role:'assistant',displayMessages:messages}]};
  const collect=createGroupConversationCollector();
  assert.equal(collect({native,orch,sid:'sid'}),true);
  assert.equal(collect({native,orch,sid:'sid'}),false);
  messages.push({...messages[0],id:'f',text:'Finished later',phase:'final_answer'});native.contentRevision++;
  assert.equal(collect({native,orch,sid:'sid'}),true);
  assert.deepEqual(orch.state.displayMessagesByAttempt[receipt.attemptId].map(m=>m.text),['Still working','Finished later']);
  assert.equal(orch.state.turns[0].byStatus.sid,'handed_off','collector must not decide workflow outcome');
});
test('group item history survives settlement/restart without becoming workflow final text',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-ledger-'));
  const orch=new GroupChatOrchestrator(root,'meeting');
  const {turnNum,runId}=orch.beginTurn('prompt');
  const receipt=orch.recordTurnPrompt(turnNum,'sid','prompt',{runId,kind:'codex',memberId:'m1'});
  orch.setSendStatus(turnNum,'sid','ok',{attemptId:receipt.attemptId,acknowledgementSource:'codex-app-server',providerTurnId:'turn',providerThreadId:'thread'});
  const progress={id:'p',text:'Progress',phase:'commentary',providerTurnId:'turn',ts:1};
  const save=orch._saveState;orch._saveState=()=>{throw Error('disk unavailable');};
  assert.throws(()=>orch.recordDisplayMessages(receipt.attemptId,[progress]),/disk unavailable/);
  assert.equal(orch.state.displayMessagesByAttempt?.[receipt.attemptId],undefined);
  orch._saveState=save;
  assert.equal(orch.recordDisplayMessages(receipt.attemptId,[progress]),true);
  assert.equal(orch.recordDisplayMessages(receipt.attemptId,[progress]),false);
  assert.equal(orch.recordDisplayMessages(receipt.attemptId,[{...progress,id:'foreign',providerTurnId:'other'}]),false);
  const final={...progress,id:'f',text:'Final',phase:'final_answer',ts:2};
  orch.recordDisplayMessages(receipt.attemptId,[final]); // reconnect snapshot omits earlier item
  orch.completeTurn(turnNum,'prompt',[{sid:'sid',text:'Final',status:'completed',attemptId:receipt.attemptId,providerTurnId:'turn'}],{sid:{sid:'sid',memberId:'m1',kind:'codex'}},{},{runId});
  const restored=new GroupChatOrchestrator(root,'meeting').getState();
  assert.equal(restored.turns[0].by.sid,'Final');
  assert.deepEqual(restored.displayMessagesByAttempt[receipt.attemptId].map(m=>m.text),['Progress','Final']);
  const msg=restored.messages.find(m=>m.role==='assistant');
  assert.equal(groupDisplayMessages(msg,restored.displayMessagesByAttempt[receipt.attemptId]).length,2);
  assert.equal(groupDisplayMessages({...msg,status:'manual_extracted',content:'Manual recovery'},[progress,final]).at(-1).text,'Manual recovery');
});
test('native capture uses exact provider turn instead of the most recent answer',()=>{
  const native={readTranscript:()=>[{id:'t1',role:'assistant',text:'legacy',displayMessages:[
    {id:'old',text:'Old',providerTurnId:'old-turn'},{id:'right',text:'Right',providerTurnId:'owned-turn'}]}]};
  assert.deepEqual(captureConversationMessages({native,providerTurnId:'owned-turn'}).map(m=>m.text),['Right']);
  assert.deepEqual(captureConversationMessages({native,providerTurnId:null}),[]);
});
