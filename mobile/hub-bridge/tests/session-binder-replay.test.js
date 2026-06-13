'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { SessionBinder, MOBILE_SESSION_ID } = require('../session-binder');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'binder-replay-'));
}

function makeBinder(dir) {
  const transcriptTap = new EventEmitter();
  const sent = [];
  const writes = [];
  let buffer = 'Try ';
  const sessions = new Map([
    [MOBILE_SESSION_ID, { id: MOBILE_SESSION_ID, kind: 'claude', title: '手机 Claude' }],
    ['mobile-codex', { id: 'mobile-codex', kind: 'codex', title: '手机 Codex' }],
  ]);
  const sessionManager = {
    sessions: new Map(),
    getSession(id) { return sessions.get(id) || null; },
    createSession(kind, opts) {
      const s = { id: opts.id, kind, title: opts.title };
      sessions.set(opts.id, s);
      return s;
    },
    closeSession() {},
    getSessionBuffer() { return buffer; },
    writeToSession(sessionId, data) { writes.push({ sessionId, data }); },
  };
  const binder = new SessionBinder({
    sessionManager,
    transcriptTap,
    outbound: { send: (msg) => { sent.push(msg); return true; } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    dataDir: dir,
  });
  return {
    binder,
    transcriptTap,
    sent,
    writes,
    setBuffer(next) { buffer = next; },
  };
}

test('SessionBinder persists global turn seq and replays missing turns after sinceSeq', () => {
  const dir = tmpDir();
  const { binder, transcriptTap, sent } = makeBinder(dir);
  const now = Date.now();
  binder.start();
  binder.mobileSessionIds.add('mobile-codex');
  binder.sessionMeta.set('mobile-codex', {
    kind: 'codex',
    title: '手机 Codex',
    createdAt: Date.now(),
  });

  transcriptTap.emit('turn-complete', {
    hubSessionId: MOBILE_SESSION_ID,
    text: 'first reply',
    completedAt: now,
    durationMs: 11,
    modelId: 'claude-sonnet-4-5',
  });
  transcriptTap.emit('turn-complete', {
    hubSessionId: 'mobile-codex',
    text: 'second reply',
    completedAt: now + 1,
    durationMs: 22,
    modelId: 'gpt-5',
  });

  const liveTurns = sent.filter((m) => m.type === 'turn');
  assert.equal(liveTurns.length, 2);
  assert.deepEqual(liveTurns.map((m) => m.seq), [1, 2]);

  sent.length = 0;
  const replayed = binder.replayTurnsSince('device-token-1234567890', 1);
  assert.equal(replayed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].seq, 2);
  assert.equal(sent[0].deviceToken, 'device-token-1234567890');
  assert.equal(sent[0].content, 'second reply');

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'mobile-turn-history.json'), 'utf8'));
  assert.equal(persisted.globalSeq, 2);
  assert.deepEqual(persisted.turns.map((t) => t.seq), [1, 2]);
});

test('SessionBinder codex ready probe waits for TUI prompt, not merely word codex', async () => {
  const dir = tmpDir();
  const { binder, writes, setBuffer } = makeBinder(dir);
  setBuffer('PS C:\\repo> codex --dangerously-bypass-approvals-and-sandbox');
  binder._writeWhenReady('mobile-codex', 'hello', 'codex', Date.now() + 1000);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(writes.length, 0, 'launch command text must not be treated as ready');

  setBuffer('Welcome\nSend a message');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(writes[0].sessionId, 'mobile-codex');
  assert.equal(writes[0].data, 'hello');
});
