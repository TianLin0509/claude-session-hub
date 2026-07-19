'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { _appendWorkflowStepPrompt } = require('../main/groupchat/dispatcher.js');

test('serial step prompt is appended only for the addressed member', () => {
  const meeting = {
    serialWorkflow: {
      stepPrompts: [
        { m1: '先输出方案与验收标准。', m2: '不应给 m1。' },
        { m2: '批判性优化并执行落地。' },
      ],
    },
  };

  const claude = _appendWorkflowStepPrompt('BASE', meeting, 0, 'm1');
  const codex = _appendWorkflowStepPrompt('BASE', meeting, 1, 'm2');
  const unrelated = _appendWorkflowStepPrompt('BASE', meeting, 0, 'm3');

  assert.match(claude, /^BASE\n\n## 串行工作流：本步骤追加要求/);
  assert.ok(claude.includes('先输出方案与验收标准。'));
  assert.ok(!claude.includes('不应给 m1。'));
  assert.ok(codex.includes('批判性优化并执行落地。'));
  assert.strictEqual(unrelated, 'BASE');
});

test('serial step prompt is bounded and ignores invalid values', () => {
  assert.strictEqual(_appendWorkflowStepPrompt('BASE', {}, 0, 'm1'), 'BASE');
  const meeting = { serialWorkflow: { stepPrompts: [{ m1: 'x'.repeat(20_000) }] } };
  const result = _appendWorkflowStepPrompt('BASE', meeting, 0, 'm1');
  assert.ok(result.length < 13_000, '追加 prompt 必须有长度上限');
});
