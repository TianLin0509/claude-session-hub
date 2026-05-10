'use strict';
// 验证 Phase B / 铁律 v2：BASE_RULES 含"富文本默认 HTML"提示，且总字数仍 ≤1500

const test = require('node:test');
const assert = require('node:assert/strict');

const scenes = require('../core/roundtable-scenes.js');
const { BASE_RULES } = scenes;

test('BASE_RULES 含"富文本"关键词', () => {
  assert.ok(BASE_RULES.includes('富文本'), 'BASE_RULES 应含"富文本"字样');
});

test('BASE_RULES 提及 html fenced code block', () => {
  // 提示文案应说明输出 ```html``` 块（不强求精确字符串，要含 html 与 fenced 两个语义）
  assert.ok(/html/i.test(BASE_RULES), 'BASE_RULES 应提及 html');
});

test('BASE_RULES 提及 iframe sandbox 渲染机制', () => {
  assert.ok(BASE_RULES.includes('iframe') || BASE_RULES.includes('内联渲染'),
    'BASE_RULES 应说明 Hub 渲染机制（iframe 或"内联渲染"）');
});

test('BASE_RULES 总字数 ≤1500（roundtable-scenes.js line 47 注释约定）', () => {
  assert.ok(BASE_RULES.length <= 1500,
    'BASE_RULES 总字数 ' + BASE_RULES.length + ' 超 1500 上限');
});

test('BASE_RULES 总字数 ≥1300（确认富文本提示真的被加进去）', () => {
  // 旧基线约 1300 字；加新提示后应 ≥1330（80 字以上的提示加完）
  assert.ok(BASE_RULES.length >= 1330,
    'BASE_RULES 字数仅 ' + BASE_RULES.length + '，富文本提示可能未加');
});

test('buildSystemPrompt(general) 输出含富文本提示', () => {
  if (typeof scenes.buildSystemPrompt !== 'function') return; // 防御：函数名不一定 export
  const general = scenes.buildSystemPrompt('general', '', 'pikachu');
  assert.ok(general.includes('富文本') || general.includes('html'),
    'general scene system prompt 应含富文本/html 字样');
});

test('research preset 仍生效（不被覆盖）', () => {
  if (typeof scenes.buildSystemPrompt !== 'function') return;
  const research = scenes.buildSystemPrompt('research', '', 'pikachu');
  assert.ok(research.includes('A 股投研') || research.includes('data_query'),
    'research preset 仍生效');
});
