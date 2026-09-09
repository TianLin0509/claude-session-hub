'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const watcher = require('../core/group-chat-watcher');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');

test('a real IPC timeout is corrected by late transcript receipt, and resend then writes nothing', async () => {
  const original = watcher.sendToPty;
  let writes = 0;
  watcher.sendToPty = async () => { writes++; return { ok: true, sendStatus: 'stuck' }; };
  const handlers = new Map();
  const tap = new EventEmitter();
  const sm = new EventEmitter();
  sm.getSession = () => ({ kind: 'codex' });
  const events = [];
  const registration = registerPromptSubmitIpc({ handle: (k, v) => handlers.set(k, v) }, {
    sessionManager: sm, transcriptTap: tap, sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    logger: { warn() {} },
  });
  try {
    const request = { sessionId: 's', text: 'late receipt prompt', clientSubmissionId: 'a' };
    await handlers.get('session:send-prompt')(null, request);
    tap.emit('prompt-submitted', { hubSessionId: 's', text: request.text, submittedAt: Date.now(), turnId: 't' });
    assert.equal(events.at(-1)?.payload.status, 'confirmed');
    const resend = await handlers.get('session:resend-prompt')(null, request);
    assert.equal(resend.mode, 'already-submitted');
    assert.equal(writes, 1);
  } finally { watcher.sendToPty = original; registration.dispose?.(); }
});

test('tracked send acknowledges matching user message without task_started; old work cannot confirm it', async () => {
  const handlers = new Map();
  const tap = new EventEmitter();
  const sm = new EventEmitter();
  let enters = 0;
  const prompt = 'only this new prompt';
  Object.assign(sm, {
    getSession: () => ({ kind: 'codex' }), getGroupChatReady: () => true,
    getSessionBuffer: () => '', getGroupChatLastActivity: () => 0,
    getAgentTurnStartSeq: () => 0,
    writeToSession(sid, data) {
      if (data !== '\r') return;
      enters++;
      // A previous turn's automatic continuation is insufficient evidence.
      sm.emit('agent-turn-started', { sessionId: sid, seq: 1, turnId: 'old-auto' });
      tap.emit('prompt-submitted', { hubSessionId: sid, text: 'old prompt', submittedAt: Date.now() });
      setTimeout(() => tap.emit('prompt-submitted', {
        hubSessionId: sid, text: prompt, submittedAt: Date.now(), turnId: 'new',
      }), 25);
    },
  });
  watcher.init({ sessionManager: sm, transcriptTap: tap, bracketedPasteSettleMs: 5,
    agentTurnStartAckMs: 120, agentTurnStartRecoveryMs: 40 });
  const events = [];
  const registration = registerPromptSubmitIpc({ handle: (k, v) => handlers.set(k, v) }, {
    sessionManager: sm, transcriptTap: tap, sendToRenderer: (_channel, payload) => events.push(payload),
  });
  try {
    const result = await handlers.get('session:send-prompt')(null, {
      sessionId: 's', text: prompt, clientSubmissionId: 'new-send',
    });
    assert.equal(result.receipt.status, 'confirmed');
    assert.equal(result.receipt.turnId, 'new');
    assert.equal(enters, 1);
    assert.equal(events.filter(e => e.status === 'confirmed').length, 1);
  } finally { registration.dispose(); }
});

test('Claude prompt hook corrects receipt; unrelated tool/start events do not', async () => {
  const original = watcher.sendToPty;
  watcher.sendToPty = async () => ({ ok: true, sendStatus: 'stuck' });
  const handlers = new Map();
  const sm = new EventEmitter();
  sm.getSession = () => ({ kind: 'claude' });
  const events = [];
  const registration = registerPromptSubmitIpc({ handle: (k, v) => handlers.set(k, v) }, {
    sessionManager: sm, sendToRenderer: (_channel, payload) => events.push(payload), logger: { warn() {} },
  });
  try {
    await handlers.get('session:send-prompt')(null, { sessionId: 'c', text: 'Claude message', clientSubmissionId: 'c1' });
    sm.emit('agent-turn-started', { sessionId: 'c', observedAt: Date.now(), signalSource: 'tool-start', prompt: 'Claude message' });
    assert.equal(events.at(-1).status, 'unconfirmed');
    sm.emit('agent-turn-started', { sessionId: 'c', observedAt: Date.now(),
      signalSource: 'claude-user-prompt-submit', prompt: 'Claude message', turnId: 'ct' });
    assert.equal(events.at(-1).status, 'confirmed');
  } finally { watcher.sendToPty = original; registration.dispose(); }
});

test('tracked Claude retry submits the existing input once and never pastes a second copy', async () => {
  const handlers = new Map();
  const sm = new EventEmitter();
  let input = '', screen = '', retryAllowed = false, enters = 0, pastes = 0;
  const submitted = [];
  const render = () => {
    screen = `\x1b[2J\x1b[30;1H❯ ${input}`;
    sm.emit('output', { sessionId: 'c', data: screen });
  };
  Object.assign(sm, {
    getSession: () => ({ kind: 'claude' }), getGroupChatReady: () => true,
    getSessionBuffer: () => screen, getGroupChatLastActivity: () => 0,
    getAgentTurnStartSeq: () => 0,
    writeToSession(sid, data) {
      if (data.startsWith('\x1b[200~')) {
        pastes++; input += data.slice(6, -6); render();
      }
      if (data !== '\r') return;
      enters++;
      if (!retryAllowed) return;
      submitted.push(input);
      sm.emit('agent-turn-started', { sessionId: sid, observedAt: Date.now(),
        signalSource: 'claude-user-prompt-submit', prompt: input, turnId: 'only-turn' });
      input = ''; render();
    },
  });
  watcher.init({ sessionManager: sm, bracketedPasteSettleMs: 5,
    agentTurnStartAckMs: 20, agentTurnStartRecoveryMs: 20, agentTurnStartRetryMax: 0 });
  const registration = registerPromptSubmitIpc({ handle: (k, v) => handlers.set(k, v) }, {
    sessionManager: sm, logger: { warn() {} },
  });
  try {
    const request = { sessionId: 'c', text: 'CHECK ONE COPY', clientSubmissionId: 'retry-one' };
    const initial = await handlers.get('session:send-prompt')(null, request);
    assert.equal(initial.sendStatus, 'stuck');
    retryAllowed = true;
    const retried = await handlers.get('session:resend-prompt')(null, request);
    assert.equal(retried.ok, true);
    assert.equal(retried.mode, 'enter_only');
    assert.deepEqual(submitted, ['CHECK ONE COPY']);
    assert.equal(pastes, 1);
    assert.equal(enters, 2);
  } finally { registration.dispose(); }
});

test('tracked retry cannot rewrite when original input is absent or uncertain', async () => {
  const { PromptSubmissionReceipts } = require('../core/prompt-submission-receipts');
  const sm = new EventEmitter();
  let writes = 0;
  sm.getSession = () => ({ kind: 'claude' });
  sm.getSessionBuffer = () => '\x1b[2J\x1b[1;1HPrevious answer mentions CHECK ONE COPY\x1b[30;1H❯ ';
  sm.writeToSession = () => { writes++; };
  watcher.init({ sessionManager: sm });
  const receipt = new PromptSubmissionReceipts().begin('c', 'a', 'CHECK ONE COPY');
  const result = await watcher.resendCurrentPrompt({ sid: 'c', kind: 'claude', prompt: 'CHECK ONE COPY',
    promptHeader: 'CHECK ONE COPY', submissionReceipt: receipt });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'input-state-unconfirmed');
  assert.equal(writes, 0);
});

test('retry ignores historical prompt echoes, edited drafts and hidden multiline paste', async () => {
  const { PromptSubmissionReceipts } = require('../core/prompt-submission-receipts');
  for (const screen of [
    '\x1b[2J\x1b[25;1H❯ CHECK ONE COPY\x1b[26;1HCompleted answer\x1b[30;1H❯ DIFFERENT UNSENT DRAFT',
    '\x1b[2J\x1b[30;1H❯ CHECK ONE COPY changed',
    '\x1b[2J\x1b[29;1H❯ CHECK ONE COPY\x1b[30;1Hadditional unsent text',
    '\x1b[2J\x1b[30;1H❯ [Pasted text #1 +120 lines]',
  ]) {
    const sm = new EventEmitter();
    let writes = 0;
    sm.getSession = () => ({ kind: 'claude' });
    sm.getSessionBuffer = () => screen;
    sm.writeToSession = () => { writes++; };
    watcher.init({ sessionManager: sm });
    const receipt = new PromptSubmissionReceipts().begin('c', 'a', 'CHECK ONE COPY');
    const result = await watcher.resendCurrentPrompt({ sid: 'c', kind: 'claude', prompt: 'CHECK ONE COPY',
      promptHeader: 'CHECK ONE COPY', submissionReceipt: receipt });
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
  }
});
