'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCodexSessionModel } = require('../core/model-options');
const { sessionModelId, buildSessionResumeMeta } = require('../core/session-capabilities');
const { parseCodexUsage } = require('../main/usage/agent-usage-parser');
const { PtyOutputDelivery } = require('../core/pty-output-delivery');
const { CodexXtermScrollbackRewriter } = require('../core/codex-xterm-scrollback-rewriter');
const { isTerminalProtocolReply } = require('../renderer/terminal-input-controller');
const { navigateCodexTranscript } = require('../renderer/terminal-input-controller');

test('main retains live Codex running, waiting and terminal states across renderer bootstrap', () => {
  const { SessionManager } = require('../core/session-manager');
  const manager=Object.create(SessionManager.prototype);
  const entry={info:{id:'runtime',kind:'codex',agentRuntime:'pty',status:'idle'}};
  manager.sessions=new Map([['runtime',entry]]);manager.emit=()=>{};
  const start=Date.now()-100;
  manager.noteAgentTurnStarted('runtime',{startedAt:start,turnId:'T1',signalSource:'task_started'});
  assert.equal(manager.getAllSessions()[0].runtimeTruth.state,'running');
  manager.noteCodexHookActivity('runtime','permission-request',{turnId:'T1'},Date.now());
  assert.equal(manager.getAllSessions()[0].runtimeTruth.state,'waiting');
  manager.noteAgentTurnFinished('runtime',{turnId:'T1',abortedAt:Date.now()});
  assert.equal(manager.getAllSessions()[0].runtimeTruth.state,'interrupted');
  manager.noteCodexHookActivity('runtime','tool-start',{turnId:'T1'},Date.now());
  assert.equal(manager.getAllSessions()[0].runtimeTruth.state,'interrupted','late tools cannot reopen a closed native turn');
  manager.noteAgentTurnStarted('runtime',{startedAt:Date.now(),turnId:'T2',signalSource:'task_started'});
  manager.noteCodexHookActivity('runtime','permission-request',{turnId:'T1'},Date.now());
  assert.equal(manager.getAllSessions()[0].runtimeTruth.state,'running','foreign turn cannot change activity');
  manager.noteAgentTurnFinished('runtime',{turnId:'T2',failedAt:Date.now(),message:'provider rejected'});
  assert.equal(manager.getAllSessions()[0].runtimeTruth.state,'failed');
});

test('owned fullscreen history navigation goes to the CLI, legacy scrollback stays in xterm', () => {
  const keys=[],terminal={buffer:{active:{type:'alternate'}},modes:{mouseTrackingMode:'any'},input:(key,user)=>keys.push({key,user})};
  assert.equal(navigateCodexTranscript({kind:'codex'},terminal,'up'),true);
  assert.equal(navigateCodexTranscript({kind:'codex'},terminal,'bottom'),true);
  assert.deepEqual(keys,[{key:'\x1b[5~',user:true},{key:'\x1b[1;5F',user:true}]);
  terminal.buffer.active.type='normal';
  assert.equal(navigateCodexTranscript({kind:'codex'},terminal,'up'),false);
  terminal.buffer.active.type='alternate';
  assert.equal(navigateCodexTranscript({kind:'claude'},terminal,'up'),false);
  assert.equal(keys.length,2);
});

test('terminal color and capability replies are not user input', () => {
  for (const data of ['\x1b]10;rgb:dddd/dddd/dddd\x1b\\', '\x1b]11;rgb:1818/1818/1818\x07', '\x1b[?1;2c', '\x1b[18;4R', '\x1b[I']) {
    assert.equal(isTerminalProtocolReply(data), true, JSON.stringify(data));
  }
  for (const data of ['hello', '\r', '\x1b', '\x1b[A', '\x1b[200~中文\x1b[201~', '\x1b]10;rgb:aaaa/aaaa/aaaa\x07hello']) {
    assert.equal(isTerminalProtocolReply(data), false, JSON.stringify(data));
  }
});

test('native display labels never become request identifiers on resume', () => {
  const footer = '  GPT-6-Astra high · Context 48% left · C:\\AIWork';
  const parsed = parseCodexUsage(footer);
  assert.equal(parsed.model.id, 'gpt-6-astra');
  assert.equal(parsed.model.displayName, 'GPT-6-Astra');
  const old = { id:'s',kind:'codex',currentModel:{id:'GPT-6-Astra'},codexSid:'thread-original' };
  assert.equal(sessionModelId(old),'gpt-6-astra');
  assert.equal(buildSessionResumeMeta(old).model,'gpt-6-astra');
  assert.equal(buildSessionResumeMeta(old).codexSid,'thread-original');
  assert.equal(normalizeCodexSessionModel('GPT-5.6-Sol'),'gpt-5.6-sol');
});

test('partial inline frames have a fixed latency bound despite continuous output', () => {
  const timers = new Map(), chunks = []; let index = 0;
  const delivery = new PtyOutputDelivery({
    emit: data=>chunks.push(data), rewriter:new CodexXtermScrollbackRewriter({conptySerialized:true}),
    setTimer:fn=>{timers.set(++index,fn);return index;},clearTimer:id=>timers.delete(id),
  });
  const start='\x1b[?2026h\x1b[?2026l\x1b[?25l';
  delivery.write(start);
  const first=[...timers.keys()][0];
  for(let i=0;i<30;i++)delivery.write('\x1b[3;1HWorking '+i);
  assert.deepEqual([...timers.keys()],[first]);
  const fire=timers.get(first);timers.delete(first);fire();
  assert.equal(chunks.join(''),start+Array.from({length:30},(_,i)=>'\x1b[3;1HWorking '+i).join(''));
  delivery.close();assert.equal(timers.size,0);
});

test('fullscreen native animation packets pass through without awaiting a cursor-show frame', () => {
  const out=[];
  const delivery=new PtyOutputDelivery({emit:data=>out.push(data),rewriter:new CodexXtermScrollbackRewriter({conptySerialized:true})});
  const mode='\x1b[?1049h';delivery.write(mode);
  for(let i=0;i<12;i++){
    const frame='\x1b[?2026h\x1b[?2026l\x1b[?25l\x1b[4;1H\x1b[38;2;'+i+';80;80mWorking';
    const before=out.length;delivery.write(frame);assert.equal(out.length,before+1);assert.equal(out.at(-1),frame);
  }
  delivery.close();
});

test('adapter failure reports the error and preserves the uncommitted prefix once', () => {
  const errors=[],out=[];
  const delivery=new PtyOutputDelivery({emit:x=>out.push(x),onError:e=>errors.push(e.message),rewriter:{
    pendingText:()=> '\x1b[',write:()=>{throw Error('adapter failed');},
  }});
  delivery.write('31mhello');delivery.write(' world');delivery.close();
  assert.equal(out.join(''),'\x1b[31mhello world');assert.deepEqual(errors,['adapter failed']);
});

test('provider rejection leaves the live PTY usable instead of offering a reconnect', () => {
  const session={kind:'codex',agentRuntime:'pty',status:'idle',lastError:'model rejected',runtimeTruth:{
    state:'failed',source:'codex-task-complete-error',confidence:'authoritative',observedAt:Date.now(),evidence:'model rejected',
  }};
  const runtime=require('../renderer/session-runtime-status').deriveSessionRuntimeStatus(session);
  const status=require('../core/session-status-summary').buildComposerStatusModel(session,{runtime});
  assert.equal(status.state,'ready');assert.equal(status.action,null);assert.match(status.text,/执行失败/);assert.match(status.detail,/model rejected/);
  session._processLost={reason:'exited'};
  assert.equal(require('../core/session-status-summary').buildComposerStatusModel(session,{runtime}).action.kind,'reconnect');
});

test('authoritative PTY completion wins over a stale screen activity flag', () => {
  const session={kind:'codex',agentRuntime:'pty',status:'idle',runtimeTruth:{
    state:'completed',source:'codex-turn-complete',confidence:'authoritative',observedAt:Date.now(),completedAt:Date.now(),
  }};
  const runtime=require('../renderer/session-runtime-status').deriveSessionRuntimeStatus(session,{isRunning:true});
  assert.equal(runtime.state,'completed');
  assert.equal(require('../core/session-status-summary').buildComposerStatusModel(session,{runtime}).state,'ready');
});
