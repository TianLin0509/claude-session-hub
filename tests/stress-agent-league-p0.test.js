'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  computeStats,
  settlePendingTargets,
  validateDecision,
  validateHookReview,
  validateWeeklyReview,
} = require('../core/agent-league-accounting.js');
const { AgentLeagueStore, readMarkdownState } = require('../core/agent-league-store.js');
const { getPhilosophy } = require('../core/agent-league-philosophies.js');

function prng(seed = 123456789) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

const symbols = ['600001.SH', '000002.SZ', '300003.SZ', '688004.SH', '689005.SH', '601006.SH'];

function fullDecision(targetRows, cash) {
  return validateDecision({
    action_summary: targetRows.length ? '按本日证据调整目标组合' : '保持全现金',
    market_view: '只使用本日冻结快照', core_conflict: '机会与赔率需要同时满足', cash_target: cash,
    targets: targetRows.map((row) => ({
      symbol: row.symbol, name: row.symbol, target_weight: row.weight,
      conviction: 0.6, horizon_days: 20, rule_refs: ['C1', 'P1', 'R1'],
      thesis: '存在可验证的改善证据', counter_evidence: '价格可能已经部分计价',
      timing_reason: '目标仓位与当前证据强度匹配', invalidation: '后续数据转弱或逻辑证伪',
    })),
    watchlist: [], risk_notes: ['随机压力样本'], memory_note: '只读历史纪律',
  });
}

function hookFor(draft) {
  return validateHookReview({
    verdict: 'PASS', rule_checks: [{ rule_id: 'P1', status: 'PASS', comment: '已比较等待和现金。' }],
    strongest_counter_evidence: '价格可能领先基本面。', timing_check: '没有追高。',
    portfolio_check: 'Agent 自行判断组合可承受。', behavior_check: '未受排名影响。', account_feasibility: '申报数量可机械换算。',
    changes: [], final_decision: draft,
    daily_brief: {
      headline: '压力测试日记',
      body: '今天最重要的矛盾仍然是改善证据与交易位置能否同时成立。我保留了最强反证，并比较了买入、等待和保持现金。目标仓位只反映当前证据强度，不因为排名或近期盈亏扩大；如果后续数据转弱，我会承认判断错误并按失效条件退出。',
      hook_change: '自检后无变化。', video_hooks: ['证据与位置必须同时成立'],
    },
  }, { draft });
}

test('500 sequential randomized rebalances never create negative cash or illegal buy lots', () => {
  const random = prng(20260827);
  let portfolio = { initialCash: 500000, cash: 500000, positions: [], navHistory: [], pendingDecision: null };
  const trades = [];
  const basePrices = Object.fromEntries(symbols.map((symbol, index) => [symbol, 6 + index * 7]));
  for (let day = 0; day < 500; day += 1) {
    const selected = symbols.filter(() => random() > 0.38).slice(0, 5);
    const equity = Math.round(random() * 95) / 100;
    const rawWeights = selected.map(() => 0.2 + random());
    const totalRaw = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
    const targetRows = selected.map((symbol, index) => ({
      symbol,
      weight: Math.round((equity * rawWeights[index] / totalRaw) * 1e6) / 1e6,
    }));
    const allocated = targetRows.reduce((sum, row) => sum + row.weight, 0);
    const cash = Math.round((1 - allocated) * 1e6) / 1e6;
    const decision = fullDecision(targetRows, cash);
    const date = new Date(Date.UTC(2030, 0, 1 + day)).toISOString().slice(0, 10);
    portfolio.pendingDecision = { runId: `run-${day}`, decisionDate: date, decisionDataAsOf: date, decision };
    const prices = {};
    for (const symbol of symbols) {
      const move = 0.985 + random() * 0.03;
      basePrices[symbol] = Math.max(1, basePrices[symbol] * move);
      prices[symbol] = { name: symbol, open: basePrices[symbol], close: basePrices[symbol] * (0.995 + random() * 0.01) };
    }
    const result = settlePendingTargets(portfolio, { asOf: date, prices });
    assert.equal(result.settled, true);
    assert(result.portfolio.cash >= -0.001, `negative cash on day ${day}`);
    assert.equal(result.portfolio.pendingDecision, null);
    for (const trade of result.trades) {
      if (trade.side === 'BUY' && /^68[89]/.test(trade.symbol)) assert(trade.quantity >= 200);
      if (trade.side === 'BUY' && !/^68[89]/.test(trade.symbol)) assert.equal(trade.quantity % 100, 0);
      assert(trade.commission >= 0 && trade.tax >= 0 && trade.transferFee === 0);
    }
    portfolio = result.portfolio;
    trades.push(...result.trades);
    const marketValue = portfolio.positions.reduce((sum, row) => sum + row.quantity * row.lastPrice, 0);
    const latest = portfolio.navHistory[portfolio.navHistory.length - 1];
    assert(Math.abs(latest.nav - portfolio.cash - marketValue) < 0.03, `NAV identity day ${day}`);
  }
  const stats = computeStats(portfolio, trades);
  assert.equal(stats.tradingDays, 500);
  assert(stats.tradeCount > 100);
  assert(Number.isFinite(stats.totalReturn));
});

test('80 daily Markdown cycles plus 12 weekly reviews remain readable and append-only by date', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-file-stress-'));
  try {
    const store = new AgentLeagueStore({ root });
    const philosophy = getPhilosophy('chuxin-value-speculation');
    store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
    for (let day = 0; day < 80; day += 1) {
      const date = new Date(Date.UTC(2031, 0, 1 + day)).toISOString().slice(0, 10);
      const draft = fullDecision([], 1);
      const hook = hookFor(draft);
      store.recordRunStart('chuxin-baseline', { runId: `run-${day}`, decisionDate: date, dataAsOf: date, promptHash: `p-${day}` });
      store.recordDraft('chuxin-baseline', { runId: `run-${day}`, decisionDate: date, dataAsOf: date, draft, markdown: `draft-${day}` });
      store.recordDecision('chuxin-baseline', {
        runId: `run-${day}`, decisionDate: date, dataAsOf: date, decision: draft, hook, dailyBrief: hook.daily_brief, markdown: `hook-${day}`,
      });
      store.settleAgent('chuxin-baseline', { asOf: date, prices: {} }, { executionPriceField: 'open' });
      store.markAgent('chuxin-baseline', { asOf: date, prices: {} }, date);
      const state = store.getDaily('chuxin-baseline', date);
      assert.equal(state.status, 'decision-queued');
      assert.equal(state.dailyBrief.headline, '压力测试日记');
      assert(state.execution && state.closeResult);
    }
    for (let week = 0; week < 12; week += 1) {
      const date = new Date(Date.UTC(2031, 2, 22 + week * 7)).toISOString().slice(0, 10);
      store.recordWeeklyStart('chuxin-baseline', { runId: `weekly-${week}`, saturdayDate: date, tradingDates: [] });
      const review = validateWeeklyReview({
        summary: `第 ${week} 周总结`, process_win: '保持纪律', process_mistake: '仍需更多样本', lesson: `待验证经验 ${week}`,
        strongest_counterexample: '现金也有机会成本', evidence_for: [], evidence_against: [], checklist_proposal: null,
      });
      store.recordWeeklyReview('chuxin-baseline', { runId: `weekly-${week}`, saturdayDate: date, review, markdown: `weekly-${week}` });
      assert.equal(store.getWeekly('chuxin-baseline', date).status, 'completed');
    }
    const row = store.getAgent('chuxin-baseline');
    assert.equal(store.listDaily('chuxin-baseline', { limit: 100 }).length, 80);
    assert.equal(row.agent.decisionCount, 80);
    assert.equal(row.agent.weeklyReviewCount, 12);
    assert.equal(row.memory.candidates.length, 12);
    for (const file of [row.files.agent, row.files.portfolio, row.files.memory, row.files.evolution]) {
      assert(readMarkdownState(file), `state should remain readable: ${file}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
