'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getSessionRuntimeTruth, applySessionRuntimeObservation } = require('../core/session-runtime-truth');
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state');
const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');
const { buildComposerStatusModel } = require('../core/session-status-summary');
function session(state) {
  return { id:'hub-1', kind:'codex', status:'running', gcWorking:true, _gcWorkingLastTs:9000,
    runtimeBackend:'codex-app-server',
    nativeRuntime:{ state, connection:'connected', threadId:'thread-1', turnId:'turn-1',
      epoch:1, revision:4, observedAt:8000, startedAt:7000, completedAt:state==='completed'?8000:0,
      requests:[], reason:null }, runtimeTruth:{state:'running',observedAt:9000,source:'pty',confidence:'strong'} };
}
test('Codex completion cannot be overwritten by screen, heartbeat, legacy status or composer guesses',()=>{
  const s=session('completed');
  assert.equal(getSessionRuntimeTruth(s,{now:9000}).state,'completed');
  assert.equal(isGroupChatMemberRunning(s,9000),false);
  const runtime=deriveSessionRuntimeStatus(s,{now:9000,isRunning:true});
  assert.equal(runtime.state,'completed');
  assert.equal(buildComposerStatusModel(s,{runtime,now:9000,liveQuestion:{waiting:true,text:'old screen question'}}).state,'ready');
  for(const source of ['pty-codex-input-ready','codex-task-started','codex-turn-complete','groupchat-stream','stop-hook']) {
    assert.equal(applySessionRuntimeObservation(s,{state:'running',source,observedAt:10000}).applied,false);
  }
  assert.equal(getSessionRuntimeTruth(s).state,'completed');
});
test('Codex waiting is unfinished for scheduling, with one native source for every display',()=>{
  const s=session('waiting');
  s.nativeRuntime.requests=[{id:7,method:'item/tool/requestUserInput',params:{questions:[{id:'q',header:'Pick',question:'Native question',options:[]}]}}];
  assert.equal(getSessionRuntimeTruth(s).state,'waiting');
  assert.equal(isGroupChatMemberRunning(s,9000),true);
  const runtime=deriveSessionRuntimeStatus(s,{now:9000});
  assert.equal(buildComposerStatusModel(s,{runtime,now:9000}).state,'waiting');
});
test('Codex without a managed snapshot is unknown, and legacy fields cannot certify idle or success',()=>{
  const s={id:'legacy',kind:'codex',status:'idle',lastCompletedAt:9000};
  assert.equal(getSessionRuntimeTruth(s,{now:10000}).state,'unknown');
});
test('non-Codex consumers retain their established protocol',()=>{
  const s={kind:'claude',status:'idle'};
  assert.equal(applySessionRuntimeObservation(s,{state:'running',source:'claude-user-prompt-submit',observedAt:1000}).applied,true);
  assert.equal(getSessionRuntimeTruth(s,{now:1000}).state,'running');
});


test('all native states override contradictory automation and legacy execution fields',()=>{
  const {publicAgent}=require('../main/ipc/agent-league-handlers');
  const row={agent:{id:'a',philosophyKey:'missing'},session:{hubSessionId:'hub-1'},portfolio:{},trades:{rows:[]},memory:{candidates:[]},evolution:{proposals:[]}};
  for(const state of ['idle','running','waiting','completed','interrupted','failed','unknown']){
    const s=session(state);s.status=['running','waiting'].includes(state)?'idle':'running';
    const truth=getSessionRuntimeTruth(s);assert.equal(truth.state,state);
    assert.equal(deriveSessionRuntimeStatus(s).state,state);
    assert.equal(isGroupChatMemberRunning(s),['running','waiting'].includes(state));
    const view=publicAgent(row,{getSession:()=>s},{pendingSessionIds:new Set(['hub-1'])});
    assert.equal(view.session.execution.state,state);assert.equal(view.session.status,state);
  }
  const lost=session('running');lost.nativeRuntime.connection='disconnected';
  assert.equal(getSessionRuntimeTruth(lost).state,'unknown');assert.equal(deriveSessionRuntimeStatus(lost).state,'unknown');
});

test('sidebar, home, composer, attention and suspension agree for the native state matrix',()=>{
  const {buildHomeSnapshot}=require('../renderer/home-workbench');
  const {partitionSidebarSessions}=require('../renderer/session-list-renderer');
  const {sessionNeedsUserInput}=require('../core/session-attention-state');
  const {SessionManager}=require('../core/session-manager');
  for(const state of ['idle','running','waiting','completed','interrupted','failed','unknown']){
    const s=session(state);s.codexSid='thread-1';s.lastMessageTime=9000;s.needsUserInput=true;s.isWaiting=true;s.attentionState='needs-input';
    const runtime=deriveSessionRuntimeStatus(s,{now:9000});
    for(const key of ['threadId','turnId','revision','epoch'])assert.equal(runtime[key],s.nativeRuntime[key],state+': '+key);
    const composer=buildComposerStatusModel(s,{runtime,now:9000,liveQuestion:{waiting:true,text:'obsolete question'}});
    assert.equal(composer.state,state==='running'?'working':state==='waiting'?'waiting':state==='unknown'?'dead':'ready',state);
    assert.equal(sessionNeedsUserInput(s),state==='waiting');
    const home=buildHomeSnapshot({sessions:new Map([[s.id,s]]),now:9000});assert.equal(home.items[0].status,state);
    assert.equal(home.lanes.running.some(x=>x.id===s.id),state==='running');assert.equal(home.lanes.waiting.some(x=>x.id===s.id),state==='waiting');
    const side=partitionSidebarSessions([s],{now:9000});assert.equal(side.active.some(x=>x.id===s.id),['running','waiting','failed'].includes(state),state);
    const manager=Object.create(SessionManager.prototype);manager.sessions=new Map([[s.id,{info:s}]]);
    const suspended=manager._evaluateSuspendEligibility(s.id,{now:9000});assert.equal(suspended.ok,['idle','completed','interrupted','failed'].includes(state),state);
  }
});
