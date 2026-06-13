'use strict';

const assert = require('assert');
const r = require('../core/committee-intent-router.js');

const stocks = [
  { ts_code: '601127.SH', symbol: '601127', name: '赛力斯', industry: '汽车整车' },
  { ts_code: '601919.SH', symbol: '601919', name: '中远海控', industry: '水运' },
  { ts_code: '000100.SZ', symbol: '000100', name: 'TCL科技', industry: '元器件' },
  { ts_code: '002129.SZ', symbol: '002129', name: 'TCL中环', industry: '电气设备' },
  { ts_code: '600519.SH', symbol: '600519', name: '贵州茅台', industry: '白酒' },
];

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name, ':', e.stack || e.message);
    process.exitCode = 1;
  }
}

t('deterministic: 中文名单票快评', () => {
  const route = r.routeDeterministic('赛力斯怎么样', { stocks });
  assert.strictEqual(route.intent, 'single_stock');
  assert.strictEqual(route.symbols[0].symbol, '601127');
  assert.strictEqual(route.mode, 'quick');
});

t('deterministic: 中文名深挖映射 full', () => {
  const route = r.routeDeterministic('中远海控深挖一下', { stocks });
  assert.strictEqual(route.intent, 'single_stock');
  assert.strictEqual(route.symbols[0].symbol, '601919');
  assert.strictEqual(route.mode, 'full');
});

t('deterministic: 两个中文名进入对比意图', () => {
  const route = r.routeDeterministic('TCL科技和赛力斯比一下', { stocks });
  assert.strictEqual(route.intent, 'compare_stocks');
  assert.deepStrictEqual(route.symbols.map(s => s.symbol).sort(), ['000100', '601127']);
});

t('deterministic: 简称歧义要求澄清', () => {
  const route = r.routeDeterministic('TCL怎么样', { stocks });
  assert.strictEqual(route.intent, 'clarify');
  assert.ok(route.needs_clarification);
  assert.deepStrictEqual(route.symbols.map(s => s.symbol).sort(), ['000100', '002129']);
});

t('deterministic: 部分中文名可命中唯一标的', () => {
  const route = r.routeDeterministic('茅台怎么样', { stocks });
  assert.strictEqual(route.intent, 'single_stock');
  assert.strictEqual(route.symbols[0].symbol, '600519');
});

t('llm validate: 股票名必须回表校验为代码', () => {
  const route = r.validateLlmRoute({
    intent: 'single_stock',
    mode: 'quick',
    symbols: [{ name: '赛力斯', symbol: '601127' }],
    needs_clarification: false,
  }, '赛力斯怎么样', { stocks });
  assert.strictEqual(route.intent, 'single_stock');
  assert.strictEqual(route.symbols[0].symbol, '601127');
});

t('llm validate: 错代码/未知名不通过', () => {
  const route = r.validateLlmRoute({
    intent: 'single_stock',
    mode: 'quick',
    symbols: [{ name: '赛力斯', symbol: '999999' }],
    needs_clarification: false,
  }, '赛力斯怎么样', { stocks });
  assert.strictEqual(route, null);
});

t('prompt: 包含本地候选和只输出 JSON 约束', () => {
  const prompt = r.buildLlmRouterPrompt('赛力斯怎么样', r.findStockCandidates('赛力斯怎么样', stocks));
  assert.ok(prompt.includes('只输出一个 JSON 对象'));
  assert.ok(prompt.includes('赛力斯 601127'));
});

console.log(`\ncommittee intent router: ${passed} passed${process.exitCode ? ' (有失败！)' : ''}`);
