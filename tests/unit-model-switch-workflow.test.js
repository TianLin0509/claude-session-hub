'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compatibleEffort,
  modelSelectionMatches,
  parseCodexAdvancedReasoningPicker,
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

// ── 2026-09-07 评审实测的真实面板（原样抓自 Codex v0.153.4 / gpt-6-astra）──
// 当前档位是 max 时，一级面板高亮的是「More reasoning…」这一行；它不是档位，
// 而是通往 Max / Ultra 的二级菜单入口。旧实现把它过滤掉之后又拿"第一个能认出
// 档位的行"当光标，于是方向键从 Low 开始数 —— 点 high 实际走到了 medium。
const REAL_LEVEL_ONE = `
  Select Reasoning Level for gpt-6-astra
  1. Low                        Fast responses with lighter reasoning
  2. Medium (default)           Balances speed and reasoning depth for everyday tasks
  3. High                       Greater reasoning depth for complex problems
  4. Extra high                 Extra high reasoning depth for complex problems
› 5. More reasoning… (current)  Max and Ultra consume usage limits faster
  Press enter to confirm or esc to go back
`;

const REAL_LEVEL_TWO = `
  Advanced Reasoning
  ⚠ Consumes usage limits faster
› 1. Max (current)  For difficult problems when quality matters more than speed · higher usage
  2. Ultra          For demanding work using multiple agents · highest usage
  Press enter to confirm or esc to go back
`;

test('推理面板的光标行从原始行读，不会被"认不出档位的行"带偏', () => {
  const parsed = parseCodexReasoningPicker(REAL_LEVEL_ONE, 'gpt-6-astra');
  assert.ok(parsed);
  // 光标真的在第 5 行
  assert.equal(parsed.cursor.number, 5);
  // 第 5 行是二级菜单入口，不能被当成档位
  assert.equal(parsed.entries.length, 4);
  assert.ok(!parsed.entries.some(entry => entry.number === 5));
  assert.equal(parsed.advancedRow.number, 5);
  // 从第 5 行去 high（第 3 行）必须是向上两格；旧实现从第 1 行出发向下两格，
  // 落在 medium 上 —— 这正是评审复现的现象。
  const high = parsed.entries.find(entry => entry.value === 'high');
  assert.equal(pickerNavigationInput(parsed.cursor.number, high.number), '\x1b[A\x1b[A');
  assert.notEqual(pickerNavigationInput(parsed.cursor.number, high.number), '\x1b[B\x1b[B');
});

test('max / ultra 在二级面板上，且带 (current) 后缀也能认出来', () => {
  const advanced = parseCodexAdvancedReasoningPicker(REAL_LEVEL_TWO);
  assert.ok(advanced);
  assert.deepEqual(advanced.entries.map(entry => entry.value), ['max', 'ultra']);
  assert.equal(advanced.cursor.number, 1);
  const ultra = advanced.entries.find(entry => entry.value === 'ultra');
  assert.equal(pickerNavigationInput(advanced.cursor.number, ultra.number), '\x1b[B');
  // 一级面板上没有 max / ultra，不能假装有
  const level1 = parseCodexReasoningPicker(REAL_LEVEL_ONE, 'gpt-6-astra');
  assert.ok(!level1.entries.some(entry => entry.value === 'max' || entry.value === 'ultra'));
});

test('二级面板不是推理面板，一级面板也不是二级面板', () => {
  assert.equal(parseCodexAdvancedReasoningPicker(REAL_LEVEL_ONE), null);
  assert.equal(parseCodexReasoningPicker(REAL_LEVEL_TWO, ''), null);
});

test('模型面板同样按原始光标行导航', () => {
  const parsed = parseCodexModelPicker(`
  Select Model and Effort
  1. gpt-6-astra    Newest
  2. gpt-5.6-sol    Reliable workhorse
› 3. gpt-5.5        Previous generation
  `);
  assert.equal(parsed.cursor.number, 3);
  assert.equal(pickerNavigationInput(parsed.cursor.number, 1), '\x1b[A\x1b[A');
});
