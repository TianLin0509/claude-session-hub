'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PromptSubmissionReceipts } = require('../core/prompt-submission-receipts');

test('late matching receipt corrects timeout and duplicate receipt is idempotent', () => {
  const updates = [];
  const receipts = new PromptSubmissionReceipts(update => updates.push(update));
  const attempt = receipts.begin('s', 'a', '你好\r\n世界', 100);
  receipts.finish(attempt, { ok: true, sendStatus: 'stuck' });
  assert.equal(attempt.status, 'unconfirmed');
  assert.equal(receipts.observe({ sessionId: 's', text: '你好\n世界', submittedAt: 110, turnId: 't' }), true);
  assert.equal(attempt.status, 'confirmed');
  receipts.finish(attempt, { ok: false, error: 'late-ipc-error' });
  assert.equal(attempt.status, 'confirmed');
  assert.equal(receipts.observe({ sessionId: 's', text: '你好\n世界', submittedAt: 110, turnId: 't' }), false);
  assert.equal(updates.filter(x => x.status === 'confirmed').length, 1);
});

test('old turn, other session, task start without text and different prompt cannot confirm a send', () => {
  const receipts = new PromptSubmissionReceipts();
  const attempt = receipts.begin('s', 'a', 'new prompt', 100);
  for (const event of [
    { sessionId: 's', text: 'new prompt', submittedAt: 99 },
    { sessionId: 'other', text: 'new prompt', submittedAt: 110 },
    { sessionId: 's', submittedAt: 110, turnId: 'auto-goal' },
    { sessionId: 's', text: 'previous prompt', submittedAt: 110 },
  ]) assert.equal(receipts.observe(event), false);
  assert.equal(attempt.status, 'pending');
});

test('late A cannot acknowledge B; duplicate native turn cannot confirm repeated same text', () => {
  const receipts = new PromptSubmissionReceipts();
  receipts.begin('s', 'a', 'A', 100);
  const b = receipts.begin('s', 'b', 'B', 200);
  assert.equal(receipts.observe({ sessionId: 's', text: 'A', submittedAt: 210, turnId: 'ta' }), true);
  assert.equal(b.status, 'pending');
  receipts.observe({ sessionId: 's', text: 'B', submittedAt: 220, turnId: 'tb' });
  const c = receipts.begin('s', 'c', 'B', 300);
  assert.equal(receipts.observe({ sessionId: 's', text: 'B', submittedAt: 310, turnId: 'tb' }), false);
  assert.equal(c.status, 'pending');
  assert.equal(receipts.observe({ sessionId: 's', text: 'B', submittedAt: 320, turnId: 'tc' }), true);
});

test('first late Claude receipt for identical A/B text belongs to A, not B', () => {
  const receipts = new PromptSubmissionReceipts();
  const a = receipts.begin('s', 'a', '继续', 100);
  receipts.finish(a, { ok: true, sendStatus: 'stuck' });
  const b = receipts.begin('s', 'b', '继续', 200);
  receipts.observe({ sessionId: 's', text: '继续', observedAt: 210,
    turnId: 'turn-a', signalSource: 'claude-user-prompt-submit' });
  assert.equal(a.status, 'confirmed');
  assert.equal(b.status, 'pending');
  receipts.observe({ sessionId: 's', text: '继续', observedAt: 220,
    turnId: 'turn-b', signalSource: 'claude-user-prompt-submit' });
  assert.equal(b.status, 'confirmed');
});

test('automatic goal update is not a user-message receipt', () => {
  const receipts = new PromptSubmissionReceipts();
  const a = receipts.begin('s', 'a', 'same objective', 100);
  assert.equal(receipts.observe({ sessionId: 's', text: 'same objective', submittedAt: 110,
    signalSource: 'thread_goal_updated' }), false);
  assert.equal(a.status, 'pending');
});

test('observed real 100-line Codex record missing one LF raises integrity warning, not success', () => {
  const expected = `${Array.from({ length: 100 }, (_, i) => `材料第 ${i + 1} 行：用于验证多行中文消息已提交。`).join('\n')}\n只回复 RECEIPT_LONG_OK，不调用工具。`;
  const actual = expected.replace('已提交。\n材料第 4 行', '已提交。材料第 4 行');
  assert.equal(actual.length, expected.length - 1);
  const updates = [];
  const receipts = new PromptSubmissionReceipts(e => updates.push(e));
  const a = receipts.begin('s', 'a', expected, 100);
  receipts.observe({ sessionId: 's', text: actual, submittedAt: 110,
    turnId: 'native-altered-turn', signalSource: 'item_completed_user_message' });
  assert.equal(a.status, 'content-mismatch');
  assert.equal(a.started, false);
  assert.equal(a.resolved, true);
  receipts.finish(a, { ok: true, sendStatus: 'stuck' });
  assert.equal(a.status, 'content-mismatch');
  assert.equal(updates.some(e => e.status === 'confirmed'), false);
});

test('different non-whitespace content remains unconfirmed', () => {
  const receipts = new PromptSubmissionReceipts();
  const a = receipts.begin('s', 'a', 'delete A\nkeep B', 100);
  assert.equal(receipts.observe({ sessionId: 's', text: 'delete A\ndelete B', submittedAt: 110 }), false);
  assert.equal(a.status, 'pending');
});

test('close drops retained prompt and receipt; public updates never contain prompt text', () => {
  const updates = [];
  const receipts = new PromptSubmissionReceipts(u => updates.push(u));
  const a = receipts.begin('s', 'a', 'PRIVATE PROMPT', 100);
  receipts.finish(a, { ok: true, sendStatus: 'stuck' });
  assert.ok(!JSON.stringify(updates).includes('PRIVATE PROMPT'));
  receipts.prune(() => false);
  assert.equal(receipts.get('s'), null);
});
