'use strict';

// P0 只机械执行用户已经确认的账户口径，不替 Agent 判断仓位风险。
// 投资风险、集中度和现金比例由 Agent 在 CHECKLIST + Hook 中自行判断。
const DEFAULT_RULES = Object.freeze({
  maxTargets: 30,
  maxSingleWeight: 1,
  minCashWeight: 0,
  commissionRate: 0.0001,
  minimumCommission: 0,
  sellTaxRate: 0.001,
  transferFeeRate: 0,
  slippageRate: 0,
  executionPriceField: 'open',
});

const SYMBOL_RE = /^\d{6}\.(SH|SZ)$/;
const STAR_BOARD_RE = /^(688|689)\d{3}\.SH$/;
const HOOK_VERDICTS = new Set(['PASS', 'REVISE', 'HOLD']);

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

function cleanText(value, maxLength = 1200) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function parseNamedJsonBlock(markdown, blockName, options = {}) {
  const text = String(markdown || '');
  const escaped = String(blockName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = [...text.matchAll(new RegExp(`\\\`\\\`\\\`${escaped}\\s*([\\s\\S]*?)\\\`\\\`\\\``, 'gi'))];
  const generic = named.length || options.namedOnly
    ? []
    : [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = named.length ? named : generic;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index][1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new AgentLeagueDecisionError(`回复缺少可解析的 ${blockName} JSON 代码块`, `${blockName}-block-missing`);
}

function parseDecisionMarkdown(markdown) {
  return parseNamedJsonBlock(markdown, 'agent-league-decision');
}

function parseDraftMarkdown(markdown) {
  return parseNamedJsonBlock(markdown, 'agent-league-draft', { namedOnly: true });
}

function parseHookMarkdown(markdown) {
  return parseNamedJsonBlock(markdown, 'agent-league-hook', { namedOnly: true });
}

function parseWeeklyMarkdown(markdown) {
  return parseNamedJsonBlock(markdown, 'agent-league-weekly', { namedOnly: true });
}

function validateDecision(decision, options = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new AgentLeagueDecisionError('决策必须是 JSON object');
  }
  const rules = { ...DEFAULT_RULES, ...(options.rules || {}) };
  const allowedSymbols = options.allowedSymbols instanceof Set ? options.allowedSymbols : null;
  const existingSymbols = options.existingSymbols instanceof Set ? options.existingSymbols : new Set();
  const requireRuleRefs = options.requireRuleRefs !== false;
  const targets = Array.isArray(decision.targets) ? decision.targets : null;
  if (!targets || targets.length > rules.maxTargets) {
    throw new AgentLeagueDecisionError(`targets 必须是不超过 ${rules.maxTargets} 项的数组`);
  }
  const seen = new Set();
  let totalWeight = 0;
  const normalizedTargets = targets.map((target) => {
    if (!target || typeof target !== 'object') throw new AgentLeagueDecisionError('每个 target 必须是 object');
    const symbol = String(target.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new AgentLeagueDecisionError(`股票代码格式无效或不在沪深市场：${symbol || '(empty)'}`);
    if (seen.has(symbol)) throw new AgentLeagueDecisionError(`targets 存在重复股票：${symbol}`);
    if (allowedSymbols && !allowedSymbols.has(symbol) && !existingSymbols.has(symbol)) {
      throw new AgentLeagueDecisionError(`股票不在允许范围或当前持仓中：${symbol}`, 'symbol-not-allowed');
    }
    seen.add(symbol);
    const targetWeight = asFinite(target.target_weight);
    if (targetWeight == null || targetWeight < 0 || targetWeight > rules.maxSingleWeight + 1e-9) {
      throw new AgentLeagueDecisionError(`${symbol} 目标权重必须在 0-${rules.maxSingleWeight} 之间`);
    }
    totalWeight += targetWeight;
    const ruleRefs = Array.isArray(target.rule_refs)
      ? [...new Set(target.rule_refs.map((value) => cleanText(value, 40)).filter(Boolean))].slice(0, 12)
      : [];
    if (requireRuleRefs && !ruleRefs.length) {
      throw new AgentLeagueDecisionError(`${symbol} 必须引用 CHECKLIST.md 的 rule_refs`, 'rule-refs-missing');
    }
    const thesis = cleanText(target.thesis, 1000);
    const counterEvidence = cleanText(target.counter_evidence, 800);
    const invalidation = cleanText(target.invalidation, 800);
    const timingReason = cleanText(target.timing_reason, 600);
    if (!thesis || !counterEvidence || !invalidation || !timingReason) {
      throw new AgentLeagueDecisionError(`${symbol} 必须填写 thesis、counter_evidence、invalidation 和 timing_reason`);
    }
    const conviction = asFinite(target.conviction, 0.5);
    const horizonDays = Math.max(1, Math.min(365, Math.round(asFinite(target.horizon_days, 10))));
    return {
      symbol,
      name: cleanText(target.name || symbol, 80),
      target_weight: Math.round(targetWeight * 1e6) / 1e6,
      conviction: Math.max(0, Math.min(1, conviction)),
      horizon_days: horizonDays,
      thesis,
      counter_evidence: counterEvidence,
      invalidation,
      timing_reason: timingReason,
      rule_refs: ruleRefs,
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
  const actionSummary = cleanText(decision.action_summary, 1200);
  const marketView = cleanText(decision.market_view, 1600);
  const coreConflict = cleanText(decision.core_conflict, 1000);
  if (!actionSummary || !marketView || !coreConflict) {
    throw new AgentLeagueDecisionError('action_summary、market_view、core_conflict 都是必填项');
  }
  const watchlist = Array.isArray(decision.watchlist) ? decision.watchlist.slice(0, 12).map((row) => ({
    symbol: String(row && row.symbol || '').toUpperCase(),
    reason: cleanText(row && row.reason, 500),
    trigger: cleanText(row && row.trigger, 500),
  })).filter((row) => SYMBOL_RE.test(row.symbol) && row.reason && row.trigger) : [];
  return {
    action_summary: actionSummary,
    market_view: marketView,
    core_conflict: coreConflict,
    cash_target: Math.round(Math.max(cashTarget, 1 - totalWeight) * 1e6) / 1e6,
    targets: normalizedTargets,
    watchlist,
    risk_notes: Array.isArray(decision.risk_notes) ? decision.risk_notes.map((value) => cleanText(value, 500)).filter(Boolean).slice(0, 12) : [],
    memory_note: cleanText(decision.memory_note, 1000),
  };
}

function decisionAllocation(decision) {
  return JSON.stringify({
    cash_target: Number(decision.cash_target || 0),
    targets: [...(decision.targets || [])]
      .map((row) => [row.symbol, Number(row.target_weight || 0)])
      .sort((a, b) => a[0].localeCompare(b[0])),
  });
}

function validateHookReview(review, options = {}) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new AgentLeagueDecisionError('Hook 输出必须是 JSON object', 'invalid-hook');
  }
  const verdict = String(review.verdict || '').toUpperCase();
  if (!HOOK_VERDICTS.has(verdict)) throw new AgentLeagueDecisionError(`Hook verdict 无效：${verdict}`, 'invalid-hook-verdict');
  const draft = options.draft || null;
  const existingSymbols = options.existingSymbols instanceof Set ? options.existingSymbols : new Set();
  const draftSymbols = new Set([...(draft && draft.targets || []).map((row) => row.symbol), ...existingSymbols]);
  const finalDecision = validateDecision(review.final_decision, {
    ...(options.rules ? { rules: options.rules } : {}),
    ...(draft ? { allowedSymbols: draftSymbols } : {}),
    existingSymbols,
  });
  if (verdict === 'PASS' && draft && decisionAllocation(finalDecision) !== decisionAllocation(draft)) {
    throw new AgentLeagueDecisionError('PASS 时 FINAL 的目标组合不能偷偷改变；需要改变应使用 REVISE', 'pass-mutated-allocation');
  }
  const ruleChecks = Array.isArray(review.rule_checks) ? review.rule_checks.slice(0, 30).map((row) => ({
    rule_id: cleanText(row && row.rule_id, 40),
    status: ['PASS', 'WARN', 'FAIL'].includes(String(row && row.status || '').toUpperCase())
      ? String(row.status).toUpperCase() : 'WARN',
    comment: cleanText(row && row.comment, 600),
  })).filter((row) => row.rule_id && row.comment) : [];
  if (!ruleChecks.length) throw new AgentLeagueDecisionError('Hook 必须逐条输出 rule_checks', 'hook-rule-checks-missing');
  const strongestCounter = cleanText(review.strongest_counter_evidence, 1000);
  const timingCheck = cleanText(review.timing_check, 1000);
  const portfolioCheck = cleanText(review.portfolio_check, 1000);
  const behaviorCheck = cleanText(review.behavior_check, 1000);
  const accountCheck = cleanText(review.account_feasibility, 1000);
  if (!strongestCounter || !timingCheck || !portfolioCheck || !behaviorCheck || !accountCheck) {
    throw new AgentLeagueDecisionError('Hook 必须完成反证、时机、组合、行为和账户可行性五项检查', 'hook-checks-incomplete');
  }
  const brief = review.daily_brief && typeof review.daily_brief === 'object' ? review.daily_brief : {};
  const body = cleanText(brief.body, 1200);
  if (body.length < 80) throw new AgentLeagueDecisionError('daily_brief.body 至少 80 个字符', 'daily-brief-too-short');
  const dailyBrief = {
    headline: cleanText(brief.headline, 100),
    body,
    hook_change: cleanText(brief.hook_change, 500),
    video_hooks: Array.isArray(brief.video_hooks) ? brief.video_hooks.map((value) => cleanText(value, 180)).filter(Boolean).slice(0, 5) : [],
  };
  if (!dailyBrief.headline || !dailyBrief.hook_change) {
    throw new AgentLeagueDecisionError('daily_brief.headline 和 hook_change 必填', 'daily-brief-incomplete');
  }
  return {
    verdict,
    rule_checks: ruleChecks,
    strongest_counter_evidence: strongestCounter,
    timing_check: timingCheck,
    portfolio_check: portfolioCheck,
    behavior_check: behaviorCheck,
    account_feasibility: accountCheck,
    changes: Array.isArray(review.changes) ? review.changes.map((value) => cleanText(value, 500)).filter(Boolean).slice(0, 12) : [],
    final_decision: finalDecision,
    daily_brief: dailyBrief,
  };
}

function validateWeeklyReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new AgentLeagueDecisionError('周度沉淀必须是 JSON object', 'invalid-weekly-review');
  }
  const summary = cleanText(review.summary, 1800);
  const processWin = cleanText(review.process_win, 1200);
  const processMistake = cleanText(review.process_mistake, 1200);
  const lesson = cleanText(review.lesson, 1200);
  const strongestCounterexample = cleanText(review.strongest_counterexample, 1000);
  if (!summary || !processWin || !processMistake || !lesson || !strongestCounterexample) {
    throw new AgentLeagueDecisionError('周度沉淀缺少 summary/process_win/process_mistake/lesson/strongest_counterexample', 'weekly-review-incomplete');
  }
  const proposalRaw = review.checklist_proposal && typeof review.checklist_proposal === 'object'
    ? review.checklist_proposal : null;
  const checklistProposal = proposalRaw && cleanText(proposalRaw.rule_id, 40) ? {
    rule_id: cleanText(proposalRaw.rule_id, 40),
    old_rule: cleanText(proposalRaw.old_rule, 800),
    proposed_rule: cleanText(proposalRaw.proposed_rule, 800),
    reason: cleanText(proposalRaw.reason, 1000),
    evidence: Array.isArray(proposalRaw.evidence) ? proposalRaw.evidence.map((value) => cleanText(value, 400)).filter(Boolean).slice(0, 10) : [],
    status: 'proposed',
  } : null;
  return {
    summary,
    process_win: processWin,
    process_mistake: processMistake,
    lesson,
    strongest_counterexample: strongestCounterexample,
    evidence_for: Array.isArray(review.evidence_for) ? review.evidence_for.map((value) => cleanText(value, 500)).filter(Boolean).slice(0, 12) : [],
    evidence_against: Array.isArray(review.evidence_against) ? review.evidence_against.map((value) => cleanText(value, 500)).filter(Boolean).slice(0, 12) : [],
    checklist_proposal: checklistProposal,
  };
}

function normalizePortfolio(portfolio = {}) {
  const initialCash = Math.max(1, asFinite(portfolio.initialCash, 500000));
  return {
    schemaVersion: 2,
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
    const open = asFinite(row.open);
    if (!SYMBOL_RE.test(symbol) || close == null || close <= 0) continue;
    result.set(symbol, {
      symbol,
      name: String(row.name || symbol),
      close: roundPrice(close),
      ...(open != null && open > 0 ? { open: roundPrice(open) } : {}),
      tradable: row.tradable !== false,
      source: String(row.source || ''),
    });
  }
  return result;
}

function requirePrices(symbols, prices, field = 'close') {
  const missing = [...symbols].filter((symbol) => !prices.has(symbol) || !(Number(prices.get(symbol)[field]) > 0));
  if (missing.length) {
    throw new AgentLeagueDecisionError(`冻结行情缺少 ${field} 价格：${missing.join(', ')}`, 'snapshot-price-missing');
  }
}

function fees(side, notional, rules) {
  const commission = roundMoney(Math.max(rules.minimumCommission, notional * rules.commissionRate));
  const tax = side === 'sell' ? roundMoney(notional * rules.sellTaxRate) : 0;
  const transfer = roundMoney(notional * rules.transferFeeRate);
  return { commission, tax, transfer, total: roundMoney(commission + tax + transfer) };
}

function lotRuleForSymbol(symbol) {
  if (STAR_BOARD_RE.test(String(symbol || '').toUpperCase())) {
    return { board: 'STAR', minBuy: 200, buyStep: 1, minSell: 200, sellStep: 1 };
  }
  return { board: 'MAIN_OR_CHINEXT', minBuy: 100, buyStep: 100, minSell: 100, sellStep: 100 };
}

function targetQuantityForWeight(nav, weight, price, symbol, currentQuantity = 0) {
  if (!(price > 0) || !(weight > 0)) return 0;
  const lot = lotRuleForSymbol(symbol);
  const raw = Math.floor((nav * weight) / price);
  if (lot.board === 'STAR') {
    if (currentQuantity <= 0 && raw < lot.minBuy) return 0;
    return Math.max(0, raw);
  }
  return Math.max(0, Math.floor(raw / lot.buyStep) * lot.buyStep);
}

function executableSellQuantity(symbol, currentQuantity, desiredQuantity) {
  const lot = lotRuleForSymbol(symbol);
  const raw = Math.max(0, currentQuantity - desiredQuantity);
  if (!raw) return 0;
  if (desiredQuantity <= 0 && currentQuantity < lot.minSell) return currentQuantity;
  if (raw < lot.minSell) return 0;
  return lot.sellStep === 1 ? raw : Math.floor(raw / lot.sellStep) * lot.sellStep;
}

function executableBuyQuantity(symbol, currentQuantity, desiredQuantity) {
  const lot = lotRuleForSymbol(symbol);
  const raw = Math.max(0, desiredQuantity - currentQuantity);
  if (raw < lot.minBuy) return 0;
  return lot.buyStep === 1 ? raw : Math.floor(raw / lot.buyStep) * lot.buyStep;
}

function affordableBuyQuantity(symbol, requested, price, cash, rules) {
  const lot = lotRuleForSymbol(symbol);
  if (requested < lot.minBuy || !(price > 0) || !(cash > 0)) return 0;
  const perShare = price * (1 + rules.commissionRate + rules.transferFeeRate);
  let quantity = Math.min(requested, Math.floor(cash / perShare));
  quantity = lot.buyStep === 1 ? quantity : Math.floor(quantity / lot.buyStep) * lot.buyStep;
  while (quantity >= lot.minBuy) {
    const notional = roundMoney(quantity * price);
    if (roundMoney(notional + fees('buy', notional, rules).total) <= cash) return quantity;
    quantity -= lot.buyStep;
  }
  return 0;
}

function markPortfolio(portfolioInput, snapshot, options = {}) {
  const portfolio = normalizePortfolio(portfolioInput);
  const prices = options.prices || snapshotPriceMap(snapshot);
  requirePrices(new Set(portfolio.positions.map((row) => row.symbol)), prices, 'close');
  let marketValue = 0;
  portfolio.positions = portfolio.positions.map((position) => {
    const price = prices.get(position.symbol).close;
    const value = roundMoney(position.quantity * price);
    marketValue += value;
    return { ...position, name: prices.get(position.symbol).name || position.name, lastPrice: price, marketValue: value };
  });
  const nav = roundMoney(portfolio.cash + marketValue);
  const date = String(snapshot && snapshot.asOf || '');
  const existingIndex = date ? portfolio.navHistory.findIndex((row) => row.date === date) : -1;
  // executeOpen may mark an intraday point before recordClose replaces the same
  // trading date. The close return must still use the prior trading day's close
  // (or initial cash on day one), never that same-day opening mark.
  const previous = existingIndex >= 0
    ? portfolio.navHistory.slice(0, existingIndex).reverse().find((row) => row.date !== date) || null
    : (portfolio.navHistory.length ? portfolio.navHistory[portfolio.navHistory.length - 1] : null);
  const baselineNav = previous && Number(previous.nav) > 0 ? Number(previous.nav) : portfolio.initialCash;
  const dailyReturn = baselineNav > 0 ? nav / baselineNav - 1 : 0;
  const point = { date, nav, cash: portfolio.cash, marketValue: roundMoney(marketValue), dailyReturn };
  if (date) {
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
  const decisionDataAsOf = String(pending && (pending.decisionDataAsOf || pending.decisionAsOf) || '');
  const decisionDate = String(pending && pending.decisionDate || '');
  const eligible = pending && pending.decision && (
    decisionDate ? snapshotDate >= decisionDate : snapshotDate > decisionDataAsOf
  );
  if (!eligible) {
    return { ...markPortfolio(portfolio, snapshot), trades: [], orderNotes: [], settled: false, reason: pending ? 'awaiting-execution-snapshot' : 'no-pending-decision' };
  }
  const decision = pending.decision;
  const prices = snapshotPriceMap(snapshot);
  const executionField = String(options.executionPriceField || rules.executionPriceField || 'open');
  const symbols = new Set([
    ...portfolio.positions.map((row) => row.symbol),
    ...decision.targets.map((row) => row.symbol),
  ]);
  requirePrices(symbols, prices, 'close');
  requirePrices(symbols, prices, executionField);
  const before = markPortfolio(portfolio, { ...snapshot, asOf: '' }, { prices });
  const beforeNav = before.nav;
  const working = before.portfolio;
  const existing = new Map(working.positions.map((row) => [row.symbol, { ...row }]));
  const desired = new Map();
  const orderNotes = [];
  for (const target of decision.targets) {
    const executionPrice = prices.get(target.symbol)[executionField];
    const currentQuantity = Number(existing.get(target.symbol)?.quantity || 0);
    const quantity = targetQuantityForWeight(beforeNav, target.target_weight, executionPrice, target.symbol, currentQuantity);
    if (target.target_weight > 0 && currentQuantity <= 0 && quantity <= 0) {
      orderNotes.push({
        symbol: target.symbol,
        side: 'BUY',
        status: 'skipped',
        reason: `目标金额不足 ${lotRuleForSymbol(target.symbol).minBuy} 股最小申报`,
      });
    }
    desired.set(target.symbol, { target, quantity });
  }
  for (const position of working.positions) {
    if (!desired.has(position.symbol)) desired.set(position.symbol, { target: { symbol: position.symbol, name: position.name, target_weight: 0 }, quantity: 0 });
  }
  const trades = [];
  const createdAt = new Date().toISOString();
  const sellSymbols = [...desired.keys()].filter((symbol) => (existing.get(symbol)?.quantity || 0) > desired.get(symbol).quantity).sort();
  for (const symbol of sellSymbols) {
    const current = existing.get(symbol);
    const target = desired.get(symbol);
    const quantity = executableSellQuantity(symbol, current.quantity, target.quantity);
    if (!quantity) {
      orderNotes.push({ symbol, side: 'SELL', status: 'skipped', reason: '卖出数量不符合该板块最小申报要求' });
      continue;
    }
    const market = prices.get(symbol);
    if (market.tradable === false) {
      orderNotes.push({ symbol, side: 'SELL', status: 'unfilled', reason: '行情标记为不可交易' });
      continue;
    }
    const referencePrice = market[executionField];
    const executionPrice = roundPrice(referencePrice * (1 - rules.slippageRate));
    const notional = roundMoney(quantity * executionPrice);
    const fee = fees('sell', notional, rules);
    working.cash = roundMoney(working.cash + notional - fee.total);
    const realizedPnl = roundMoney((executionPrice - current.avgCost) * quantity - fee.total);
    trades.push({
      date: snapshotDate, side: 'SELL', symbol, name: current.name, quantity,
      referencePrice, executionPrice, notional, commission: fee.commission,
      tax: fee.tax, transferFee: fee.transfer, realizedPnl,
      targetWeight: target.target.target_weight || 0, createdAt,
      board: lotRuleForSymbol(symbol).board,
    });
    const remaining = current.quantity - quantity;
    if (remaining <= 0) existing.delete(symbol);
    else existing.set(symbol, { ...current, quantity: remaining, lastPrice: market.close });
  }
  const buySymbols = [...desired.keys()].filter((symbol) => (existing.get(symbol)?.quantity || 0) < desired.get(symbol).quantity).sort();
  for (const symbol of buySymbols) {
    const target = desired.get(symbol);
    const market = prices.get(symbol);
    const current = existing.get(symbol) || { symbol, name: target.target.name || market.name, quantity: 0, avgCost: 0 };
    const requested = executableBuyQuantity(symbol, current.quantity, target.quantity);
    if (!requested) {
      orderNotes.push({ symbol, side: 'BUY', status: 'skipped', reason: `买入数量低于 ${lotRuleForSymbol(symbol).minBuy} 股最小申报` });
      continue;
    }
    if (market.tradable === false) {
      orderNotes.push({ symbol, side: 'BUY', status: 'unfilled', reason: '行情标记为不可交易' });
      continue;
    }
    const referencePrice = market[executionField];
    const executionPrice = roundPrice(referencePrice * (1 + rules.slippageRate));
    const quantity = affordableBuyQuantity(symbol, requested, executionPrice, working.cash, rules);
    if (!quantity) {
      orderNotes.push({ symbol, side: 'BUY', status: 'rejected', reason: '模拟现金不足或不足最小申报数量' });
      continue;
    }
    if (quantity < requested) orderNotes.push({ symbol, side: 'BUY', status: 'partial', reason: `现金约束：${requested} 股缩减为 ${quantity} 股` });
    const notional = roundMoney(quantity * executionPrice);
    const fee = fees('buy', notional, rules);
    const totalCost = roundMoney(notional + fee.total);
    working.cash = roundMoney(working.cash - totalCost);
    const newQuantity = current.quantity + quantity;
    const oldBasis = current.quantity * current.avgCost;
    const avgCost = roundPrice((oldBasis + totalCost) / newQuantity);
    existing.set(symbol, { ...current, quantity: newQuantity, avgCost, lastPrice: market.close });
    trades.push({
      date: snapshotDate, side: 'BUY', symbol, name: current.name, quantity,
      referencePrice, executionPrice, notional, commission: fee.commission,
      tax: 0, transferFee: fee.transfer, realizedPnl: 0,
      targetWeight: target.target.target_weight || 0, createdAt,
      board: lotRuleForSymbol(symbol).board,
    });
  }
  working.positions = [...existing.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  working.pendingDecision = null;
  const marked = markPortfolio(working, snapshot, { prices });
  return {
    ...marked,
    trades,
    orderNotes,
    settled: true,
    reason: `settled-at-${executionField}`,
    decisionRunId: pending.runId || '',
    decisionDate: decisionDate || pending.decisionAsOf || '',
  };
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
    schemaVersion: 2,
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
  HOOK_VERDICTS,
  STAR_BOARD_RE,
  SYMBOL_RE,
  affordableBuyQuantity,
  computeStats,
  executableBuyQuantity,
  executableSellQuantity,
  fees,
  lotRuleForSymbol,
  markPortfolio,
  normalizePortfolio,
  parseDecisionMarkdown,
  parseDraftMarkdown,
  parseHookMarkdown,
  parseNamedJsonBlock,
  parseWeeklyMarkdown,
  settlePendingTargets,
  snapshotPriceMap,
  targetQuantityForWeight,
  validateDecision,
  validateHookReview,
  validateWeeklyReview,
};
