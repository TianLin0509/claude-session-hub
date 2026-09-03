'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compatibleEffort,
  modelSelectionMatches,
  parseCodexModelPicker,
  parseCodexReasoningPicker,
  pickerNavigationInput,
  terminalAcceptsModelCommand,
} = require('../renderer/model-ui.js');

test('Codex model picker parser finds provider-owned row numbers and current selection', () => {
  const parsed = parseCodexModelPicker(`
  Select Model and Effort
› 1. gpt-5.6-sol (current)  Reliable workhorse
  2. gpt-5.6-terra          Balanced model
  3. gpt-5.6-luna           Fast model
  4. gpt-5.5                Previous generation
  Press enter to confirm or esc to go back
  `);
  assert.ok(parsed);
  assert.equal(parsed.highlighted.value, 'gpt-5.6-sol');
  assert.equal(parsed.entries.find(entry => entry.value === 'gpt-5.5').number, 4);
  assert.equal(pickerNavigationInput(1, 4), '\x1b[B\x1b[B\x1b[B');
});

test('Codex effort picker preserves effort or chooses the highest compatible downgrade', () => {
  const parsed = parseCodexReasoningPicker(`
  Select Reasoning Level for gpt-5.5
  1. Low               Fast responses
› 2. Medium (default)  Balanced
  3. High              Greater reasoning
  4. Extra high        Deepest available
  `, 'gpt-5.5');
  assert.ok(parsed);
  assert.equal(compatibleEffort('low', parsed.entries, parsed.highlighted), 'low');
  assert.equal(compatibleEffort('max', parsed.entries, parsed.highlighted), 'xhigh');
  assert.equal(pickerNavigationInput(2, 4), '\x1b[B\x1b[B');
});

test('Claude latest aliases match the exact model reported by statusline', () => {
  assert.equal(modelSelectionMatches('claude-fable-5-1[1m]', 'fable'), true);
  assert.equal(modelSelectionMatches('claude-opus-5', 'opus'), true);
  assert.equal(modelSelectionMatches('claude-sonnet-5', 'fable'), false);
  assert.equal(modelSelectionMatches('claude-fable-5-1', 'claude-fable-5-1[1m]'), true);
});

test('model switching refuses to overwrite an unsent native TUI draft', () => {
  assert.equal(terminalAcceptsModelCommand('› Ask Codex to do anything', 'codex-picker'), true);
  assert.equal(terminalAcceptsModelCommand('› unfinished draft', 'codex-picker'), false);
  assert.equal(terminalAcceptsModelCommand('❯\u00a0\n────────', 'claude-inline'), true);
  assert.equal(terminalAcceptsModelCommand('❯ Try "fix typecheck errors"', 'claude-inline'), true);
  assert.equal(terminalAcceptsModelCommand('❯ unfinished draft', 'claude-inline'), false);
});
