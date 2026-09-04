'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const watcher = require('../core/group-chat-watcher.js');

function harness({ acknowledgeOnEnter = 2 } = {}) {
  const transcriptTap = new EventEmitter();
  const writes = [];
  let activity = 0;
  let enterCount = 0;
  const sessionManager = {
    getSession: () => ({ id: 'agent-session', transcriptKind: 'codex', kind: 'codex', cwd: process.cwd() }),
    getGroupChatReady: () => true,
    setGroupChatReady() {},
    getGroupChatLastActivity: () => activity,
    getSessionBuffer: () => '',
    writeToSession(sid, data) {
      writes.push({ sid, data });
      activity += 1;
      if (data === '\r') {
        enterCount += 1;
        if (enterCount === acknowledgeOnEnter) {
          setImmediate(() => transcriptTap.emit('turn-started', { hubSessionId: sid, turnId: 'turn-ack' }));
        }
      }
    },
  };
  watcher.init({
    sessionManager,
    transcriptTap,
    cliReadyDetector: { isReady: () => true },
    codexTurnStartAckMs: 20,
    codexTurnStartRecoveryMs: 30,
  });
  return { sessionManager, transcriptTap, writes, get enterCount() { return enterCount; } };
}

test('Codex paste sends a late isolated Enter only when task_started is still absent', async () => {
  const state = harness({ acknowledgeOnEnter: 2 });
  const result = await watcher.sendToPty('agent-session', 'agent prompt', 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.sendStatus, 'auto_recovered');
  assert.equal(result.enterAttempts, 2);
  assert.equal(state.enterCount, 2, 'one initial Enter plus one conditional recovery Enter');
  assert.equal(state.transcriptTap.listenerCount('turn-started'), 0, 'ack listener must be removed');
});

test('Codex paste reports stuck when no provider turn ever acknowledges the prompt', async () => {
  const state = harness({ acknowledgeOnEnter: Number.POSITIVE_INFINITY });
  const result = await watcher.sendToPty('agent-session', 'agent prompt', 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.sendStatus, 'stuck');
  assert.equal(result.enterAttempts, 2);
  assert.equal(state.enterCount, 2, 'one initial attempt and one bounded late recovery');
  assert.equal(state.transcriptTap.listenerCount('turn-started'), 0, 'failed ack listener must be removed');
});

test('Claude paste uses the shared main-process lifecycle signal before retrying Enter', async () => {
  const sessionManager = new EventEmitter();
  const transcriptTap = new EventEmitter();
  let enterCount = 0;
  let activity = 0;
  Object.assign(sessionManager, {
    getSession: () => ({ id: 'claude-session', transcriptKind: 'claude', kind: 'claude' }),
    getGroupChatReady: () => true,
    setGroupChatReady() {},
    getGroupChatLastActivity: () => activity,
    getSessionBuffer: () => '',
    getAgentTurnStartSeq: () => 0,
    writeToSession(sid, data) {
      activity += 1;
      if (data === '\r') {
        enterCount += 1;
        if (enterCount === 2) {
          setImmediate(() => sessionManager.emit('agent-turn-started', {
            sessionId: sid,
            seq: 1,
            signalSource: 'claude-user-prompt-submit',
          }));
        }
      }
    },
  });
  watcher.init({
    sessionManager,
    transcriptTap,
    cliReadyDetector: { isReady: () => true },
    agentTurnStartAckMs: 20,
    agentTurnStartRecoveryMs: 30,
  });
  const result = await watcher.sendToPty('claude-session', 'long Claude prompt', 'claude');
  assert.equal(result.sendStatus, 'auto_recovered');
  assert.equal(result.acknowledgementSource, 'claude-user-prompt-submit');
  assert.equal(result.enterAttempts, 2);
  assert.equal(enterCount, 2);
  assert.equal(sessionManager.listenerCount('agent-turn-started'), 0);
  assert.equal(sessionManager.listenerCount('output'), 0);
});

test('strong two-frame Codex PTY runtime confirms work before a delayed rollout event', async () => {
  const sessionManager = new EventEmitter();
  const transcriptTap = new EventEmitter();
  let buffer = '';
  let activity = 0;
  let enterCount = 0;
  Object.assign(sessionManager, {
    getSession: () => ({ id: 'pty-ack', transcriptKind: 'codex', kind: 'codex' }),
    getGroupChatReady: () => true,
    setGroupChatReady() {},
    getGroupChatLastActivity: () => activity,
    getSessionBuffer: () => buffer,
    getAgentTurnStartSeq: () => 0,
    writeToSession(_sid, data) {
      activity += 1;
      if (data !== '\r') return;
      enterCount += 1;
      buffer += '\n• Working on request · esc to interrupt';
      setTimeout(() => {
        buffer += '\n⏺ Working on request · esc to interrupt';
        activity += 1;
      }, 240);
    },
  });
  watcher.init({
    sessionManager,
    transcriptTap,
    cliReadyDetector: { isReady: () => true },
    bracketedPasteSettleMs: 1,
    agentTurnStartAckMs: 800,
    agentTurnStartRecoveryMs: 20,
  });
  const result = await watcher.sendToPty('pty-ack', 'long prompt', 'codex');
  assert.equal(result.sendStatus, 'ok');
  assert.equal(result.enterAttempts, 1);
  assert.match(result.acknowledgementSource, /^pty-codex-interrupt-footer$/);
  assert.equal(enterCount, 1);
  assert.equal(sessionManager.listenerCount('output'), 0);
});

test('long-prompt submit watchdog survives 80 mixed first/second-Enter acknowledgements without leaks', async () => {
  const sessionManager = new EventEmitter();
  const transcriptTap = new EventEmitter();
  sessionManager.setMaxListeners(0);
  transcriptTap.setMaxListeners(0);
  const activity = new Map();
  const sequences = new Map();
  const enters = new Map();
  const writes = new Map();
  Object.assign(sessionManager, {
    getSession: sid => ({ id: sid, transcriptKind: 'codex', kind: 'codex', cwd: process.cwd() }),
    getGroupChatReady: () => true,
    setGroupChatReady() {},
    getGroupChatLastActivity: sid => activity.get(sid) || 0,
    getSessionBuffer: () => '',
    getAgentTurnStartSeq: sid => sequences.get(sid) || 0,
    writeToSession(sid, data) {
      activity.set(sid, (activity.get(sid) || 0) + 1);
      if (!writes.has(sid)) writes.set(sid, []);
      writes.get(sid).push(data);
      if (data !== '\r') return;
      const count = (enters.get(sid) || 0) + 1;
      enters.set(sid, count);
      const index = Number(sid.split('-').pop());
      const required = index % 2 === 0 ? 1 : 2;
      if (count === required) {
        const seq = (sequences.get(sid) || 0) + 1;
        sequences.set(sid, seq);
        setImmediate(() => sessionManager.emit('agent-turn-started', {
          sessionId: sid,
          seq,
          signalSource: 'task_started',
        }));
      }
    },
  });
  watcher.init({
    sessionManager,
    transcriptTap,
    cliReadyDetector: { isReady: () => true },
    bracketedPasteSettleMs: 1,
    agentTurnStartAckMs: 5,
    agentTurnStartRecoveryMs: 10,
  });
  const prompt = Array.from({ length: 600 }, (_v, i) => `第 ${i + 1} 行：长提示完整性校验 ${'x'.repeat(40)}`).join('\n');
  const results = await Promise.all(Array.from({ length: 80 }, (_v, i) =>
    watcher.sendToPty(`stress-${i}`, prompt, 'codex')));
  assert.equal(results.filter(result => result.sendStatus === 'stuck').length, 0);
  assert.equal(results.filter(result => result.sendStatus === 'auto_recovered').length, 40);
  for (let i = 0; i < 80; i += 1) {
    const sid = `stress-${i}`;
    assert.equal(enters.get(sid), i % 2 === 0 ? 1 : 2, sid);
    // 长 payload 现在是分块投喂的（core/pty-prompt-submit.js），所以不能再指望
    //   "某一次 write 里含完整 prompt"。改成把提交信号以外的写入重组回来校验：
    //   既确认分块无损，也确认 BP 帧头尾完整、prompt 一字不差。
    const pasted = writes.get(sid).filter(data => !['\r', '\n', '\r\n', '\x15'].includes(data)).join('');
    assert.ok(pasted.startsWith('\x1b[200~') && pasted.endsWith('\x1b[201~'), `bracketed paste frame broken for ${sid}`);
    assert.equal(pasted.slice('\x1b[200~'.length, -'\x1b[201~'.length), prompt, `chunked prompt not byte-identical for ${sid}`);
    assert.ok(writes.get(sid).length > 2, `long prompt should be chunked for ${sid}`);
  }
  assert.equal(sessionManager.listenerCount('agent-turn-started'), 0);
  assert.equal(sessionManager.listenerCount('output'), 0);
  assert.equal(transcriptTap.listenerCount('turn-started'), 0);
});
