'use strict';
// 验证 Phase B / 铁律 v3：BASE_RULES 引导 AI 写 .html 文件 + 报路径，不在对话内嵌 html fenced 块

const test = require('node:test');
const assert = require('node:assert/strict');

const scenes = require('../core/roundtable-scenes.js');
const { BASE_RULES } = scenes;

test('BASE_RULES 含"富文本"关键词', () => {
  assert.ok(BASE_RULES.includes('富文本'), 'BASE_RULES 应含"富文本"字样');
});

test('BASE_RULES 引导 AI 写 .html 文件（v3 行为）', () => {
  assert.ok(BASE_RULES.includes('.html 文件') || BASE_RULES.includes('.html'),
    'BASE_RULES 应提及 .html 文件');
  assert.ok(BASE_RULES.includes('artifacts'),
    'BASE_RULES 应给出 artifacts 路径关键字');
});

test('BASE_RULES 含 v3 反向规则（不内嵌 html fenced 块）', () => {
  assert.ok(BASE_RULES.includes('绝不') && BASE_RULES.includes('fenced'),
    'BASE_RULES 应有"绝不内嵌 html fenced 块"反向规则');
});

test('BASE_RULES 总字数 ≤1500（roundtable-scenes.js line 47 注释约定）', () => {
  assert.ok(BASE_RULES.length <= 1500,
    'BASE_RULES 总字数 ' + BASE_RULES.length + ' 超 1500 上限');
});

test('BASE_RULES 字数 ≥1100（确认 v3 富文本提示已注入）', () => {
  // v2 旧基线 1334；v3 段略短（~280 字）总长约 1299；留 200 字裕度防 BASE_RULES 重写时误删
  assert.ok(BASE_RULES.length >= 1100,
    'BASE_RULES 字数仅 ' + BASE_RULES.length + '，v3 富文本提示可能未注入');
});

test('buildSystemPrompt(general) 输出含 v3 富文本提示', () => {
  if (typeof scenes.buildSystemPrompt !== 'function') return;
  const general = scenes.buildSystemPrompt('general', '', 'pikachu');
  assert.ok(general.includes('富文本') || general.includes('.html'),
    'general scene system prompt 应含 v3 富文本/.html 字样');
});

test('research preset 仍生效（不被覆盖）', () => {
  if (typeof scenes.buildSystemPrompt !== 'function') return;
  const research = scenes.buildSystemPrompt('research', '', 'pikachu');
  assert.ok(research.includes('A 股投研') || research.includes('data_query'),
    'research preset 仍生效');
});
