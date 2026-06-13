'use strict';
// 真实执行投委会"沉浸式富渲染"函数（从 meeting-room.js 源码切出实跑，非结构断言）：
//   _committeeSigClass / _committeeAnalystCard / _committeeRichHtml / _mergeCommitteeRich
// 这些函数在 renderer 模块里依赖 browser 全局无法 require，故切片 + eval + escapeHtml stub 实跑。
// 跑法：node tests/unit-committee-rich-render.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');

function slice(fromMarker, toMarker) {
  const i = SRC.indexOf(fromMarker);
  const j = SRC.indexOf(toMarker, i + 1);
  assert.ok(i >= 0 && j > i, `源码标记未找到: ${fromMarker} .. ${toMarker}`);
  return SRC.slice(i, j);
}

// escapeHtml stub（与生产同义：转义 & < > "）
const stub = `
function escapeHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
`;

const richBlock = slice('function _committeeSigClass', 'function _renderCommitteeDashboard');
const mergeBlock = slice('function _mergeCommitteeRich', 'function _recordCommitteeProgress');

// 组装可执行沙箱，导出需要的函数
const factory = new Function(`${stub}\n${mergeBlock}\n${richBlock}\n return { _committeeRichHtml, _committeeAnalystCard, _committeeSigClass, _mergeCommitteeRich };`);
const M = factory();

let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok -', name); }
  catch (e) { console.error('  FAIL -', name, ':', e.message); process.exitCode = 1; }
}

t('sigClass 映射', () => {
  assert.strictEqual(M._committeeSigClass('看多'), 'long');
  assert.strictEqual(M._committeeSigClass('看空'), 'short');
  assert.strictEqual(M._committeeSigClass('中性'), 'neutral');
});

t('mergeRich 累积各阶段结构化数据', () => {
  let rich = M._mergeCommitteeRich(null, { stage: 'prep', name: '澜起科技', symbol: '688008', red_flags: [{ name: '存货', state: 'triggered' }], coverage_gate: { max_rating: 'S' } });
  rich = M._mergeCommitteeRich(rich, { stage: 'analyst', seat: 'fund', label: '基本面官', report: { signal: '看多', confidence: 72, core_thesis: 'DDR5兑现' } });
  rich = M._mergeCommitteeRich(rich, { stage: 'verdict', verdict: { rating: 'A', core_thesis: 'A级' } });
  rich = M._mergeCommitteeRich(rich, { stage: 'save', replayPath: 'C:\\x\\replay.html' });
  assert.strictEqual(rich.name, '澜起科技');
  assert.strictEqual(rich.analysts.fund.confidence, 72);
  assert.strictEqual(rich.verdict.rating, 'A');
  assert.strictEqual(rich.replayPath, 'C:\\x\\replay.html');
});

t('analystCard 渲染 signal/信心/论点/证据/kill_switch', () => {
  const html = M._committeeAnalystCard('fund', {
    label: '基本面官', signal: '看多', confidence: 72, core_thesis: 'DDR5 渗透兑现',
    assumptions: ['DDR5 H2 加速'], evidence: [{ claim: '营收+41%', source: 'qmt', strength: 'strong' }],
    extras: { story_level: '有支撑' }, kill_switch: '存货未消化则下调', valid: true,
  });
  assert.ok(html.includes('mr-cm-badge long'), '看多→long 徽章');
  assert.ok(html.includes('72'), '显示信心值');
  assert.ok(html.includes('DDR5 渗透兑现'), '显示论点');
  assert.ok(html.includes('营收+41%'), '显示证据');
  assert.ok(html.includes('存货未消化则下调'), '显示 kill_switch');
  assert.ok(html.includes('故事:有支撑'), '显示席位专属标签');
});

t('analystCard 缺席席位降级提示', () => {
  const html = M._committeeAnalystCard('tech', { label: '技术面官', valid: false });
  assert.ok(html.includes('未过校验') || html.includes('缺席'), '缺席提示');
});

t('richHtml 整合渲染（各官+质询+裁决+复盘按钮）', () => {
  const rich = {
    analysts: {
      fund: { label: '基本面官', signal: '看多', confidence: 72, core_thesis: 't1', valid: true, assumptions: [], evidence: [], extras: {} },
      tech: { label: '技术面官', signal: '中性', confidence: 55, core_thesis: 't3', valid: true, assumptions: [], evidence: [], extras: {} },
    },
    challenge: { held: true, attack: { targets: [{ seat: 'fund' }], priced_in_risk: 'medium', summary: '存货存疑' } },
    verdict: { rating: 'A', core_thesis: 'A级候选', value_speculation: { fundamental_floor: '中', composite_score: 71 }, portfolio: { role: '弹性仓', suggested_cap_pct: 12 }, stop: '74.0' },
    replayPath: 'C:\\x\\V-1.html',
  };
  const html = M._committeeRichHtml({ rich });
  assert.ok(html.includes('三官研判'), '含研判区');
  assert.ok(html.includes('基本面官') && html.includes('技术面官'), '含各官卡');
  assert.ok(html.includes('交叉质询') && html.includes('medium'), '含质询+price-in风险');
  assert.ok(html.includes('mr-cm-rating') && html.includes('A级候选'), '含裁决英雄行');
  assert.ok(html.includes('价投') && html.includes('71'), '含价值投机分');
  assert.ok(html.includes('打开沉浸式复盘') && html.includes('V-1.html'), '含复盘按钮+路径');
});

t('richHtml 空数据返回空串', () => {
  assert.strictEqual(M._committeeRichHtml({}), '');
  assert.strictEqual(M._committeeRichHtml({ rich: { analysts: {} } }), '');
});

console.log(`${passed} passed`);
