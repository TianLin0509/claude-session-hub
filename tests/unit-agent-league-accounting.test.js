'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AgentLeagueDecisionError,
  computeStats,
  parseDecisionMarkdown,
  settlePendingTargets,
  validateDecision,
} = require('../core/agent-league-accounting.js');

function decision(weight = 0.30, cash = 0.70) {
  return {
    action_summary: '建立一只测试持仓',
    market_view: '仅用于确定性账本测试',
    cash_target: cash,
    targets: weight > 0 ? [{
      symbol: '600001.SH', name: '测试股票', target_weight: weight,
      conviction: 0.7, horizon_days: 10, thesis: '测试逻辑', invalidation: '测试失效',
    }] : [],
    risk_notes: ['测试风险'],
    reflection: { kept: '保留纪律', mistake: '无', lesson_candidate: '验证样本', evidence_for: [], evidence_against: [] },
  };
}

test('parses the named decision block and validates frozen-universe weights', () => {
  const raw = `说明文字\n\n\`\`\`agent-league-decision\n${JSON.stringify(decision())}\n\`\`\``;
  const parsed = parseDecisionMarkdown(raw);
  const checked = validateDecision(parsed, { allowedSymbols: new Set(['600001.SH']) });
  assert.equal(checked.targets.length, 1);
  assert.equal(checked.targets[0].symbol, '600001.SH');
  assert.equal(checked.cash_target, 0.7);
  assert.equal(checked.reflection.lesson_candidate, '验证样本');
});

test('rejects symbols outside the frozen pool unless already held', () => {
  assert.throws(
    () => validateDecision(decision(), { allowedSymbols: new Set(['000001.SZ']) }),
    error => error instanceof AgentLeagueDecisionError && error.code === 'symbol-not-allowed',
  );
  assert.equal(validateDecision(decision(), {
    allowedSymbols: new Set(['000001.SZ']),
    existingSymbols: new Set(['600001.SH']),
  }).targets[0].symbol, '600001.SH');
});

test('daily reflection is mandatory so every successful Agent turn produces an evolution record', () => {
  const missing = decision();
  delete missing.reflection;
  assert.throws(() => validateDecision(missing, { allowedSymbols: new Set(['600001.SH']) }), /reflection 是每日必填项/);
  const blank = decision();
  blank.reflection.lesson_candidate = '';
  assert.throws(() => validateDecision(blank, { allowedSymbols: new Set(['600001.SH']) }), /lesson_candidate 每日都必须填写/);
});

test('queues on T and settles only on a newer close snapshot with deterministic fees', () => {
  const checked = validateDecision(decision(), { allowedSymbols: new Set(['600001.SH']) });
  const portfolio = {
    initialCash: 1_000_000,
    cash: 1_000_000,
    positions: [],
    navHistory: [],
    pendingDecision: { runId: 'run-1', decisionAsOf: '2026-08-25', decision: checked },
  };
  const sameDay = settlePendingTargets(portfolio, {
    asOf: '2026-08-25', prices: { '600001.SH': { name: '测试股票', close: 10 } },
  });
  assert.equal(sameDay.settled, false);
  assert.equal(sameDay.reason, 'awaiting-newer-snapshot');
  assert.equal(sameDay.portfolio.positions.length, 0);

  const nextDay = settlePendingTargets(portfolio, {
    asOf: '2026-08-26', prices: { '600001.SH': { name: '测试股票', close: 10 } },
  });
  assert.equal(nextDay.settled, true);
  assert.equal(nextDay.trades.length, 1);
  assert.equal(nextDay.trades[0].side, 'BUY');
  assert.equal(nextDay.portfolio.pendingDecision, null);
  assert.equal(nextDay.portfolio.positions[0].quantity % 100, 0);
  assert(nextDay.portfolio.cash >= 0);
  assert(nextDay.nav < 1_000_000, 'fees and slippage should reduce NAV');
});

test('sell settlement produces realized PnL and ranking statistics', () => {
  const firstDecision = validateDecision(decision(), { allowedSymbols: new Set(['600001.SH']) });
  let result = settlePendingTargets({
    initialCash: 1_000_000, cash: 1_000_000, positions: [], navHistory: [],
    pendingDecision: { runId: 'run-1', decisionAsOf: '2026-08-25', decision: firstDecision },
  }, { asOf: '2026-08-26', prices: { '600001.SH': { name: '测试股票', close: 10 } } });
  const exitDecision = validateDecision(decision(0, 1), {
    allowedSymbols: new Set(), existingSymbols: new Set(['600001.SH']),
  });
  result.portfolio.pendingDecision = { runId: 'run-2', decisionAsOf: '2026-08-26', decision: exitDecision };
  const exited = settlePendingTargets(result.portfolio, {
    asOf: '2026-08-27', prices: { '600001.SH': { name: '测试股票', close: 11 } },
  });
  assert.equal(exited.portfolio.positions.length, 0);
  assert.equal(exited.trades[0].side, 'SELL');
  assert(exited.trades[0].realizedPnl > 0);
  const stats = computeStats(exited.portfolio, [...result.trades, ...exited.trades]);
  assert.equal(stats.tradeCount, 2);
  assert.equal(stats.sellCount, 1);
  assert.equal(stats.winRate, 1);
  assert(stats.totalReturn > 0);
});
