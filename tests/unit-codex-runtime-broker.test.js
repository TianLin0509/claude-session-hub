'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { CodexRuntimeBroker } = require('../core/codex-runtime-broker');

class FakeSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.threadId = options.resumeId;
    this.runtime = { state:'idle', connection:'connected', epoch:1, revision:1,
      threadId:this.threadId, turnId:'turn-0', requests:[], endedTurns:['turn-0'], waitingFlags:[], submission:null };
    this.contentRevision = 1;
    this.receipts = new Map();
    this.pid = 4242;
    this.sent = [];
  }
  start() { return Promise.resolve(this.runtime); }
  readTranscript() { return [{ id:'card-1', turnId:'turn-0', role:'assistant', text:'ready' }]; }
  blocks() { return [{ type:'text', text:'ready' }]; }
  finalText() { return 'ready'; }
  async send(text, options) {
    if (text === 'slow-start') await new Promise(resolve => setTimeout(resolve, 20));
    this.sent.push({ text, options });
    this.runtime = { ...this.runtime, state:'running', revision:this.runtime.revision + 1,
      turnId:'turn-' + this.sent.length, endedTurns:[], submission:{ id:options.clientSubmissionId, status:'accepted' } };
    this.emit('state', this.runtime);
    return { ok:true, clientSubmissionId:options.clientSubmissionId, threadId:this.threadId, turnId:this.runtime.turnId };
  }
  interrupt() { return Promise.resolve({ ok:true, pending:true }); }
  reply() { return Promise.resolve({ ok:true }); }
  configure(value) { return Promise.resolve(value); }
  configureMode(mode, epoch) { return Promise.resolve({ mode, epoch }); }
  chooseThread() { return Promise.resolve({}); }
  restartEmpty() { return Promise.resolve({}); }
  reviewUnknownSubmission() { return { ok:true }; }
  readOutcome() { return Promise.resolve({ threadId:this.threadId, turnId:this.runtime.turnId }); }
  reconcile() { return Promise.resolve(this.runtime); }
  reconnect() { return Promise.resolve(this.runtime); }
  complete() {
    this.runtime = { ...this.runtime, state:'completed', revision:this.runtime.revision + 1,
      endedTurns:[this.runtime.turnId], submission:{ ...this.runtime.submission, status:'accepted' } };
    this.emit('state', this.runtime);
  }
}

function peer() {
  return { views:new Map(), messages:[], send(message) { this.messages.push(message); } };
}

function options(extra = {}) {
  return {
    id:'hub-card', cwd:'C:\\AIWork', env:{ CODEX_HOME:'C:\\profiles\\codex', PATH:'C:\\bin' },
    processArgs:['-c','features.fast_mode=false'], resumeId:'thread-1',
    threadParams:{ cwd:'C:\\AIWork', approvalPolicy:'never', sandbox:'danger-full-access' },
    ...extra,
  };
}

(async () => {
  let created = 0;
  const broker = new CodexRuntimeBroker({ serviceId:'service-1', sessionFactory:opts => { created++; return new FakeSession(opts); } });
  const a = peer(), b = peer(), c = peer();
  const viewA = { viewId:'view-a', sessionId:'hub-card', hubPid:10, hubVersion:'1.6.130', label:'Hub A' };
  const viewB = { viewId:'view-b', sessionId:'hub-card', hubPid:20, hubVersion:'1.6.130', label:'Hub B' };
  const viewC = { viewId:'view-c', sessionId:'hub-card', hubPid:30, hubVersion:'1.6.130', label:'Hub C' };

  const first = await broker.handle(a, 'attach', { options:options(), view:viewA });
  const second = await broker.handle(b, 'attach', { options:options(), view:viewB });
  assert.equal(created, 1, 'same thread and profile must create one runtime');
  assert.equal(first.control.role, 'controller');
  assert.equal(second.control.role, 'viewer');
  assert.equal(second.control.viewerCount, 2);
  assert.equal(second.control.serverPid, 4242);
  assert.deepEqual(second.transcript, first.transcript);

  await assert.rejects(
    broker.handle(b, 'action', { key:second.key, viewId:'view-b', controllerEpoch:1, action:'send', args:['blocked',{}] }),
    /只能查看/,
  );
  await assert.rejects(
    broker.handle(b, 'action', { key:second.key, viewId:'view-b', controllerEpoch:1,
      action:'configureMode', args:['plan',1] }),
    /只能查看/,
  );
  assert.deepEqual(
    await broker.handle(a, 'action', { key:first.key, viewId:'view-a', controllerEpoch:1,
      action:'configureMode', args:['plan',1] }),
    { mode:'plan', epoch:1 },
  );

  const [sendRace, transferRace] = await Promise.allSettled([
    broker.handle(a, 'action', { key:first.key, viewId:'view-a', controllerEpoch:1,
      action:'send', args:['slow-start',{clientSubmissionId:'m1'}] }),
    broker.handle(b, 'request-control', { key:second.key, viewId:'view-b', controllerEpoch:1 }),
  ]);
  assert.equal(sendRace.status, 'fulfilled');
  assert.equal(transferRace.status, 'rejected');
  assert.match(transferRace.reason.message, /工作中/);

  const record = broker.records.get(second.key);
  record.session.complete();
  const controlB = await broker.handle(b, 'request-control', { key:second.key, viewId:'view-b', controllerEpoch:1 });
  assert.equal(controlB.role, 'controller');
  assert.equal(controlB.controllerEpoch, 2);
  await assert.rejects(
    broker.handle(a, 'action', { key:first.key, viewId:'view-a', controllerEpoch:1, action:'send', args:['late',{}] }),
    /只能查看|已经变化/,
  );
  const sent = await broker.handle(b, 'action', { key:second.key, viewId:'view-b', controllerEpoch:2,
    action:'send', args:['next',{clientSubmissionId:'m2'}] });
  assert.equal(sent.clientSubmissionId, 'm2');

  await broker.handle(c, 'attach', { options:options(), view:viewC });
  record.session.complete();
  await broker.handle(b, 'reserve-workflow', { key:second.key, viewId:'view-b', controllerEpoch:2,
    reservationId:'workflow-1', label:'serial' });
  await assert.rejects(
    broker.handle(c, 'request-control', { key:second.key, viewId:'view-c', controllerEpoch:2 }),
    /工作流/,
  );
  await broker.handle(b, 'release-workflow', { key:second.key, viewId:'view-b', controllerEpoch:2, reservationId:'workflow-1' });
  const controlC = await broker.handle(c, 'request-control', { key:second.key, viewId:'view-c', controllerEpoch:2 });
  assert.equal(controlC.controller.viewId, 'view-c');
  assert.equal(controlC.controllerEpoch, 3);

  await broker.handle(a, 'locate-controller', { key:second.key, viewId:'view-a' });
  assert(c.messages.some(message => message.method === 'locate-request'));

  await assert.rejects(
    broker.handle(peer(), 'attach', { options:options({ processArgs:['-c','features.fast_mode=true'] }),
      view:{ viewId:'bad', sessionId:'hub-card', hubPid:40, hubVersion:'1.6.130', label:'bad' } }),
    /运行配置不同/,
  );

  broker.disconnect(c);
  record.session.runtime = { ...record.session.runtime, state:'running' };
  const recovered = await broker.handle(a, 'request-control', { key:second.key, viewId:'view-a', controllerEpoch:3 });
  assert.equal(recovered.role, 'controller');
  assert.equal(recovered.controllerEpoch, 4);
  assert.equal(recovered.controller.viewId, 'view-a');

  console.log('unit-codex-runtime-broker: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
