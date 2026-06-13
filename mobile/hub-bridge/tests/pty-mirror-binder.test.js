'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PtyMirrorBinder } = require('../pty-mirror-binder');
const { MSG } = require('../../shared/protocol');

function makeOutbound() {
  const sent = [];
  return {
    sent,
    send(msg) { sent.push(msg); return true; },
  };
}

function makeSessionManager() {
  const manager = new EventEmitter();
  const writes = [];
  const resizes = [];
  manager.getSession = (id) => id === 's1' ? { id: 's1', title: 'PTY probe' } : null;
  manager.getSessionBuffer = (id) => id === 's1' ? 'ready> ' : '';
  manager.writeToSession = (sessionId, data) => writes.push({ sessionId, data });
  manager.resizeSession = (sessionId, cols, rows) => resizes.push({ sessionId, cols, rows });
  manager.writes = writes;
  manager.resizes = resizes;
  return manager;
}

function decodeB64(value) {
  return Buffer.from(String(value || ''), 'base64').toString('utf8');
}

test('PtyMirrorBinder subscribe sends ack and current snapshot', () => {
  const outbound = makeOutbound();
  const sessionManager = makeSessionManager();
  const binder = new PtyMirrorBinder({ sessionManager, outbound, logger: { warn() {} } });

  binder.handleSubscribe({ deviceToken: 'dt', sessionId: 's1' });

  assert.equal(outbound.sent.length, 2);
  assert.deepEqual(outbound.sent[0], {
    type: MSG.PTY_ACK,
    deviceToken: 'dt',
    sessionId: 's1',
    action: 'subscribe',
    ok: true,
    error: null,
  });
  assert.equal(outbound.sent[1].type, MSG.PTY_SNAPSHOT);
  assert.equal(outbound.sent[1].deviceToken, 'dt');
  assert.equal(outbound.sent[1].sessionId, 's1');
  assert.equal(decodeB64(outbound.sent[1].dataB64), 'ready> ');
});

test('PtyMirrorBinder streams output to subscribers and replays sinceSeq', () => {
  const outbound = makeOutbound();
  const sessionManager = makeSessionManager();
  const binder = new PtyMirrorBinder({ sessionManager, outbound, logger: { warn() {} } });
  binder.start();
  binder.handleSubscribe({ deviceToken: 'dt', sessionId: 's1' });
  outbound.sent.length = 0;

  sessionManager.emit('output', { sessionId: 's1', data: 'hello\r\n' });

  assert.equal(outbound.sent.length, 1);
  assert.equal(outbound.sent[0].type, MSG.PTY_DATA);
  assert.equal(outbound.sent[0].seq, 1);
  assert.equal(decodeB64(outbound.sent[0].dataB64), 'hello\r\n');

  binder.handleSubscribe({ deviceToken: 'dt2', sessionId: 's1', sinceSeq: 0 });
  assert.equal(outbound.sent.at(-1).type, MSG.PTY_SNAPSHOT);

  binder.handleSubscribe({ deviceToken: 'dt3', sessionId: 's1', sinceSeq: 0 });
  sessionManager.emit('output', { sessionId: 's1', data: 'again\r\n' });
  const dt3Frames = outbound.sent.filter(m => m.deviceToken === 'dt3' && m.type === MSG.PTY_DATA);
  assert.equal(dt3Frames.length, 1);
  assert.equal(decodeB64(dt3Frames[0].dataB64), 'again\r\n');

  binder.handleSubscribe({ deviceToken: 'dt4', sessionId: 's1', sinceSeq: 1 });
  const dt4Replay = outbound.sent.filter(m => m.deviceToken === 'dt4' && m.type === MSG.PTY_DATA);
  assert.equal(dt4Replay.length, 1);
  assert.equal(dt4Replay[0].seq, 2);
  assert.equal(decodeB64(dt4Replay[0].dataB64), 'again\r\n');
});

test('PtyMirrorBinder input writes decoded bytes and resize is clamped', () => {
  const outbound = makeOutbound();
  const sessionManager = makeSessionManager();
  const binder = new PtyMirrorBinder({ sessionManager, outbound, logger: { warn() {} } });

  binder.handleInput({
    deviceToken: 'dt',
    sessionId: 's1',
    dataB64: Buffer.from('Write-Output "ok"\r', 'utf8').toString('base64'),
  });
  binder.handleResize({ deviceToken: 'dt', sessionId: 's1', cols: 500, rows: 2 });

  assert.deepEqual(sessionManager.writes, [{ sessionId: 's1', data: 'Write-Output "ok"\r' }]);
  assert.deepEqual(sessionManager.resizes, [{ sessionId: 's1', cols: 240, rows: 6 }]);
  assert.equal(outbound.sent.filter(m => m.type === MSG.PTY_ACK && m.ok).length, 2);
});

test('PtyMirrorBinder unsubscribe stops output delivery', () => {
  const outbound = makeOutbound();
  const sessionManager = makeSessionManager();
  const binder = new PtyMirrorBinder({ sessionManager, outbound, logger: { warn() {} } });
  binder.start();
  binder.handleSubscribe({ deviceToken: 'dt', sessionId: 's1' });
  outbound.sent.length = 0;

  binder.handleUnsubscribe({ deviceToken: 'dt', sessionId: 's1' });
  sessionManager.emit('output', { sessionId: 's1', data: 'hidden\r\n' });

  assert.equal(outbound.sent.length, 1);
  assert.equal(outbound.sent[0].type, MSG.PTY_ACK);
  assert.equal(outbound.sent[0].action, 'unsubscribe');
});
