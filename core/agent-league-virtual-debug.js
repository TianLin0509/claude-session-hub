'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AgentLeagueStore } = require('./agent-league-store.js');
const {
  markPortfolio,
  settlePendingTargets,
  validateDecision,
} = require('./agent-league-accounting.js');
const {
  chinaClock,
  nextTradingDay,
  previousTradingDay,
  tradingDayStatus,
} = require('./agent-league-calendar.js');
const { getPhilosophy } = require('./agent-league-philosophies.js');
const { DEFAULT_MODEL_BY_KIND } = require('./model-options.js');

const VIRTUAL_DEBUG_DIRNAME = '_virtual_debug';
const CONFIG_NAME = 'VIRTUAL_DEBUG.json';

const VIRTUAL_UNIVERSE = Object.freeze([
  Object.freeze({
    symbol: '600001.SH', name: '虚拟样本·价值修复', basePrice: 10,
    mode: 'setup', score: 88,
    summary: '纯虚拟证据：订单与经营现金流连续改善，估值低于自身历史中位；催化是下一次经营数据验证。反证是改善可能不可持续。仅供调试，不代表真实证券信息。',
    tech: Object.freeze({ p_rs: 0.68, bias20: 0.025, ret5: 0.018, ret20: 0.052, dd60: -0.08, vr: 1.35, temp: 'warm' }),
  }),
  Object.freeze({
    symbol: '000001.SZ', name: '虚拟样本·质量成长', basePrice: 12.5,
    mode: 'setup', score: 84,
    summary: '纯虚拟证据：盈利质量和毛利率稳定，预期差来自市场仍按旧增速定价；验证点是下一期收入增速。反证是行业需求走弱。仅供调试。',
    tech: Object.freeze({ p_rs: 0.61, bias20: -0.012, ret5: -0.008, ret20: 0.036, dd60: -0.11, vr: 1.12, temp: 'neutral' }),
  }),
  Object.freeze({
    symbol: '688001.SH', name: '虚拟样本·科技催化', basePrice: 40,
    mode: 'chase', score: 81,
    summary: '纯虚拟证据：新产品进入验证期，事件催化明确但估值偏高；验证点是客户导入，最强反证是兑现节奏延后。仅供调试。',
    tech: Object.freeze({ p_rs: 0.79, bias20: 0.11, ret5: 0.07, ret20: 0.16, dd60: -0.14, vr: 1.68, temp: 'hot' }),
  }),
  Object.freeze({
    symbol: '300001.SZ', name: '虚拟样本·高波动反例', basePrice: 20,
    mode: 'chase', score: 72,
    summary: '纯虚拟反例：短期动量强但缺乏可追溯基本面增量，拥挤度和回撤风险较高；用于检验 Agent 是否会拒绝只靠价格上涨追高。',
    tech: Object.freeze({ p_rs: 0.91, bias20: 0.19, ret5: 0.13, ret20: 0.28, dd60: -0.22, vr: 2.05, temp: 'hot' }),
  }),
]);

const VIRTUAL_SCENARIOS = Object.freeze({
  mixed: Object.freeze({
    id: 'mixed', label: '分化行情', description: '同时包含上涨、下跌与高波动标的。',
    openFactors: Object.freeze([1.01, 0.995, 1.02, 0.99]),
    closeFactors: Object.freeze([1.04, 0.97, 1.015, 0.95]),
  }),
  rally: Object.freeze({
    id: 'rally', label: '普涨行情', description: '用于验证正收益、仓位与榜单变化。',
    openFactors: Object.freeze([1.01, 1.008, 1.015, 1.012]),
    closeFactors: Object.freeze([1.06, 1.04, 1.075, 1.05]),
  }),
  selloff: Object.freeze({
    id: 'selloff', label: '普跌行情', description: '用于验证亏损、回撤与风控显示。',
    openFactors: Object.freeze([0.99, 0.985, 0.98, 0.975]),
    closeFactors: Object.freeze([0.95, 0.96, 0.93, 0.91]),
  }),
  flat: Object.freeze({
    id: 'flat', label: '窄幅行情', description: '用于验证费用和小幅波动下的统计精度。',
    openFactors: Object.freeze([1.001, 0.999, 1.002, 0.998]),
    closeFactors: Object.freeze([1.004, 0.996, 1.003, 0.995]),
  }),
});

function roundPrice(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function validScenario(value) {
  const key = String(value || 'mixed');
  return VIRTUAL_SCENARIOS[key] ? key : 'mixed';
}

function normalizeReferencePrices(value = {}) {
  return Object.fromEntries(VIRTUAL_UNIVERSE.map((row) => {
    const candidate = Number(value[row.symbol]);
    return [row.symbol, roundPrice(candidate > 0 ? candidate : row.basePrice)];
  }));
}

class AgentLeagueVirtualDebug {
  constructor(options = {}) {
    if (!options.liveStore) throw new Error('AgentLeagueVirtualDebug requires liveStore');
    this.liveStore = options.liveStore;
    this.root = path.resolve(options.root || path.join(this.liveStore.root, VIRTUAL_DEBUG_DIRNAME));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this._assertSafeRoot();
    this.store = options.store || new AgentLeagueStore({ root: this.root, now: this.now });
    this.configPath = path.join(this.root, CONFIG_NAME);
  }

  _assertSafeRoot() {
    const liveRoot = path.resolve(this.liveStore.root);
    if (path.dirname(this.root) !== liveRoot || path.basename(this.root) !== VIRTUAL_DEBUG_DIRNAME) {
      throw new Error(`virtual debug root must be ${path.join(liveRoot, VIRTUAL_DEBUG_DIRNAME)}`);
    }
  }

  _readConfig() {
    try {
      const value = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return value && value.schemaVersion === 1 ? value : null;
    } catch {
      return null;
    }
  }

  _defaultVirtualDate(inputDate = '') {
    const requested = String(inputDate || chinaClock(new Date(this.now())).date).slice(0, 10);
    const status = tradingDayStatus(requested);
    const date = status.isTradingDay ? requested : nextTradingDay(requested);
    if (!date) throw new Error(`虚拟日期超出已核验交易日历：${requested}`);
    return date;
  }

  _writeConfig(value) {
    const next = {
      ...value,
      schemaVersion: 1,
      scenario: validScenario(value.scenario),
      referencePrices: normalizeReferencePrices(value.referencePrices),
      updatedAt: new Date(this.now()).toISOString(),
    };
    atomicWriteJson(this.configPath, next);
    return next;
  }

  _requireConfig() {
    const value = this._readConfig();
    if (!value) throw new Error('虚拟实盘尚未初始化');
    return value;
  }

  _cloneAgent(row) {
    const philosophy = getPhilosophy(row.agent.philosophyKey) || {
      key: row.agent.philosophyKey || 'virtual-custom',
      title: row.agent.philosophyTitle || '自定义理念',
      summary: '从实盘联赛复制到隔离虚拟调试沙盒。',
      horizon: row.strategy.horizon || '5-20 个交易日',
      maxSingleWeight: row.strategy.maxSingleWeight || 0.30,
      maxGrossWeight: row.strategy.maxGrossWeight || 0.95,
      checklist: row.checklist.rules || [],
    };
    this.store.createAgent({
      id: row.agent.id,
      name: row.agent.name,
      provider: row.agent.provider,
      kind: row.agent.kind,
      model: row.agent.model,
      initialCash: row.agent.initialCash,
      philosophy,
    });
    for (const file of this.liveStore.listPromptFiles(row.agent.id).filter((item) => item.editable)) {
      this.store.savePromptFile(row.agent.id, file.key, file.content, '', { actor: '虚拟调试沙盒初始化' });
    }
  }

  _seedAgents() {
    if (this.store.listAgents().length) return;
    const liveRows = this.liveStore.listAgents();
    if (liveRows.length) {
      for (const row of liveRows) this._cloneAgent(row);
      return;
    }
    const philosophy = getPhilosophy('chuxin-value-speculation');
    this.store.createAgent({
      id: 'virtual-codex-baseline',
      name: '虚拟 Codex 基准',
      provider: 'codex-cli',
      kind: 'codex',
      model: DEFAULT_MODEL_BY_KIND.codex || 'gpt-5.6-sol',
      initialCash: 500000,
      philosophy,
    });
  }

  initialize(input = {}) {
    let config = this._readConfig();
    if (!config) {
      config = this._writeConfig({
        virtualDate: this._defaultVirtualDate(input.virtualDate),
        scenario: validScenario(input.scenario),
        dayIndex: 0,
        referencePrices: normalizeReferencePrices(),
        initializedAt: new Date(this.now()).toISOString(),
      });
    }
    this._seedAgents();
    return this.publicState(input.runState || null);
  }

  reset(input = {}) {
    this._assertSafeRoot();
    if (input.runState) throw new Error('虚拟赛程运行中，不能重置沙盒');
    const rows = this.store.listAgents();
    if (input.sessionManager) {
      for (const row of rows) {
        const sessionId = row.session && row.session.hubSessionId;
        if (sessionId && input.sessionManager.getSession(sessionId)) input.sessionManager.closeSession(sessionId);
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true });
    // AgentLeagueStore is stateless apart from resolved paths. Recreating one
    // instance restores the directory contract; the registered runtime can keep
    // using its original store object against the same exact root.
    new AgentLeagueStore({ root: this.root, now: this.now });
    this._writeConfig({
      virtualDate: this._defaultVirtualDate(input.virtualDate),
      scenario: validScenario(input.scenario),
      dayIndex: 0,
      referencePrices: normalizeReferencePrices(),
      initializedAt: new Date(this.now()).toISOString(),
      resetAt: new Date(this.now()).toISOString(),
    });
    this._seedAgents();
    return this.publicState(null);
  }

  _phase(config, runState = null) {
    if (runState) return runState.mode === 'weekly' ? 'weekly-running' : 'decision-running';
    const schedule = this.store.getSchedule();
    if (schedule.lastResultDate === config.virtualDate && schedule.lastResultStatus === 'completed') return 'closed';
    if (schedule.lastExecutionDate === config.virtualDate && ['completed', 'partial'].includes(schedule.lastExecutionStatus)) return 'intraday';
    if (schedule.lastDecisionDate === config.virtualDate && ['completed', 'partial'].includes(schedule.lastRunStatus)) return 'decision-ready';
    return 'pre-market';
  }

  publicState(runState = null) {
    const config = this._readConfig();
    if (!config) {
      return {
        initialized: false,
        root: this.root,
        isolated: true,
        synthetic: true,
        scenarios: Object.values(VIRTUAL_SCENARIOS).map(({ id, label, description }) => ({ id, label, description })),
      };
    }
    const scenario = VIRTUAL_SCENARIOS[validScenario(config.scenario)];
    return {
      initialized: true,
      root: this.root,
      isolated: true,
      synthetic: true,
      virtualDate: config.virtualDate,
      scenario: scenario.id,
      scenarioLabel: scenario.label,
      phase: this._phase(config, runState),
      dayIndex: Number(config.dayIndex || 0),
      agentCount: this.store.listAgents().length,
      scenarios: Object.values(VIRTUAL_SCENARIOS).map(({ id, label, description }) => ({ id, label, description })),
      updatedAt: config.updatedAt,
    };
  }

  configure(input = {}) {
    const config = this._requireConfig();
    const phase = this._phase(config, input.runState || null);
    if (phase !== 'pre-market') throw new Error('仅盘前阶段可切换虚拟行情；完成当前日后请进入下一交易日');
    this._writeConfig({ ...config, scenario: validScenario(input.scenario || config.scenario) });
    return this.publicState(input.runState || null);
  }

  advance(input = {}) {
    const config = this._requireConfig();
    if (input.runState) throw new Error('虚拟赛程运行中，不能推进日期');
    const schedule = this.store.getSchedule();
    if (schedule.lastResultDate !== config.virtualDate || schedule.lastResultStatus !== 'completed') {
      throw new Error(`请先完成 ${config.virtualDate} 的收盘记账，再推进下一交易日`);
    }
    const close = this.store.getSnapshot(config.virtualDate, 'close');
    if (!close) throw new Error(`${config.virtualDate} 缺少虚拟收盘快照`);
    const referencePrices = normalizeReferencePrices(Object.fromEntries(
      Object.entries(close.prices || {}).map(([symbol, row]) => [symbol, row.close]),
    ));
    const date = nextTradingDay(config.virtualDate);
    if (!date) throw new Error('下一交易日超出已核验日历覆盖范围');
    this._writeConfig({
      ...config,
      virtualDate: date,
      scenario: validScenario(input.scenario || config.scenario),
      dayIndex: Number(config.dayIndex || 0) + 1,
      referencePrices,
    });
    return this.publicState(null);
  }

  getVirtualDate() {
    return this._requireConfig().virtualDate;
  }

  _candidateRows(config) {
    const reference = normalizeReferencePrices(config.referencePrices);
    return VIRTUAL_UNIVERSE.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      mode: row.mode,
      score: row.score,
      close: reference[row.symbol],
      state: 'virtual-debug',
      summary: row.summary,
      tech: { ...row.tech },
    }));
  }

  async buildDecisionSnapshot(options = {}) {
    const config = this._requireConfig();
    const decisionFor = String(options.decisionFor || config.virtualDate).slice(0, 10);
    if (decisionFor !== config.virtualDate) throw new Error(`虚拟时钟当前是 ${config.virtualDate}，不能生成 ${decisionFor} 的盘前快照`);
    const existing = this.store.getSnapshot(decisionFor, 'decision');
    if (existing) return existing;
    const dataAsOf = previousTradingDay(decisionFor);
    if (!dataAsOf) throw new Error(`无法解析 ${decisionFor} 的上一交易日`);
    const candidates = this._candidateRows(config);
    const prices = Object.fromEntries(candidates.map((row) => [row.symbol, {
      name: row.name,
      close: row.close,
      source: '虚拟调试·确定性前收盘',
    }]));
    const snapshot = {
      schemaVersion: 2,
      phase: 'decision',
      virtualDebug: true,
      synthetic: true,
      decisionFor,
      asOf: dataAsOf,
      createdAt: new Date(this.now()).toISOString(),
      compileId: `virtual-debug-day-${config.dayIndex}`,
      candidates,
      prices,
      sourceHealth: { virtualDebug: 'deterministic-synthetic', liveMarket: 'not-used' },
    };
    snapshot.snapshotId = `virtual-${decisionFor}-decision-${sha256(JSON.stringify({ candidates, prices })).slice(0, 12)}`;
    return this.store.saveSnapshot(snapshot);
  }

  _marketRows(config, phase) {
    const scenario = VIRTUAL_SCENARIOS[validScenario(config.scenario)];
    const reference = normalizeReferencePrices(config.referencePrices);
    return Object.fromEntries(VIRTUAL_UNIVERSE.map((row, index) => {
      const open = roundPrice(reference[row.symbol] * scenario.openFactors[index]);
      const close = phase === 'open'
        ? open
        : roundPrice(reference[row.symbol] * scenario.closeFactors[index]);
      return [row.symbol, {
        name: row.name,
        open,
        close,
        quoteAt: `${config.virtualDate}T${phase === 'open' ? '09:35:00' : '15:10:00'}+08:00`,
        tradable: true,
        source: `虚拟调试·${scenario.label}`,
      }];
    }));
  }

  async buildPriceSnapshot(options = {}) {
    const config = this._requireConfig();
    const phase = options.phase === 'close' ? 'close' : 'open';
    const decisionFor = String(options.decisionFor || config.virtualDate).slice(0, 10);
    if (decisionFor !== config.virtualDate) throw new Error(`虚拟时钟当前是 ${config.virtualDate}，不能生成 ${decisionFor} 的${phase === 'open' ? '开盘' : '收盘'}快照`);
    const schedule = this.store.getSchedule();
    if (phase === 'open' && (
      schedule.lastDecisionDate !== decisionFor
      || !['completed', 'partial'].includes(schedule.lastRunStatus)
    )) {
      throw new Error(`虚拟开盘前必须先完成 ${decisionFor} 的 AI 盘前决策`);
    }
    if (phase === 'close' && (
      schedule.lastExecutionDate !== decisionFor
      || !['completed', 'partial'].includes(schedule.lastExecutionStatus)
    )) {
      throw new Error(`虚拟收盘前必须先完成 ${decisionFor} 的开盘执行`);
    }
    const symbols = [...new Set(options.symbols || [])].map((value) => String(value).toUpperCase());
    const allRows = this._marketRows(config, phase);
    const unknown = symbols.filter((symbol) => !allRows[symbol]);
    if (unknown.length) throw new Error(`虚拟行情不包含：${unknown.join(', ')}`);
    const existing = this.store.getSnapshot(decisionFor, phase);
    if (existing) {
      const missing = symbols.filter((symbol) => !existing.prices || !existing.prices[symbol]);
      if (!missing.length) return existing;
      throw new Error(`虚拟${phase === 'open' ? '开盘' : '收盘'}快照已冻结且缺少：${missing.join(', ')}`);
    }
    // Freeze the whole synthetic universe, not only currently-held symbols.
    // Otherwise an unheld candidate would jump back to its day-zero base price
    // after advance(), making multi-day scenario tests internally inconsistent.
    const prices = { ...allRows };
    const snapshot = {
      schemaVersion: 2,
      phase,
      virtualDebug: true,
      synthetic: true,
      decisionFor,
      asOf: decisionFor,
      createdAt: new Date(this.now()).toISOString(),
      candidates: [],
      prices,
      sourceHealth: { virtualDebug: 'deterministic-synthetic', liveMarket: 'not-used' },
    };
    snapshot.snapshotId = `virtual-${decisionFor}-${phase}-${sha256(JSON.stringify(prices)).slice(0, 12)}`;
    return this.store.saveSnapshot(snapshot);
  }

  async fetchTargetContexts(options = {}) {
    const config = this._requireConfig();
    const candidates = new Map(this._candidateRows(config).map((row) => [row.symbol, row]));
    const prices = normalizeReferencePrices(config.referencePrices);
    const targetDate = String(options.targetDate || previousTradingDay(config.virtualDate) || '').slice(0, 10);
    return Object.fromEntries([...new Set(options.symbols || [])].map((value) => {
      const symbol = String(value).toUpperCase();
      const row = candidates.get(symbol);
      return [symbol, row ? {
        ok: true,
        symbol,
        name: row.name,
        close: prices[symbol],
        open: null,
        quoteAt: `${targetDate}T15:00:00+08:00`,
        quoteDate: targetDate,
        source: '虚拟调试·冻结上下文',
        tradable: true,
        confidence: 'synthetic-deterministic',
        summary: row.summary,
      } : { ok: false, symbol, error: 'virtual-symbol-not-in-snapshot' }];
    }));
  }

  selfTest() {
    const decision = validateDecision({
      action_summary: '虚拟账本自检建仓',
      market_view: '确定性合成行情，不代表真实市场',
      core_conflict: '验证交易、费用、仓位与收益率链条',
      cash_target: 0.4,
      targets: [
        {
          symbol: '600001.SH', name: '虚拟主板', target_weight: 0.35, conviction: 0.8, horizon_days: 5,
          rule_refs: ['DEBUG-1'], thesis: '确定性自检输入', counter_evidence: '仅为合成数据',
          timing_reason: '验证主板整手与费用', invalidation: '任一账本不变量失败',
        },
        {
          symbol: '688001.SH', name: '虚拟科创', target_weight: 0.25, conviction: 0.8, horizon_days: 5,
          rule_refs: ['DEBUG-2'], thesis: '确定性自检输入', counter_evidence: '仅为合成数据',
          timing_reason: '验证科创板最小申报', invalidation: '任一账本不变量失败',
        },
      ],
      watchlist: [], risk_notes: ['不写入联赛状态'], memory_note: '纯内存自检',
    });
    const opened = settlePendingTargets({
      initialCash: 500000,
      cash: 500000,
      positions: [],
      navHistory: [],
      pendingDecision: { runId: 'virtual-self-test', decisionDate: '2026-08-31', decisionDataAsOf: '2026-08-28', decision },
    }, {
      asOf: '2026-08-31',
      prices: {
        '600001.SH': { name: '虚拟主板', open: 10, close: 10, source: 'virtual-self-test' },
        '688001.SH': { name: '虚拟科创', open: 40, close: 40, source: 'virtual-self-test' },
      },
    });
    const closed = markPortfolio(opened.portfolio, {
      asOf: '2026-08-31',
      prices: {
        '600001.SH': { name: '虚拟主板', close: 10.5, source: 'virtual-self-test' },
        '688001.SH': { name: '虚拟科创', close: 38, source: 'virtual-self-test' },
      },
    });
    const exitDecision = validateDecision({
      action_summary: '虚拟账本自检清仓', market_view: '确定性合成行情', core_conflict: '验证卖出税费',
      cash_target: 1, targets: [], watchlist: [], risk_notes: [], memory_note: '纯内存自检',
    });
    const exitPortfolio = {
      ...closed.portfolio,
      pendingDecision: { runId: 'virtual-self-test-exit', decisionDate: '2026-09-01', decisionDataAsOf: '2026-08-31', decision: exitDecision },
    };
    const exited = settlePendingTargets(exitPortfolio, {
      asOf: '2026-09-01',
      prices: {
        '600001.SH': { name: '虚拟主板', open: 10.6, close: 10.6, source: 'virtual-self-test' },
        '688001.SH': { name: '虚拟科创', open: 38.2, close: 38.2, source: 'virtual-self-test' },
      },
    });
    const expectedDailyReturn = closed.nav / 500000 - 1;
    const checks = [
      { id: 'synthetic-only', pass: true, detail: '未调用实时行情，未写入任何联赛文件' },
      { id: 'buy-orders', pass: opened.settled && opened.trades.length === 2, detail: `${opened.trades.length} 笔买入` },
      { id: 'board-lots', pass: opened.trades.some((row) => row.symbol === '600001.SH' && row.quantity % 100 === 0) && opened.trades.some((row) => row.symbol === '688001.SH' && row.quantity >= 200), detail: '主板整手与科创板最小申报' },
      { id: 'cash-nonnegative', pass: opened.portfolio.cash >= 0, detail: `现金 ${opened.portfolio.cash}` },
      { id: 'pending-cleared', pass: opened.portfolio.pendingDecision == null, detail: '开盘后 pending 已清除' },
      { id: 'same-day-return-baseline', pass: Math.abs(closed.dailyReturn - expectedDailyReturn) < 1e-12, detail: `dailyReturn=${closed.dailyReturn}` },
      { id: 'sell-tax', pass: exited.trades.length === 2 && exited.trades.every((row) => row.tax > 0), detail: `${exited.trades.length} 笔卖出均计印花税` },
      { id: 'positions-cleared', pass: exited.portfolio.positions.length === 0, detail: '清仓后持仓为 0' },
    ];
    return {
      ok: checks.every((row) => row.pass),
      checks,
      metrics: {
        openNav: opened.nav,
        closeNav: closed.nav,
        dailyReturn: closed.dailyReturn,
        openCash: opened.portfolio.cash,
        finalCash: exited.portfolio.cash,
        buyTrades: opened.trades.length,
        sellTrades: exited.trades.length,
      },
    };
  }
}

module.exports = {
  AgentLeagueVirtualDebug,
  CONFIG_NAME,
  VIRTUAL_DEBUG_DIRNAME,
  VIRTUAL_SCENARIOS,
  VIRTUAL_UNIVERSE,
  normalizeReferencePrices,
};
