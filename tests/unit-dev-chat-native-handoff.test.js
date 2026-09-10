'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const gc = require('../core/group-chat-orchestrator');
const watcher = require('../core/group-chat-watcher');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher');
const { rememberPrompt } = require('../core/dev-chat-history');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-handoff-unit-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const sid = 's1', meetingId = path.basename(root), sent = [];
  const runtime = { connection:'connected', state:'completed', threadId:'thread-1', turnId:'old-turn', endedTurns:['old-turn'] };
  const native = { runtime, receipts:new Map() };
  const session = { id:sid, kind:'codex', status:'idle', runtimeBackend:'codex-app-server', nativeRuntime:runtime };
  const meeting = { id:meetingId, scene:'dev', groupChat:true, serialWorkflow:{fileFlowVersion:2},
    subSessions:[sid], slotSpecs:[{kind:'codex',memberId:'m1'}], participants:[0] };
  const tap = new EventEmitter();
  Object.assign(tap, {clearLastTokens(){}, getLastTokens(){return null;}, getStreamingText(){return [];}, clearStreamingBuf(){}});
  const originalSend = watcher.sendToPty;
  watcher.sendToPty = async (...args) => { sent.push(args); return {ok:false, reason:'controlled send boundary'}; };
  t.after(() => { watcher.sendToPty = originalSend; });
  const dispatcher = createGroupChatDispatcher({getHubDataDir:()=>root, groupchat:gc, transcriptTap:tap,
    cliReadyDetector:{}, isCodexBaseKind:k=>k==='codex', kindLabels:{codex:'Codex'}, logger:{log(){},warn(){}},
    maybeAutoTitleMeetingFromPrompt(){}, meetingManager:{getMeeting:()=>meeting}, sendToRenderer(){},
    sessionManager:{getSession:()=>session, getNativeCodex:()=>native, getSessionBuffer:()=>'',
      getGroupChatLastActivity:()=>0, getGroupChatReady:()=>true, setGroupChatReady(){}, clearStreamingBuf(){}}});
  const orch = gc.getOrchestrator(root, meetingId);
  function oldAttempt(text='old prompt', turnId='old-turn') {
    const {turnNum,runId} = orch.beginTurn(text);
    const pending = orch.recordTurnPrompt(turnNum,sid,text,{runId,memberId:'m1',kind:'codex'});
    orch.setSendStatus(turnNum,sid,'ok',{attemptId:pending.attemptId, acknowledgementSource:'codex-app-server',
      providerTurnId:turnId, providerThreadId:'thread-1'});
    assert.equal(orch.getAttempt(pending.attemptId).providerThreadId,'thread-1');
    const receipt = rememberPrompt(orch,sid,pending);
    receipt.handedOffAt = Date.now();
    orch.completeTurn(turnNum,text,[{sid,attemptId:pending.attemptId,runId,status:'handed_off',text:'',providerTurnId:turnId}],
      {[sid]:{sid,memberId:'m1',kind:'codex'}},{},{runId});
    return {attempt:orch.state.attempts[pending.attemptId],receipt};
  }
  const {attempt,receipt} = oldAttempt();
  const dispatch = () => dispatcher.dispatchGroupChatTurn(meetingId,{userInput:'next stage',targetMemberIds:['m1'],fileHandoff:true,turnTimeoutMs:220});
  return {runtime,native,session,orch,attempt,receipt,sent,dispatch,oldAttempt,stop:()=>dispatcher.interruptMeetingTurn(meetingId)};
}

test('native handoff uses execution identity independently of source IO', async t => {
  const cases = [
    ['matching completed, no JSONL binding',()=>{},true],
    ['matching interrupted',c=>{c.runtime.state='interrupted';},true],
    ['matching failed',c=>{c.runtime.state='failed';},true],
    ['running despite collected final',c=>{c.runtime.state='running';c.receipt.sourceCompletedAt=Date.now();},false],
    ['waiting despite collected final',c=>{c.runtime.state='waiting';c.receipt.sourceCompletedAt=Date.now();},false],
    ['unknown despite endedTurns',c=>{c.runtime.state='unknown';},false],
    ['disconnected terminal',c=>{c.runtime.connection='disconnected';},false],
    ['wrong thread',c=>{c.runtime.threadId='wrong-thread';},false],
    ['wrong completed turn',c=>{c.runtime.turnId='wrong-turn';c.runtime.endedTurns=['wrong-turn'];},false],
    ['idle without matched ended turn',c=>{c.runtime.state='idle';c.runtime.endedTurns=[];},false],
    ['unknown submission',c=>{c.runtime.submission={status:'unknown'};},false],
    ['running another turn even though old ended',c=>{c.runtime.state='running';c.runtime.turnId='new-turn';},false],
    ['older receipt cannot hold a later completed attempt',c=>{
      c.oldAttempt('later prompt','later-turn'); c.runtime.turnId='later-turn'; c.runtime.endedTurns=['later-turn'];
    },true],
    ['persisted matching attempt after orchestrator reload',c=>{
      c.orch._saveState();c.orch._loadState();
    },true],
    ['legacy binding recovered by exact native submission',c=>{
      delete c.attempt.providerThreadId;c.runtime.submission={id:c.attempt.attemptId,status:'accepted',turnId:'old-turn'};
    },true],
    ['legacy binding rejects wrong attempt',c=>{
      delete c.attempt.providerThreadId;c.runtime.submission={id:'another-attempt',status:'accepted',turnId:'old-turn'};
    },false],
    ['legacy binding rejects wrong turn',c=>{
      delete c.attempt.providerThreadId;c.runtime.submission={id:c.attempt.attemptId,status:'accepted',turnId:'another-turn'};
    },false],
    ['missing native owner',c=>{delete c.native.runtime;},false],
  ];
  for (const [label,mutate,expected] of cases) await t.test(label,async st=>{
    const c=setup(st); mutate(c); await c.dispatch();
    assert.equal(c.sent.length,expected?1:0,label);
    assert.equal(c.receipt.sourceCompletedAt || null, /collected final/.test(label)?c.receipt.sourceCompletedAt:null,
      'execution release must not pretend history collection completed');
  });
});

test('native waiting becomes completed while source stays unavailable',async t=>{
  const c=setup(t);c.runtime.state='waiting';
  const pending=c.dispatch();await sleep(120);assert.equal(c.sent.length,0);
  c.runtime.state='completed';await pending;assert.equal(c.sent.length,1);
  assert.equal(c.receipt.sourceCompletedAt,undefined);
});

test('stop cancels native handoff wait; late completion never resumes it',async t=>{
  const c=setup(t);c.runtime.state='running';
  const pending=c.dispatch();await sleep(120);c.stop();c.runtime.state='completed';
  const result=await pending;assert.equal(result.status,'error');assert.equal(c.sent.length,0);
  await sleep(150);assert.equal(c.sent.length,0);
});
