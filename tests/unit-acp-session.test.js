'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AcpSession } = require('../core/acp-session');
const { AcpClient } = require('../main/acp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acp-unit-'));
const options = { id: 'test', kind: 'qwen', cwd: root, profileId: 'fixture', model: 'fixture', defaultMode:'default', storeDir: root,
  launch: { command: process.execPath, args: [path.join(__dirname, 'fixtures/acp-agent.js')], cwd: root, env: process.env } };
async function main() {
  let session = new AcpSession(options);
  const observed = [];
  const startupBounds=[];session.on('bound',bound=>startupBounds.push(structuredClone(bound)));
  session.on('lifecycle', e => observed.push(e));
  try {
    await session.start();
    assert.equal(startupBounds.length,1,'provisional native defaults must not reach interactive UI');
    assert.equal(startupBounds[0].configOptions.find(o=>o.id==='mode').currentValue,'default');
    assert.equal(session.runtime.state, 'idle');
    const receipt = await session.send('hello', { clientSubmissionId: 'first' });
    assert.equal(receipt.acknowledgementTurnId,receipt.turnId);
    await session.idle(2000);
    assert.equal(session.runtime.state, 'completed');
    const outcome=await session.readOutcome(receipt.turnId);
    assert.equal(outcome.text,'中文🧪 hello');
    assert.equal(await session.readOutcome('unknown'),null);
    const {createTurnCompletionWatcher}=require('../core/turn-completion-watcher');
    const tap=new (require('events').EventEmitter)();
    const watcher=createTurnCompletionWatcher({transcriptTap:tap,hubSessionId:'test',kind:'qwen',nativeOnly:true});
    const done=watcher.wait();
    assert.equal(watcher.observeNativeOutcome({...outcome,signalSource:'codex-app-server'}),false);
    assert.equal(watcher.observeNativeOutcome(outcome),true);
    assert.equal((await done).text,outcome.text);
    const {PromptSubmissionReceipts}=require('../core/prompt-submission-receipts');
    const receipts=new PromptSubmissionReceipts();
    const delivery=receipts.begin('test','first','hello',0,{nativeOnly:true});
    assert.equal(receipts.observe(observed.find(e=>e.type==='prompt-submitted')),true);
    assert.equal(delivery.status,'confirmed');
    assert.equal(session.finalText(), '中文🧪 hello');
    assert.equal(session.readTranscript({}).filter(c => c.role === 'user').length, 1);
    assert.equal(session.readTranscript({})[1].toolCalls.length, 1);
    const turnBeforeCommand=session.runtime.turnId;
    assert.match((await session.send('/quota')).commandOutput,/百炼/);
    assert.equal(session.runtime.turnId,turnBeforeCommand);
    await assert.rejects(session.send('/model deepseek-official::deepseek-v4-pro'),/命名空间/);
    assert.deepEqual(await session.send('hello', { clientSubmissionId: 'first' }), receipt);
    await assert.rejects(session.send('different', { clientSubmissionId: 'first' }), /已变化/);
    await session.send('question');
    const question = session.runtime.requests[0];
    await assert.rejects(session.reply(question.id, { action:'accept',content:{color:'green'} },session.runtime.epoch), /有效答案/);
    await session.reply(question.id, { action:'accept',content:{color:'blue'} },session.runtime.epoch);
    await session.idle(2000);
    assert.equal(session.finalText(),'blue');
    await session.send('permission');
    // Wait for the server request, not an arbitrary sleep.
    if (!session.runtime.requests.length) await new Promise(resolve => {
      const listen = r => { if (r.requests.length) { session.off('state', listen); resolve(); } };
      session.on('state', listen);
    });
    assert.equal(session.runtime.state, 'waiting');
    const request = session.runtime.requests[0];
    await assert.rejects(session.reply(request.id, { outcome: { outcome: 'selected', optionId: 'yes' } }, 0), /旧连接/);
    await session.reply(request.id, { outcome: { outcome: 'selected', optionId: 'no' } }, session.runtime.epoch);
    await session.idle(2000);
    assert.match(session.finalText(), /no/);
    await session.send('cancel');
    await session.interrupt();
    await session.idle(2000);
    assert.equal(session.runtime.state, 'interrupted');
    await assert.rejects(session.send('reject'), /fixture rejected/);
    assert.equal(session.runtime.state, 'failed');
    for(const failure of ['auth-401','rate-429','quota-402','server-500']) {
      await assert.rejects(session.send(failure),new RegExp(failure));
      assert.equal(session.runtime.state,'failed');
      const outcome=await session.readOutcome(session.runtime.turnId);
      assert.equal(outcome.status,'failed');
      assert.match(outcome.error,new RegExp(failure));
    }
    const count = session.readTranscript({}).length;
    session.kill();
    session = new AcpSession(options);
    await session.start();
    assert.equal(session.threadId, 'fixture-session');
    assert.deepEqual(await session.readOutcome(receipt.turnId),outcome);
    assert.equal(session.readTranscript({}).length, count);
    assert.deepEqual(await session.send('hello',{clientSubmissionId:'first'}),receipt);
    assert.equal(session.readTranscript({limit:0}).length,0);
    await session.send('after-restart');
    await session.idle(2000);
    assert.match(session.finalText(), /after-restart/);
    await assert.rejects(session.send('break-json'), /非 JSON/);
    assert.equal(session.runtime.connection, 'disconnected');
    assert.equal(session.runtime.submission.status, 'unknown');
    assert.ok(observed.some(e => e.type === 'turn-complete' && e.signalSource === 'acp'));
  } finally { session.kill(); }
  const uncertain=new AcpSession({...options,id:'uncertain',ackTimeoutMs:30});
  try {
    await uncertain.start();await assert.rejects(uncertain.send('silent'),/执行证据/);
    assert.equal(uncertain.runtime.submission.status,'unknown');
    await assert.rejects(uncertain.send('do-not-retry'),/尚未结束/);
    await uncertain.interrupt();await uncertain.idle(2000);assert.equal(uncertain.runtime.state,'interrupted');
    const old=uncertain.client;await uncertain.reconnect();const revision=uncertain.contentRevision;
    old.emit('notification',{method:'session/update',params:{sessionId:uncertain.threadId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'stale'}}}});
    assert.equal(uncertain.contentRevision,revision);
  }finally{uncertain.kill();}
  // Fragmented UTF-8 bytes and multiple JSON-RPC frames are decoded losslessly.
  const client = new AcpClient({ maxBytes: 128 });
  const frames = [];
  client.on('notification', m => frames.push(m.params));
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'update', params: '汉字🧪' }) + '\n');
  for (const byte of bytes) client.feed(Buffer.from([byte]));
  assert.deepEqual(frames, ['汉字🧪']);
  client.feed(Buffer.alloc(129, 65));
  assert.equal(client.closed, true);
  console.log('ACP session: real stdio, Unicode, tool cards, permissions, cancellation, rejection, history and disconnect PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
