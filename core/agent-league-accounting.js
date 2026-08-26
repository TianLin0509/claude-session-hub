'use strict';

const DEFAULT_RULES = Object.freeze({
  lotSize: 100,
  maxTargets: 6,
  maxSingleWeight: 0.30,
  minCashWeight: 0.05,
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageRate: 0.001,
});

const SYMBOL_RE = /^\d{6}\.(SH|SZ|BJ)$/;

class AgentLeagueDecisionError extends Error {
  constructor(message, code = 'invalid-decision') {
    super(message);
    this.name = 'AgentLeagueDecisionError';
    this.code = code;
  }
}

function asFinite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundPrice(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function parseDecisionMarkdown(markdown) {
  const text = String(markdown || '');
  const named = [...text.matchAll(/```agent-league-decision\s*([\s\S]*?)```/gi)];
  const generic = named.length ? [] : [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = named.length ? named : generic;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index][1].trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  throw new AgentLeagueDecisionError('回复缺少可解析的 agent-league-decision JSON 代码块', 'decision-block-missing');
}

function validateDecision(decision, options = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new AgentLeagueDecisionError('决策必须是 JSON object');
  }
  const rules = { ...DEFAULT_RULES, ...(options.rules || {}) };
  const allowedSymbols = options.allowedSymbols instanceof Set ? options.allowedSymbols : null;
  const existingSymbols = options.existingSymbols instanceof Set ? options.existingSymbols : new Set();
  const targets = Array.isArray(decision.targets) ? decision.targets : null;
  if (!targets || targets.length > rules.maxTargets) {
    throw new AgentLeagueDecisionError(`targets 必须是不超过 ${rules.maxTargets} 项的数组`);
  }
  const seen = new Set();
  let totalWeight = 0;
  const normalizedTargets = targets.map((target) => {
    if (!target || typeof target !== 'object') throw new AgentLeagueDecisionError('每个 target 必须是 object');
    const symbol = String(target.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new AgentLeagueDecisionError(`股票代码格式无效：${symbol || '(empty)'}`);
    if (seen.has(symbol)) throw new AgentLeagueDecisionError(`targets 存在重复股票：${symbol}`);
    if (allowedSymbols && !allowedSymbols.has(symbol) && !existingSymbols.has(symbol)) {
      throw new AgentLeagueDecisionError(`股票不在冻结候选池或当前持仓中：${symbol}`, 'symbol-not-allowed');
    }
    seen.add(symbol);
    const targetWeight = asFinite(target.target_weight);
    if (targetWeight == null || targetWeight < 0 || targetWeight > rules.maxSingleWeight + 1e-9) {
      throw new AgentLeagueDecisionError(`${symbol} 目标权重必须在 0-${rules.maxSingleWeight} 之间`);
    }
    totalWeight += targetWeight;
    const conviction = asFinite(target.conviction, 0.5);
    const horizonDays = Math.max(1, Math.min(180, Math.round(asFinite(target.horizon_days, 10))));
    return {
      symbol,
      name: String(target.name || symbol),
      target_weight: Math.round(targetWeight * 1e6) / 1e6,
      conviction: Math.max(0, Math.min(1, conviction)),
      horizon_days: horizonDays,
      thesis: String(target.thesis || '').trim().slice(0, 1000),
      invalidation: String(target.invalidation || '').trim().slice(0, 1000),
    };
  });
  const cashTarget = asFinite(decision.cash_target);
  if (cashTarget == null || cashTarget < rules.minCashWeight - 1e-9 || cashTarget > 1 + 1e-9) {
    throw new AgentLeagueDecisionError(`cash_target 必须在 ${rules.minCashWeight}-1 之间`);
  }
  const combined = totalWeight + cashTarget;
  if (Math.abs(combined - 1) > 0.02) {
    throw new AgentLeagueDecisionError(`targets 权重与 cash_target 之和必须接近 1，当前为 ${combined.toFixed(4)}`);
  }
  if (!decision.reflection || typeof decision.reflection !== 'object' || Array.isArray(decision.reflection)) {
    throw new AgentLeagueDecisionError('reflection 是每日必填项');
  }
  const kept = String(decision.reflection.kept || '').trim().slice(0, 1200);
  const mistake = String(decision.reflection.mistake || '').trim().slice(0, 1200);
  const lessonCandidate = String(decision.reflection.lesson_candidate || '').trim().slice(0, 1200);
  if (!kept || !mistake || !lessonCandidate) {
    throw new AgentLeagueDecisionError('reflection.kept、mistake、lesson_candidate 每日都必须填写；没有错误时可明确写“无”');
  }
  const reflection = {
      kept,
      mistake,
      lesson_candidate: lessonCandidate,
      evidence_for: Array.isArray(decision.reflection.evidence_for)
        ? decision.reflection.evidence_for.map(String).slice(0, 8)
        : [],
      evidence_against: Array.isArray(decision.reflection.evidence_against)
        ? decision.reflection.evidence_against.map(String).slice(0, 8)
        : [],
    };
  const strategyProposal = decision.strategy_proposal && typeof decision.strategy_proposal === 'object'
    ? {
      hypothesis: String(decision.strategy_proposal.hypothesis || '').trim().slice(0, 1200),
      proposed_change: String(decision.strategy_proposal.proposed_change || '').trim().slice(0, 1200),
      success_metric: String(decision.strategy_proposal.success_metric || '').trim().slice(0, 600),
      expires_after_days: Math.max(3, Math.min(60, Math.round(asFinite(decision.strategy_proposal.expires_after_days, 10)))),
    }
    : null;
  return {
    action_summary: String(decision.action_summary || '').trim().slice(0, 1200),
    market_view: String(decision.market_view || '').trim().slice(0, 1600),
    cash_target: Math.round(Math.max(cashTarget, 1 - totalWeight) * 1e6) / 1e6,
    targets: normalizedTargets,
    risk_notes: Array.isArray(decision.risk_notes) ? decision.risk_notes.map(String).slice(0, 10) : [],
    reflection,
    strategy_proposal: strategyProposal,
  };
}

function normalizePortfolio(portfolio = {}) {
  const initialCash = Math.max(1, asFinite(portfolio.initialCash, 1000000));
  return {
    schemaVersion: 1,
    initialCash,
    cash: roundMoney(asFinite(portfolio.cash, initialCash)),
    positions: Array.isArray(portfolio.positions)
      ? portfolio.positions.map((row) => ({
        symbol: String(row.symbol || '').toUpperCase(),
        name: String(row.name || row.symbol || ''),
        quantity: Math.max(0, Math.round(asFinite(row.quantity, 0))),
        avgCost: roundPrice(asFinite(row.avgCost, 0)),
        lastPrice: roundPrice(asFinite(row.lastPrice, row.avgCost || 0)),
      })).filter((row) => row.quantity > 0 && SYMBOL_RE.test(row.symbol))
      : [],
    pendingDecision: portfolio.pendingDecision && typeof portfolio.pendingDecision === 'object'
      ? { ...portfolio.pendingDecision }
      : null,
    navHistory: Array.isArray(portfolio.navHistory) ? portfolio.navHistory.map((row) => ({ ...row })) : [],
    updatedAt: portfolio.updatedAt || null,
  };
}

function snapshotPriceMap(snapshot) {
  const rows = snapshot && snapshot.prices && typeof snapshot.prices === 'object' ? snapshot.prices : {};
  const result = new Map();
  for (const [symbolRaw, rowRaw] of Object.entries(rows)) {
    const symbol = String(symbolRaw || '').toUpperCase();
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : { close: rowRaw };
    const close = asFinite(row.close != null ? row.close : row.price);
    if (!SYMBOL_RE.test(symbol) || close == null || close <= 0) continue;
    result.set(symbol, { symbol, name: String(row.name || symbol), close: roundPrice(close) });
  }
  return result;
}

function requirePrices(symbols, prices) {
  const missing = [...symbols].filter((symbol) => !prices.has(symbol));
  if (missing.length) {
    throw new AgentLeagueDecisionError(`冻结行情缺少价格：${missing.join(', ')}`, 'snapshot-price-missing');
  }
}

function fees(side, notional, rules) {
  const commission = roundMoney(Math.max(rules.minimumCommission, notional * rules.commissionRate));
  const tax = side === 'sell' ? roundMoney(notional * rules.sellTaxRate) : 0;
  const transfer = roundMoney(notional * rules.transferFeeRate);
  return { commission, tax, transfer, total: roundMoney(commission + tax + transfer) };
}

function markPortfolio(portfolioInput, snapshot, options = {}) {
  const portfolio = normalizePortfolio(portfolioInput);
  const prices = options.prices || snapshotPriceMap(snapshot);
  requirePrices(new Set(portfolio.positions.map((row) => row.symbol)), prices);
  let marketValue = 0;
  portfolio.positions = portfolio.positions.map((position) => {
    const price = prices.get(position.symbol).close;
    const value = roundMoney(position.quantity * price);
    marketValue += value;
    return { ...position, name: prices.get(position.symbol).name || position.name, lastPrice: price, marketValue: value };
  });
  const nav = roundMoney(portfolio.cash + marketValue);
  const previous = portfolio.navHistory.length ? portfolio.navHistory[portfolio.navHistory.length - 1] : null;
  const dailyReturn = previous && Number(previous.nav) > 0 ? nav / Number(previous.nav) - 1 : 0;
  const date = String(snapshot && snapshot.asOf || '');
  const point = { date, nav, cash: portfolio.cash, marketValue: roundMoney(marketValue), dailyReturn };
  if (date) {
    const existingIndex = portfolio.navHistory.findIndex((row) => row.date === date);
    if (existingIndex >= 0) portfolio.navHistory[existingIndex] = point;
    else portfolio.navHistory.push(point);
  }
  portfolio.updatedAt = new Date().toISOString();
  return { portfolio, nav, marketValue: roundMoney(marketValue), dailyReturn };
}

function settlePendingTargets(portfolioInput, snapshot, options = {}) {
  const rules = { ...DEFAULT_RULES, ...(options.rules || {}) };
  const portfolio = normalizePortfolio(portfolioInput);
  const pending = portfolio.pendingDecision;
  const snapshotDate = String(snapshot && snapshot.asOf || '');
  if (!pending || !pending.decision || !pending.decisionAsOf || snapshotDate <= String(pending.decisionAsOf)) {
    return { ...markPortfolio(portfolio, snapshot), trades: [], settled: false, reason: pending ? 'awaiting-newer-snapshot' : 'no-pending-decision' };
  }
  const decision = pending.decision;
  const prices = snapshotPriceMap(snapshot);
  const symbols = new Set([
    ...portfolio.positions.map((row) => row.symbol),
    ...decision.targets.map((row) => row.symbol),
  ]);
  requirePrices(symbols, prices);
  const before = markPortfolio(portfolio, { ...snapshot, asOf: '' }, { prices });
  const beforeNav = before.nav;
  let working = before.portfolio;
  const existing = new Map(working.positions.map((row) => [row.symbol, { ...row }]));
  const desired = new Map();
  for (const target of decision.targets) {
    const price = prices.get(target.symbol).close;
    const quantity = Math.floor((beforeNav * target.target_weight) / price / rules.lotSize) * rules.lotSize;
    desired.set(target.symbol, { target, quantity });
  }
  for (const position of working.positions) {
    if (!desired.has(position.symbol)) desired.set(position.symbol, { target: { symbol: position.symbol, name: position.name, target_weight: 0 }, quantity: 0 });
  }
  const trades = [];
  const nowIso = new Date().toISOString();
  const sellSymbols = [...desired.keys()].filter((symbol) => (existing.get(symbol)?.quantity || 0) > desired.get(symbol).quantity).sort();
  for (const symbol of sellSymbols) {
    const current = existing.get(symbol);
    const target = desired.get(symbol);
    const quantity = current.quantity - target.quantity;
    const referencePrice = prices.get(symbol).close;
    const executionPrice = roundPrice(referencePrice * (1 - rules.slippageRate));
    const notional = roundMoney(quantity * executionPrice);
    const fee = fees('sell', notional, rules);
    const proceeds = roundMoney(notional - fee.total);
    working.cash = roundMoney(working.cash + proceeds);
    const realizedPnl = roundMoney((executionPrice - current.avgCost) * quantity - fee.total);
    trades.push({
      date: snapshotDate, side: 'SELL', symbol, name: current.name, quantity,
      referencePrice, executionPrice, notional, commission: fee.commission,
      tax: fee.tax, transferFee: fee.transfer, realizedPnl,
      targetWeight: target.target.target_weight || 0, createdAt: nowIso,
    });
    if (target.quantity <= 0) existing.delete(symbol);
    else existing.set(symbol, { ...current, quantity: target.quantity, lastPrice: referencePrice });
  }
  const buySymbols = [...desired.keys()].filter((symbol) => (existing.get(symbol)?.quantity || 0) < desired.get(symbol).quantity).sort();
  for (const symbol of buySymbols) {
    const target = desired.get(symbol);
    const current = existing.get(symbol) || { symbol, name: target.target.name || prices.get(symbol).name, quantity: 0, avgCost: 0 };
    let quantity = target.quantity - current.quantity;
    const referencePrice = prices.get(symbol).close;
    const executionPrice = roundPrice(referencePrice * (1 + rules.slippageRate));
    let notional = roundMoney(quantity * executionPrice);
    let fee = fees('buy', notional, rules);
    while (quantity >= rules.lotSize && roundMoney(notional + fee.total) > working.cash) {
      quantity -= rules.lotSize;
      notional = roundMoney(quantity * executionPrice);
      fee = quantity > 0 ? fees('buy', notional, rules) : { commission: 0, tax: 0, transfer: 0, total: 0 };
    }
    if (quantity <= 0) continue;
    const totalCost = roundMoney(notional + fee.total);
    working.cash = roundMoney(working.cash - totalCost);
    const newQuantity = current.quantity + quantity;
    const oldBasis = current.quantity * current.avgCost;
    const avgCost = roundPrice((oldBasis + totalCost) / newQuantity);
    existing.set(symbol, { ...current, quantity: newQuantity, avgCost, lastPrice: referencePrice });
    trades.push({
      date: snapshotDate, side: 'BUY', symbol, name: current.name, quantity,
      referencePrice, executionPrice, notional, commission: fee.commission,
      tax: 0, transferFee: fee.transfer, realizedPnl: 0,
      targetWeight: target.target.target_weight || 0, createdAt: nowIso,
    });
  }
  working.positions = [...existing.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  working.pendingDecision = null;
  const marked = markPortfolio(working, snapshot, { prices });
  return { ...marked, trades, settled: true, reason: 'settled-at-next-close' };
}

function computeStats(portfolioInput, trades = []) {
  const portfolio = normalizePortfolio(portfolioInput);
  const history = portfolio.navHistory.filter((row) => Number.isFinite(Number(row.nav)) && Number(row.nav) > 0);
  const latest = history.length ? history[history.length - 1] : { nav: portfolio.initialCash, dailyReturn: 0 };
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const row of history) {
    const nav = Number(row.nav);
    peak = Math.max(peak, nav);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  const sells = trades.filter((row) => String(row.side).toUpperCase() === 'SELL');
  const winners = sells.filter((row) => Number(row.realizedPnl) > 0);
  const marketValue = portfolio.positions.reduce((sum, row) => sum + Number(row.marketValue || row.quantity * row.lastPrice || 0), 0);
  const turnover = trades.reduce((sum, row) => sum + Math.abs(Number(row.notional || 0)), 0) / portfolio.initialCash;
  const nav = Number(latest.nav || portfolio.initialCash);
  return {
    schemaVersion: 1,
    nav: roundMoney(nav),
    totalReturn: nav / portfolio.initialCash - 1,
    dailyReturn: Number(latest.dailyReturn || 0),
    maxDrawdown,
    cash: roundMoney(portfolio.cash),
    cashWeight: nav > 0 ? portfolio.cash / nav : 1,
    positionWeight: nav > 0 ? marketValue / nav : 0,
    positions: portfolio.positions.length,
    tradeCount: trades.length,
    sellCount: sells.length,
    winRate: sells.length ? winners.length / sells.length : null,
    turnover,
    tradingDays: history.length,
    lastAsOf: history.length ? String(latest.date || '') : '',
  };
}

module.exports = {
  AgentLeagueDecisionError,
  DEFAULT_RULES,
  SYMBOL_RE,
  computeStats,
  markPortfolio,
  normalizePortfolio,
  parseDecisionMarkdown,
  settlePendingTargets,
  snapshotPriceMap,
  validateDecision,
};
