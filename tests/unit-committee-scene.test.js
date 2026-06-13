'use strict';
// 投委会纯函数单测：命令解析 / JSON 提取 / schema 校验 / 质询触发 / 决议门控。
// 跑法：node tests/unit-committee-scene.test.js

const assert = require('assert');
const s = require('../core/committee-scene.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log('  ok -', name); }
  catch (e) { console.error('  FAIL -', name, ':', e.message); process.exitCode = 1; }
}

// ---- 命令解析 ----
t('parse: 纯代码 → quick', () => {
  assert.deepStrictEqual(s.parseCommitteeCommand('002230'), { symbol: '002230', mode: 'quick' });
});
t('parse: 代码+全量 → full', () => {
  const r = s.parseCommitteeCommand('600519 全量');
  assert.strictEqual(r.symbol, '600519');
  assert.strictEqual(r.mode, 'full');
});
t('parse: 带后缀', () => {
  assert.strictEqual(s.parseCommitteeCommand('开会 300750.SZ').symbol, '300750.SZ');
});
t('parse: 无代码 → null', () => {
  assert.strictEqual(s.parseCommitteeCommand('帮我看看茅台'), null);
});

t('persona: 重复 Claude/Codex 时按席位 key 取纪律', () => {
  assert.ok(s.buildCommitteePersona('news').includes('消息面官'));
  assert.ok(s.buildCommitteePersona('tech').includes('技术面官'));
  assert.ok(s.buildCommitteePersona('chair').includes('主席'));
  assert.ok(s.buildCommitteePersona('claude').includes('主席'));
});

// ---- JSON 提取 ----
const techJson = {
  seat: 'tech', signal: '看空', confidence: 72, core_thesis: '趋势破位，主升结束',
  assumptions: ['20日线失守后无修复'],
  evidence: [{ claim: 'RSI 30.6 / 20日 -14%', source: 'stock_market', strength: 'medium' }],
  kill_switch: '放量站回 46',
  extras: { trend_stage: '破位震荡', support: 42, resistance: 46, stop_suggest: 41 },
};
const block = '口头要点……\n```json\n' + JSON.stringify(techJson) + '\n```\n收尾';
t('extract: 取最后一个 json 块', () => {
  const j = s.extractJsonBlock('```json\n{"a":1}\n```\n' + block);
  assert.strictEqual(j.signal, '看空');
});
t('extract: 容忍尾逗号', () => {
  const j = s.extractJsonBlock('```json\n{"signal":"看多","confidence":50,}\n```');
  assert.strictEqual(j.signal, '看多');
});
t('extract: 容忍字符串内部裸双引号', () => {
  const j = s.extractJsonBlock('```json\n{"core_thesis":"利润"稳定"而非"增长"意味着缺加速度","confidence":55}\n```');
  assert.strictEqual(j.core_thesis, '利润"稳定"而非"增长"意味着缺加速度');
  assert.strictEqual(j.confidence, 55);
});
t('extract: 同时容忍尾逗号和裸双引号', () => {
  const j = s.extractJsonBlock('```json\n{"core_thesis":"前次决议"稳增长催化未兑现"假设仍成立","confidence":55,}\n```');
  assert.strictEqual(j.core_thesis, '前次决议"稳增长催化未兑现"假设仍成立');
});
t('extract: 无 JSON → null', () => {
  assert.strictEqual(s.extractJsonBlock('纯文本没有块'), null);
});

// ---- 分析官校验 ----
t('validate: 合法 tech 报告通过', () => {
  const v = s.validateAnalystReport(techJson, 'tech');
  assert.strictEqual(v.ok, true, v.errors.join(';'));
});
t('validate: 禁用词拦截', () => {
  const bad = { ...techJson, core_thesis: '基本面良好，值得关注' };
  const v = s.validateAnalystReport(bad, 'tech');
  assert.ok(v.errors.some(e => e.includes('禁用词')));
});
t('validate: 全 weak 证据限制 confidence', () => {
  const bad = { ...techJson, confidence: 80, evidence: [{ claim: 'x', source: '股吧', strength: 'weak' }] };
  const v = s.validateAnalystReport(bad, 'tech');
  assert.ok(v.errors.some(e => e.includes('weak')));
});
t('validate: fund 缺 story_level 拦截', () => {
  const fund = { ...techJson, seat: 'fund', extras: { red_flag_review: [{ name: 'x', comment: 'y' }] } };
  const v = s.validateAnalystReport(fund, 'fund');
  assert.ok(v.errors.some(e => e.includes('story_level')));
});
t('validate: news 缺 sector_position 拦截', () => {
  const news = { ...techJson, seat: 'news', extras: { catalysts: [] } };
  const v = s.validateAnalystReport(news, 'news');
  assert.ok(v.errors.some(e => e.includes('sector_position')));
});
t('validate: evidence 缺 source 拦截', () => {
  const bad = { ...techJson, evidence: [{ claim: 'x', strength: 'medium' }] };
  const v = s.validateAnalystReport(bad, 'tech');
  assert.ok(v.errors.some(e => e.includes('source')));
});

// ---- 质询触发（反直觉规则：越一致越质询） ----
t('trigger: 三官同向高信心 → 质询', () => {
  const reports = {
    fund: { json: { signal: '看多', confidence: 80 } },
    news: { json: { signal: '看多', confidence: 75 } },
    tech: { json: { signal: '看多', confidence: 72 } },
  };
  assert.strictEqual(s.decideChallenge(reports, 'quick').challenge, true);
});
t('trigger: 实质分歧 → 跳过', () => {
  const reports = {
    fund: { json: { signal: '看多', confidence: 80 } },
    news: { json: { signal: '看空', confidence: 75 } },
    tech: { json: { signal: '中性', confidence: 50 } },
  };
  assert.strictEqual(s.decideChallenge(reports, 'quick').challenge, false);
});
t('trigger: 同向低信心 → 跳过', () => {
  const reports = {
    fund: { json: { signal: '看多', confidence: 55 } },
    news: { json: { signal: '看多', confidence: 60 } },
    tech: { json: { signal: '中性', confidence: 50 } },
  };
  assert.strictEqual(s.decideChallenge(reports, 'quick').challenge, false);
});
t('trigger: full 模式必质询', () => {
  assert.strictEqual(s.decideChallenge({}, 'full').challenge, true);
});

// ---- 决议校验 ----
const verdict = {
  rating: 'S', position_type: '中线主仓候选', core_thesis: '三面共振',
  faces: { fundamental: { score: 40 }, news: { score: 60 }, technical: { score: 30 } },
  value_speculation: {
    fundamental_floor: '强',
    theme_purity: '正宗',
    expectation_gap: '明确',
    flow_elasticity: '强',
    timing_window: '未来 1-3 个月有明确催化窗口',
    composite_score: 82,
    vetoes: [],
  },
  portfolio: {
    role: '核心仓',
    suggested_cap_pct: 20,
    add_rule: '回踩支撑不破且成交额放大',
    trim_rule: '跌破止损或催化兑现后量价背离',
  },
  entry: { zone: '42-43，前低上方 2%', logic: 'x' }, stop: '40.5',
  catalysts: [], disagreements: [], alt_check: '同板块对比过，弹性最优',
  assumptions: ['a'], kill_switch_summary: ['b'], memory_read: [],
};
t('verdict: 合法 S 级通过', () => {
  const v = s.validateVerdict(verdict, { maxRating: 'S' });
  assert.strictEqual(v.ok, true, v.errors.join(';'));
});
t('verdict: 覆盖度门控拦截（max B 时禁 S）', () => {
  const v = s.validateVerdict(verdict, { maxRating: 'B' });
  assert.ok(v.errors.some(e => e.includes('覆盖度门控')));
});
t('verdict: 纯故事一票限制权（S 被拦）', () => {
  const v = s.validateVerdict(verdict, { maxRating: 'S', storyLevelPure: true });
  assert.ok(v.errors.some(e => e.includes('一票限制权')));
});
t('verdict: 编造记忆 ID 拦截', () => {
  const bad = { ...verdict, memory_read: ['V-FAKE-9'] };
  const v = s.validateVerdict(bad, { maxRating: 'S', validMemoryIds: ['V-20260507-002230', 'L-001'] });
  assert.ok(v.errors.some(e => e.includes('编造')));
});
t('verdict: B 级缺 upgrade_trigger 拦截', () => {
  const b = { ...verdict, rating: 'B', entry: null, stop: null };
  const v = s.validateVerdict(b, { maxRating: 'S' });
  assert.ok(v.errors.some(e => e.includes('upgrade_trigger')));
});
t('verdict: 缺价值投机四格被拦', () => {
  const bad = { ...verdict };
  delete bad.value_speculation;
  const v = s.validateVerdict(bad, { maxRating: 'S' });
  assert.ok(v.errors.some(e => e.includes('value_speculation')));
});
t('verdict: S 级基本面托底弱被拦', () => {
  const bad = { ...verdict, value_speculation: { ...verdict.value_speculation, fundamental_floor: '弱' } };
  const v = s.validateVerdict(bad, { maxRating: 'S' });
  assert.ok(v.errors.some(e => e.includes('基本面托底')));
});
t('verdict: C 级必须禁入且 0 仓位', () => {
  const bad = {
    ...verdict,
    rating: 'C',
    position_type: '回避',
    portfolio: { ...verdict.portfolio, role: '禁入', suggested_cap_pct: 5 },
  };
  const v = s.validateVerdict(bad, { maxRating: 'S' });
  assert.ok(v.errors.some(e => e.includes('C 级回避票')));
});

// ---- 持仓体检 ----
t('checkup parse: 体检+图片路径', () => {
  const r = s.parseCheckupCommand('体检 C:\\Users\\lintian\\.claude-session-hub\\images\\20260611155219-9b08a3.png');
  assert.ok(r && r.imagePath && r.imagePath.endsWith('.png'));
});
t('checkup parse: 裸图片路径按体检入口处理', () => {
  const r = s.parseCheckupCommand('C:\\Users\\lintian\\.claude-session-hub\\images\\20260613063837-7ebbfa.png');
  assert.ok(r && r.imagePath && r.imagePath.endsWith('20260613063837-7ebbfa.png'));
});
t('checkup parse: 图片路径混普通文本也按体检入口处理', () => {
  const r = s.parseCheckupCommand('帮我看一下 C:\\Users\\lintian\\.claude-session-hub\\images\\20260613063837-7ebbfa.png');
  assert.ok(r && r.imagePath && r.imagePath.endsWith('20260613063837-7ebbfa.png'));
});
t('checkup parse: 纯文本持仓', () => {
  const r = s.parseCheckupCommand('体检 002230 成本41.5 688008 成本71.1');
  assert.strictEqual(r.positions.length, 2);
  assert.strictEqual(r.positions[0].cost, 41.5);
});
t('checkup parse: 无关消息 → null', () => {
  assert.strictEqual(s.parseCheckupCommand('今天大盘怎么看'), null);
});
t('checkup parse: 体检命令不会被误判为立项', () => {
  assert.strictEqual(s.parseCommitteeCommand('体检 002230 成本41.5'), null);
});
t('checkup normalize: holding/百分号字符串归一化', () => {
  const n = s.normalizeCheckupPositions({
    positions: [{ name: '澜起科技', symbol: '688008', holding: 600, cost: 71.148, price: 224.31, pnl_pct: '215.272%' }],
    total_assets: 1016569.91, position_ratio: '34.5%',
  });
  assert.strictEqual(n.positions[0].shares, 600);
  assert.strictEqual(n.positions[0].pnl_pct, 215.272);
  assert.strictEqual(n.position_pct, 34.5);
});
t('checkup verdict: 漏裁持仓被拦', () => {
  const v = s.validateCheckupVerdict(
    { checkups: [{ symbol: '688008', action: '持有', reason: '趋势仍健康', stop: 200, recheck_trigger: 'x' }],
      portfolio_note: '集中度中等',
      portfolio_risk: { concentration: '中', theme_crowding: '未知', first_action: '先观察 688008' } },
    ['688008', '300604']);
  assert.ok(v.errors.some(e => e.includes('漏裁')));
});
t('checkup verdict: 合法通过', () => {
  const v = s.validateCheckupVerdict(
    { checkups: [
      { symbol: '688008', action: '持有', reason: '未破趋势，催化未到', stop: 200, recheck_trigger: '跌破 200' },
      { symbol: '300604', action: '减仓', reason: '跌破关键位且板块转弱', stop: 65, recheck_trigger: '三季报' },
    ],
      portfolio_note: '组合偏半导体，集中度中等',
      portfolio_risk: { concentration: '中', theme_crowding: '高', first_action: '先处理 300604' } }, ['688008', '300604']);
  assert.strictEqual(v.ok, true, v.errors.join(';'));
});
t('checkup verdict: 缺组合风险被拦', () => {
  const v = s.validateCheckupVerdict(
    { checkups: [{ symbol: '688008', action: '持有', reason: '趋势仍健康', stop: 200, recheck_trigger: '跌破 200' }],
      portfolio_note: '集中度中等' }, ['688008']);
  assert.ok(v.errors.some(e => e.includes('portfolio_risk')));
});

// ---- conductor 辅助 ----
const { _extractMemoryIds } = require('../main/groupchat/committee-conductor.js');
t('extractMemoryIds: 从案卷提取 V-/L- ID', () => {
  const ids = _extractMemoryIds('- V-20260507-002230：A 级\n- L-001（命中 3/4）：xxx');
  assert.ok(ids.includes('V-20260507-002230') && ids.includes('L-001'));
});

console.log(`\n${passed} passed${process.exitCode ? ' (有失败！)' : '，全部通过'}`);
