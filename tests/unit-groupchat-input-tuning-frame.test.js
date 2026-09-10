'use strict';
const assert = require('node:assert/strict');
const { groupInputTuningFrame } = require('../renderer/meeting-room');
const { parseCodexModelPicker, parseCodexReasoningPicker, terminalAcceptsModelCommand } = require('../renderer/model-ui');

// Excerpt from the real never-opened Codex 0.153.4 member frame. The old model
// menu remained above the reasoning menu; reading its cursor selected low when
// the user chose xhigh. Keep both highlighted rows in this regression fixture.
const model = `  Select Model and Effort
  Access legacy models by running codex -m <model_name> or in your config.toml

› 1. gpt-6-astra (current)  Our most capable model for complex, demanding work.
  2. gpt-5.6-sol            Reliable agentic workhorse for everyday tasks.
  3. gpt-5.6-terra          Balanced agentic coding model for everyday work.`;
const reasoning = `  Select Reasoning Level for gpt-6-astra

  1. Low               Fast responses with lighter reasoning
  2. Medium (default)  Balances speed and reasoning depth for everyday tasks
› 3. High (current)    Greater reasoning depth for complex problems
  4. Extra high        Extra high reasoning depth for complex problems`;
const mixed = model + '\n\n' + reasoning;
assert.equal(parseCodexReasoningPicker(mixed, 'gpt-6-astra').cursor.number, 1, 'fixture reproduces the old wrong cursor');
const current = groupInputTuningFrame(mixed);
assert.equal(parseCodexReasoningPicker(current, 'gpt-6-astra').cursor.number, 3);
assert.equal(parseCodexModelPicker(current), null, 'previous panel cannot satisfy the next wait');
const confirmed = '• Model changed to gpt-6-astra low\n\n› Ask Codex to do anything\n\n  gpt-6-astra low · work';
const closed = groupInputTuningFrame(mixed + '\n\n' + confirmed);
assert.equal(closed, confirmed, 'retain exact observed confirmation, even a wrong target');
assert.equal(parseCodexReasoningPicker(closed), null);
assert.equal(terminalAcceptsModelCommand(closed, 'codex-picker'), true);
assert.equal(groupInputTuningFrame(mixed + '\n› /model\nfooter'), '› /model\nfooter');
assert.equal(groupInputTuningFrame(confirmed + '\n' + model), model);
assert.equal(groupInputTuningFrame('❯ 用户未发送的草稿\nfooter'), '❯ 用户未发送的草稿\nfooter');
assert.equal(groupInputTuningFrame('› 真实草稿\nfooter'), '› 真实草稿\nfooter');
// B1: real Codex 0.153.4 ultra frame from the review's two isolated runs.
// Ultra changes the empty prompt glyph to » after the advanced panel closes.
const ultra = `  Advanced Reasoning
  ⚠ Consumes usage limits faster

› 1. Max    For difficult problems when quality matters more than speed · higher
 usage
  2. Ultra  For demanding work using multiple agents · highest usage

  Press enter to confirm or esc to go back

• Model changed to gpt-5.6-sol ultra for this conversation


» Ask Codex to do anything

  gpt-5.6-sol ultra · work`;
const ultraFrame = groupInputTuningFrame(ultra);
assert.equal(terminalAcceptsModelCommand(ultraFrame, 'codex-picker'), true,
  'B1: the real ultra empty prompt must allow switching back');
assert.equal(ultraFrame.startsWith('• Model changed to gpt-5.6-sol ultra'), true,
  'closed advanced menu is discarded while retaining the actual confirmation');
for (const draft of ['真实草稿', '/model', 'Ask Codex to do anything extra']) {
  const screen = ultra.replace('» Ask Codex to do anything', `» ${draft}`);
  assert.equal(terminalAcceptsModelCommand(groupInputTuningFrame(screen), 'codex-picker'), false,
    'ultra draft must not be mistaken for its earlier empty prompt');
  assert.equal(groupInputTuningFrame(screen).includes(`› ${draft}`), true,
    'normalize only the glyph, preserving every draft character');
}
assert.equal(terminalAcceptsModelCommand(groupInputTuningFrame('› Ask Codex to do anything\n» 草稿'), 'codex-picker'), false);
assert.equal(terminalAcceptsModelCommand(groupInputTuningFrame('» Ask Codex to do anything\nfooter'), 'codex-picker'), true);
assert.equal(groupInputTuningFrame('正文里的 » 必须保留'), '正文里的 » 必须保留');
console.log('groupchat input tuning frame: real stale-panel regression and prompt preservation passed');
