'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AgentLeagueDecisionError,
  DEFAULT_RULES,
  computeStats,
  fees,
  lotRuleForSymbol,
  parseDraftMarkdown,
  parseHookMarkdown,
  settlePendingTargets,
  validateDecision,
  validateHookReview,
  validateWeeklyReview,
} = require('../core/agent-league-accounting.js');

function decision(targets = [{ symbol: '600001.SH', name: '测试股票', target_weight: 0.30 }], cash = 0.70) {
  return {
    action_summary: targets.length ? '建立测试组合' : '保持现金',
    market_view: '盘前只使用已经冻结的数据',
    core_conflict: '逻辑成立但价格位置仍需克制',
    cash_target: cash,
    targets: targets.map((row) => ({
      conviction: 0.7,
      horizon_days: 10,
      rule_refs: ['C1', 'P1', 'R2'],
      thesis: '基本面改善与价格尚未完全反映同时成立',
      counter_evidence: '估值扩张较快且短期可能回撤',
      timing_reason: '当前只建立与证据强度匹配的目标仓位',
      invalidation: '后续数据不再支持改善或关键结构失守',
      ...row,
    })),
    watchlist: [],
    risk_notes: ['组合风险由 Agent 在 Hook 中自行判断'],
    memory_note: '沿用上周确认的等待纪律',
  };
}

function hook(finalDecision, verdict = 'PASS') {
  return {
    verdict,
    rule_checks: [{ rule_id: 'P1', status: verdict === 'PASS' ? 'PASS' : 'WARN', comment: '已比较立即买入、等待和现金三种选择。' }],
    strongest_counter_evidence: '如果改善预期已经完全计价，当前仓位不再有赔率。',
    timing_check: '没有因为害怕错过而扩大仓位。',
    portfolio_check: '现金和目标仓位与证据强度匹配。',
    behavior_check: '没有读取排名或其他 Agent 的答案。',
    account_feasibility: '已考虑 50 万资金和对应板块最小申报数量。',
    changes: verdict === 'PASS' ? [] : ['降低目标仓位'],
    final_decision: finalDecision,
    daily_brief: {
      headline: '逻辑成立，也不代表今天必须重仓',
      body: '今天最重要的矛盾是基本面改善与短期价格透支同时存在。我认可改善逻辑，但最强反证是估值扩张已经走在业绩前面，因此没有为了排名扩大仓位。最终只保留与证据强度匹配的目标仓位，并保持足够现金。如果后续验证数据转弱或关键结构失守，我会承认判断错误。',
      hook_change: verdict === 'PASS' ? '自检后没有改变仓位，原因是原预案已经满足个人规则。' : '自检后降低仓位。',
      video_hooks: ['好公司也可能不是好买点'],
    },
  };
}

test('parses named DRAFT/HOOK blocks and requires personal rule references', () => {
  const raw = decision();
  const draft = parseDraftMarkdown(`说明\n\n\`\`\`agent-league-draft\n${JSON.stringify(raw)}\n\`\`\``);
  const checked = validateDecision(draft);
  assert.equal(checked.targets[0].rule_refs[0], 'C1');
  const parsedHook = parseHookMarkdown(`\`\`\`agent-league-hook\n${JSON.stringify(hook(checked))}\n\`\`\``);
  assert.equal(validateHookReview(parsedHook, { draft: checked }).verdict, 'PASS');

  const missing = decision();
  delete missing.targets[0].rule_refs;
  assert.throws(() => validateDecision(missing), /rule_refs/);
});

test('accepts any Shanghai/Shenzhen A share but rejects Beijing symbols', () => {
  assert.equal(validateDecision(decision([{ symbol: '688001.SH', target_weight: 0.2 }], 0.8)).targets[0].symbol, '688001.SH');
  assert.throws(
    () => validateDecision(decision([{ symbol: '430001.BJ', target_weight: 0.2 }], 0.8)),
    error => error instanceof AgentLeagueDecisionError && /沪深市场/.test(error.message),
  );
});

test('PASS cannot secretly mutate allocation while REVISE may reduce it', () => {
  const draft = validateDecision(decision());
  const changed = validateDecision(decision([{ symbol: '600001.SH', target_weight: 0.1 }], 0.9));
  assert.throws(() => validateHookReview(hook(changed, 'PASS'), { draft }), /不能偷偷改变/);
  const revised = validateHookReview(hook(changed, 'REVISE'), { draft });
  assert.equal(revised.final_decision.targets[0].target_weight, 0.1);
});

test('uses user fee rates and actual board-specific minimum quantities', () => {
  assert.equal(DEFAULT_RULES.commissionRate, 0.0001);
  assert.equal(DEFAULT_RULES.sellTaxRate, 0.001);
  assert.equal(DEFAULT_RULES.minimumCommission, 0);
  assert.deepEqual(lotRuleForSymbol('600001.SH'), { board: 'MAIN_OR_CHINEXT', minBuy: 100, buyStep: 100, minSell: 100, sellStep: 100 });
  assert.deepEqual(lotRuleForSymbol('688001.SH'), { board: 'STAR', minBuy: 200, buyStep: 1, minSell: 200, sellStep: 1 });
  assert.deepEqual(fees('buy', 100000, DEFAULT_RULES), { commission: 10, tax: 0, transfer: 0, total: 10 });
  assert.deepEqual(fees('sell', 100000, DEFAULT_RULES), { commission: 10, tax: 100, transfer: 0, total: 110 });
});

test('locks before open and settles the same decision date at real open fields', () => {
  const checked = validateDecision(decision([
    { symbol: '600001.SH', name: '主板', target_weight: 0.3 },
    { symbol: '688001.SH', name: '科创', target_weight: 0.2 },
  ], 0.5));
  const portfolio = {
    initialCash: 500000,
    cash: 500000,
    positions: [],
    navHistory: [],
    pendingDecision: {
      runId: 'run-1', decisionDate: '2026-08-27', decisionDataAsOf: '2026-08-26', decision: checked,
    },
  };
  const result = settlePendingTargets(portfolio, {
    asOf: '2026-08-27',
    prices: {
      '600001.SH': { name: '主板', open: 10, close: 10.2 },
      '688001.SH': { name: '科创', open: 20, close: 20.1 },
    },
  });
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'settled-at-open');
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades.find((row) => row.symbol === '600001.SH').quantity % 100, 0);
  assert(result.trades.find((row) => row.symbol === '688001.SH').quantity >= 200);
  assert.equal(result.portfolio.pendingDecision, null);
  assert(result.portfolio.cash >= 0);
});

test('records an explicit skip when target capital cannot reach the board minimum lot', () => {
  const checked = validateDecision(decision([{ symbol: '688001.SH', target_weight: 0.2 }], 0.8));
  const result = settlePendingTargets({
    initialCash: 500000, cash: 500000, positions: [], navHistory: [],
    pendingDecision: { runId: 'small-star', decisionDate: '2026-08-27', decisionDataAsOf: '2026-08-26', decision: checked },
  }, { asOf: '2026-08-27', prices: { '688001.SH': { name: '高价科创', open: 3000, close: 3000 } } });
  assert.equal(result.trades.length, 0);
  assert.match(result.orderNotes[0].reason, /200 股最小申报/);
});

test('sell settlement applies stamp tax and updates ranking statistics', () => {
  const first = validateDecision(decision());
  let result = settlePendingTargets({
    initialCash: 500000, cash: 500000, positions: [], navHistory: [],
    pendingDecision: { runId: 'r1', decisionDate: '2026-08-27', decisionDataAsOf: '2026-08-26', decision: first },
  }, { asOf: '2026-08-27', prices: { '600001.SH': { name: '测试', open: 10, close: 10 } } });
  const exit = validateDecision(decision([], 1));
  result.portfolio.pendingDecision = { runId: 'r2', decisionDate: '2026-08-28', decisionDataAsOf: '2026-08-27', decision: exit };
  const exited = settlePendingTargets(result.portfolio, {
    asOf: '2026-08-28', prices: { '600001.SH': { name: '测试', open: 11, close: 11 } },
  });
  assert.equal(exited.portfolio.positions.length, 0);
  assert(exited.trades[0].tax > 0);
  assert(exited.trades[0].realizedPnl > 0);
  const stats = computeStats(exited.portfolio, [...result.trades, ...exited.trades]);
  assert.equal(stats.tradeCount, 2);
  assert.equal(stats.winRate, 1);
});

test('weekly review separates process from result and keeps checklist changes as proposals', () => {
  const review = validateWeeklyReview({
    summary: '本周保持了不追高纪律。',
    process_win: '两次等待都符合预案，而不是因为后来上涨才说正确。',
    process_mistake: '一次买入没有充分比较保持现金。',
    lesson: '在位置不舒服时把等待作为主动决策。',
    strongest_counterexample: '也存在等待后直接继续上涨的机会成本。',
    evidence_for: ['样本 A'], evidence_against: ['样本 B'],
    checklist_proposal: { rule_id: 'P2', old_rule: '比较等待', proposed_rule: '明确写出等待触发条件', reason: '避免空泛等待', evidence: ['两次记录'] },
  });
  assert.equal(review.checklist_proposal.status, 'proposed');
});
