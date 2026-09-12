'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {AcpSession} = require('../core/acp-session');
const {nativeTurnHasEnded} = require('../core/codex-native-runtime');
const {getSessionRuntimeTruth} = require('../core/session-runtime-truth');
const {isGroupChatMemberRunning} = require('../core/groupchat-running-state');
const {deriveSessionRuntimeStatus} = require('../renderer/session-runtime-status');
const {buildComposerStatusModel} = require('../core/session-status-summary');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(test) {
  const deadline = Date.now()+4000;
  while (!test()) {if (Date.now()>deadline) throw Error('fixture condition timeout');await sleep(5);}
}
async function run(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-cancel-unit-'));
  const s = new AcpSession({id:'cancel',kind:'qwen',cwd:root,profileId:'fixture',storeDir:root,
    cancelTimeoutMs:mode === 'no-confirmation' ? 100 : 2000,
    launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/acp-cancel-race.js')],cwd:root,
      env:{...process.env,ACP_CANCEL_FIXTURE_HOLD_MS:'40'}}});
  let release, reply, cancelledTurn;
  const observed = [];
  s.on('state',r => {if (cancelledTurn && r.turnId === cancelledTurn) observed.push(structuredClone(r));});
  try {
    await s.start();
    const send = s.send(mode);
    if (mode === 'prefill') await until(() => s.active);
    else await send;
    let old;
    if (mode.startsWith('queued-')) {
      await until(() => s.runtime.requests.length);
      old = s.runtime.requests[0];
      // Hold the transport queue, click Allow, then Stop before any queued
      // response can reach stdin. This exercises the actual AcpClient writer.
      const prior = s.client.tail;
      s.client.tail = prior.then(() => new Promise(resolve => {release=resolve;}));
      reply = s.reply(old.id,old.method === 'elicitation/create' ? {action:'accept',content:{answer:'yes'}}
        : {outcome:{outcome:'selected',optionId:'allow'}},s.runtime.epoch);
      reply = assert.rejects(reply,/已失效/);
      await until(() => release);
    }
    cancelledTurn = s.active.turnId;
    const interrupted = s.interrupt();
    assert.equal(s.runtime.cancellation.status,'pending','Stop latches synchronously before awaiting transport');
    const cancellationDeadline=s.runtime.cancellation.deadlineAt;
    assert.equal(s.runtime.requests.length,0);
    const info = {id:'cancel',kind:'qwen',runtimeBackend:'acp',nativeRuntime:s.runtime,status:'running'};
    assert.equal(getSessionRuntimeTruth(info).cancellation.status,'pending');
    assert.equal(isGroupChatMemberRunning(info),true,'file/group handoff stays blocked until provider terminal');
    assert.equal(nativeTurnHasEnded(info,{threadId:s.threadId,turnId:cancelledTurn}),false);
    const runtime = deriveSessionRuntimeStatus(info);
    assert.equal(runtime.label,'正在停止');
    const composer = buildComposerStatusModel(info,{runtime});
    assert.match(composer.text,/正在停止/);assert.equal(composer.canStop,false);
    if (old) await assert.rejects(s.reply(old.id,{outcome:{outcome:'selected',optionId:'allow'}},s.runtime.epoch),/已失效/);
    release?.();
    await interrupted;await reply;
    if (mode === 'no-confirmation') {
      await assert.rejects(s.idle(4000),/连接异常/);
      assert.equal(s.runtime.state,'unknown');
      assert.equal(s.runtime.submission.status,'unknown');
      assert.equal(s.runtime.cancellation.status,'unknown');
      assert.match(s.runtime.reason,/停止未在期限/);
      assert.equal(await s.readOutcome(cancelledTurn),null,'timeout is not a fabricated interrupted outcome');
      await assert.rejects(s.send('next'),/尚未结束|未连接|结果不明/);
      assert.equal(s.history.size,1,'no automatic retry');
    } else {
      await s.idle(4000);await send;
      assert.equal(s.runtime.state,'interrupted');
      assert.equal(s.runtime.cancellation,null);
      assert.equal((await s.readOutcome(cancelledTurn)).status,'interrupted');
      if (!mode.startsWith('queued-')) assert.match(s.finalText(),/cancellation tail/,'consume tail updates while cancelling');
      if (mode==='late-interactions') {
        await s.send('second-active');
        await sleep(Math.max(0,cancellationDeadline-Date.now())+100);
        assert.equal(s.runtime.connection,'connected','previous cancellation deadline must not close the next turn');
        assert.equal(s.runtime.state,'running');assert.equal(s.runtime.cancellation,null);
        await s.interrupt();await s.idle(4000);
      }
      await s.send('next');
      if (old) await assert.rejects(s.reply(old.id,{outcome:{outcome:'selected',optionId:'allow'}},s.runtime.epoch),/已失效/);
      await s.idle(4000);
      assert.equal(s.finalText(),'NEXT_TURN');assert.equal(s.runtime.state,'completed');
      assert.equal(s.runtime.cancellation,null);
      if (old) await assert.rejects(s.reply(old.id,{outcome:{outcome:'selected',optionId:'allow'}},s.runtime.epoch),/已失效/);
    }
    assert(!fs.existsSync(path.join(root,'side-effect.txt')),'no cancelled request can authorize a side effect');
    const responses = fs.readFileSync(path.join(root,'responses.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(responses.length);
    for (const q of responses) assert.deepEqual(q.result,q.method === 'elicitation/create'
      ? {action:'cancel'} : {outcome:{outcome:'cancelled'}});
    assert(!observed.some(r=>r.state === 'waiting' || r.requests.length),'late requests never restore actionable waiting state');
    console.log('PASS cancellation '+mode);
  } finally {release?.();s.kill();}
}
(async()=>{for (const mode of ['late-interactions','queued-permission','queued-question','prefill','no-confirmation']) await run(mode);})()
  .catch(error=>{console.error(error);process.exitCode=1;});
