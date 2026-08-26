'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  computeStats,
  normalizePortfolio,
  settlePendingTargets,
} = require('./agent-league-accounting.js');

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const STATE_MARKER = 'agent-league-state:v1';
const RUN_LEASE_TTL_MS = 2 * 60 * 1000;

function defaultRoot(env = process.env) {
  if (env.CHUXIN_AGENT_LEAGUE_DIR) return path.resolve(env.CHUXIN_AGENT_LEAGUE_DIR);
  const chuxinDir = env.CHUXIN_DIR || 'C:\\Users\\lintian\\chuxin-research';
  return path.join(chuxinDir, 'vault', 'agent-league');
}

function nowIso(now = Date.now()) {
  return new Date(typeof now === 'number' ? now : now()).toISOString();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stateBlock(state, marker = STATE_MARKER) {
  return `<!-- ${marker}\n${JSON.stringify(state, null, 2)}\n-->`;
}

function readStateFromText(text, marker = STATE_MARKER) {
  const match = String(text || '').match(new RegExp(`<!--\\s*${escapeRegex(marker)}\\s*([\\s\\S]*?)-->`));
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); }
  catch { return null; }
}

function readMarkdownState(filePath, marker = STATE_MARKER) {
  try { return readStateFromText(fs.readFileSync(filePath, 'utf8'), marker); }
  catch { return null; }
}

function atomicWriteText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, String(text), 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(temp, filePath);
      return filePath;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code)) break;
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) { /* bounded Windows rename backoff */ }
    }
  }
  try { fs.unlinkSync(temp); } catch {}
  throw lastError || new Error('atomic markdown write failed');
}

function readText(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return fallback; }
}

function replaceMarkdownState(filePath, state, marker = STATE_MARKER) {
  const previous = readText(filePath);
  const block = stateBlock(state, marker);
  const pattern = new RegExp(`<!--\\s*${escapeRegex(marker)}\\s*[\\s\\S]*?-->`);
  const next = pattern.test(previous)
    ? previous.replace(pattern, block)
    : `${previous.trimEnd()}\n\n${block}\n`;
  atomicWriteText(filePath, next);
  return state;
}

function percent(value) {
  const number = Number(value || 0) * 100;
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function money(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function markdownTable(headers, rows) {
  const clean = (value) => String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(clean).join(' | ')} |`),
  ].join('\n');
}

function normalizeNativeSession(value = {}) {
  if (!value || typeof value !== 'object') return {};
  return {
    ...(value.ccSessionId ? { ccSessionId: String(value.ccSessionId) } : {}),
    ...(value.codexSid ? { codexSid: String(value.codexSid) } : {}),
    ...(value.geminiChatId ? { geminiChatId: String(value.geminiChatId) } : {}),
    ...(value.geminiProjectHash ? { geminiProjectHash: String(value.geminiProjectHash) } : {}),
    ...(value.geminiProjectRoot ? { geminiProjectRoot: String(value.geminiProjectRoot) } : {}),
    ...(value.kimiSid ? { kimiSid: String(value.kimiSid) } : {}),
    ...(value.kimiSessionDir ? { kimiSessionDir: String(value.kimiSessionDir) } : {}),
    ...(value.transcriptPath ? { transcriptPath: String(value.transcriptPath) } : {}),
  };
}

class AgentLeagueStore {
  constructor(options = {}) {
    this.root = path.resolve(options.root || defaultRoot(options.env || process.env));
    this.agentsDir = path.join(this.root, 'agents');
    this.snapshotsDir = path.join(this.root, 'snapshots');
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    fs.mkdirSync(this.agentsDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    this._ensureRootFiles();
  }

  _ensureRootFiles() {
    const readme = path.join(this.root, 'README.md');
    if (!fs.existsSync(readme)) {
      atomicWriteText(readme, [
        '# 初心 Agent 投资联赛',
        '',
        '这是初心投研内置联赛的长期数据根目录。每个 Agent 独立一个 Markdown 文件夹；不连接券商、不修改真实账户。',
        '',
        '## 数据原则',
        '',
        '- Agent 的核心理念写入 `AGENT.md`，不能被每日任务静默改写。',
        '- `STRATEGY.md` 可版本化调整；`MEMORY.md` 保存待验证经验。',
        '- `PORTFOLIO.md`、`TRADES.md`、`STATS.md` 由确定性模拟账本生成。',
        '- T 日快照形成决策，最早在 T+1 完整收盘快照执行，避免未来函数。',
        '',
      ].join('\n'));
    }
    const schedule = path.join(this.root, 'SCHEDULE.md');
    if (!fs.existsSync(schedule)) {
      this.saveSchedule({
        schemaVersion: 1,
        enabled: false,
        timezone: 'Asia/Shanghai',
        runTime: '18:30',
        maxConcurrency: 2,
        lastSnapshotAsOf: '',
        lastRunId: '',
        lastRunStatus: 'never',
        updatedAt: nowIso(this.now),
      });
    }
  }

  _assertId(agentId) {
    const value = String(agentId || '').toLowerCase();
    if (!AGENT_ID_RE.test(value)) throw new Error(`invalid agent id: ${agentId}`);
    return value;
  }

  agentDir(agentId) {
    return path.join(this.agentsDir, this._assertId(agentId));
  }

  _file(agentId, name) {
    return path.join(this.agentDir(agentId), name);
  }

  schedulePath() {
    return path.join(this.root, 'SCHEDULE.md');
  }

  runLeasePath() {
    return path.join(this.root, '.run.lock');
  }

  currentRunLease() {
    const filePath = this.runLeasePath();
    let value = null;
    try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
    let ageMs = Date.now() - Number(value.renewedAt || value.acquiredAt || 0);
    try { ageMs = Math.min(ageMs, Date.now() - fs.statSync(filePath).mtimeMs); } catch {}
    if (ageMs <= RUN_LEASE_TTL_MS) return { ...value, ageMs: Math.max(0, ageMs) };
    try { fs.unlinkSync(filePath); } catch {}
    return null;
  }

  claimRunLease(owner = {}) {
    const filePath = this.runLeasePath();
    for (let pass = 0; pass < 2; pass += 1) {
      const token = crypto.randomBytes(12).toString('hex');
      const lease = {
        token,
        ownerPid: process.pid,
        ownerHub: String(owner.ownerHub || ''),
        runId: String(owner.runId || ''),
        acquiredAt: Date.now(),
      };
      try {
        const fd = fs.openSync(filePath, 'wx');
        fs.writeFileSync(fd, JSON.stringify(lease), 'utf8');
        fs.closeSync(fd);
        return { ok: true, token, lease };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        const existing = this.currentRunLease();
        if (!existing && pass === 0) continue;
        return { ok: false, reason: 'busy', lease: existing };
      }
    }
    return { ok: false, reason: 'busy', lease: this.currentRunLease() };
  }

  renewRunLease(token) {
    const filePath = this.runLeasePath();
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return false; }
    if (!existing || existing.token !== token) return false;
    try {
      fs.writeFileSync(filePath, JSON.stringify({ ...existing, renewedAt: Date.now() }), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  releaseRunLease(token) {
    const filePath = this.runLeasePath();
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return false; }
    if (!existing || existing.token !== token) return false;
    try { fs.unlinkSync(filePath); return true; }
    catch { return false; }
  }

  getSchedule() {
    return readMarkdownState(this.schedulePath()) || {};
  }

  saveSchedule(value) {
    const state = { ...value, schemaVersion: 1, updatedAt: nowIso(this.now) };
    const doc = [
      '# 联赛赛程', '', stateBlock(state), '',
      '## 当前设置', '',
      `- 自动赛程：${state.enabled ? '已启用' : '未启用'}`,
      `- 时区：${state.timezone || 'Asia/Shanghai'}`,
      `- 每日检查时间：${state.runTime || '18:30'}`,
      `- 最大并发 Agent：${Number(state.maxConcurrency || 2)}`,
      `- 最近快照：${state.lastSnapshotAsOf || '无'}`,
      `- 最近赛程：${state.lastRunId || '无'} · ${state.lastRunStatus || 'never'}`,
      '',
    ].join('\n');
    atomicWriteText(this.schedulePath(), doc);
    return state;
  }

  createAgent(spec = {}) {
    const id = this._assertId(spec.id);
    const dir = this.agentDir(id);
    if (fs.existsSync(path.join(dir, 'AGENT.md'))) throw new Error(`Agent 已存在：${id}`);
    const createdAt = nowIso(this.now);
    const initialCash = Math.max(10000, Number(spec.initialCash || 1000000));
    const philosophy = spec.philosophy && typeof spec.philosophy === 'object' ? spec.philosophy : {};
    const agent = {
      schemaVersion: 1,
      id,
      name: String(spec.name || id).trim().slice(0, 40),
      provider: String(spec.provider || 'codex-cli'),
      kind: String(spec.kind || 'codex'),
      model: String(spec.model || ''),
      philosophyKey: String(philosophy.key || spec.philosophyKey || 'custom'),
      philosophyTitle: String(philosophy.title || spec.philosophyTitle || '自定义理念'),
      status: 'active',
      initialCash,
      strategyVersion: 'v1',
      decisionCount: 0,
      evolutionDays: 0,
      createdAt,
      updatedAt: createdAt,
      lastDecisionAt: null,
    };
    const strategy = {
      schemaVersion: 1,
      version: 'v1',
      coreFrozen: true,
      philosophyKey: agent.philosophyKey,
      horizon: String(philosophy.horizon || '5-20 个交易日'),
      maxSingleWeight: Number(philosophy.maxSingleWeight || 0.30),
      maxGrossWeight: Number(philosophy.maxGrossWeight || 0.95),
      updatedAt: createdAt,
    };
    const session = {
      schemaVersion: 1,
      hubSessionId: '',
      status: 'unbound',
      generation: 1,
      nativeSession: {},
      boundAt: null,
      lastSeenAt: null,
    };
    const portfolio = normalizePortfolio({ initialCash, cash: initialCash, positions: [], pendingDecision: null, navHistory: [] });
    const trades = { schemaVersion: 1, rows: [] };
    fs.mkdirSync(path.join(dir, 'daily'), { recursive: true });
    atomicWriteText(this._file(id, 'AGENT.md'), this._renderAgent(agent, philosophy));
    atomicWriteText(this._file(id, 'STRATEGY.md'), this._renderStrategy(strategy, philosophy));
    atomicWriteText(this._file(id, 'SESSION.md'), this._renderSession(session));
    atomicWriteText(this._file(id, 'PORTFOLIO.md'), this._renderPortfolio(portfolio));
    atomicWriteText(this._file(id, 'TRADES.md'), this._renderTrades(trades));
    atomicWriteText(this._file(id, 'MEMORY.md'), this._renderMemory({ schemaVersion: 1, candidates: [], promoted: [], updatedAt: createdAt }));
    atomicWriteText(this._file(id, 'EVOLUTION.md'), this._renderEvolution({ schemaVersion: 1, proposals: [], updatedAt: createdAt }));
    atomicWriteText(this._file(id, 'STATS.md'), this._renderStats(computeStats(portfolio, [])));
    this._writeProviderInstructions(id, agent);
    return this.getAgent(id);
  }

  _writeProviderInstructions(agentId, agent) {
    const content = [
      `# ${agent.name} · 初心 Agent 联赛`, '',
      '你是一个长期运行的模拟投资 Agent。开始任何联赛任务前，必须读取本目录中的：', '',
      '- `AGENT.md`：不可静默漂移的核心理念',
      '- `STRATEGY.md`：当前策略版本与风险边界',
      '- `PORTFOLIO.md`：由系统维护的模拟账户',
      '- `MEMORY.md`：待验证与已晋升经验',
      '- 当日 `daily/YYYY-MM-DD.md` 和系统提供的冻结快照', '',
      '只能提交目标组合，不得直接修改 `PORTFOLIO.md`、`TRADES.md`、`STATS.md`，不得连接券商或执行真实交易。',
      '每日必须复盘，但核心理念只能通过 `EVOLUTION.md` 的版本化提案变更。', '',
    ].join('\n');
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      atomicWriteText(this._file(agentId, name), content);
    }
  }

  _renderAgent(agent, philosophy = {}) {
    return [
      `# ${agent.name}`, '', stateBlock(agent), '',
      '## 核心理念（冻结）', '', philosophy.summary || '由创建者定义并长期保持可辨识。', '',
      '## 优势假设', '', philosophy.edge || '必须通过长期结果检验，而不是靠单日收益证明。', '',
      '## 选股与持有边界', '',
      `- 典型周期：${philosophy.horizon || '5-20 个交易日'}`,
      `- 允许关注：${philosophy.universe || '初心投研冻结候选池与已有持仓'}`,
      `- 核心禁区：${philosophy.forbidden || '不得读取其他 Agent 的答案；不得连接真实账户；不得事后改写历史。'}`,
      '', '## 进化边界', '',
      '- 每日可以增加待验证经验、记录反例和提出策略版本变更。',
      '- 不允许因为一两次输赢静默改变核心理念。',
      '- 策略变更必须进入 `EVOLUTION.md`，保留假设、指标、期限和版本链。', '',
    ].join('\n');
  }

  _renderStrategy(strategy, philosophy = {}) {
    return [
      `# 策略 ${strategy.version}`, '', stateBlock(strategy), '',
      '## 入场', '', philosophy.entry || '只在理念定义的优势条件成立时建立目标仓位。', '',
      '## 退出', '', philosophy.exit || '失效条件触发时降低至零或防守仓位。', '',
      '## 风险预算', '',
      `- 单票最大权重：${(strategy.maxSingleWeight * 100).toFixed(0)}%`,
      `- 总股票仓位上限：${(strategy.maxGrossWeight * 100).toFixed(0)}%`,
      '- 最低现金比例：5%',
      '- 最多同时持有 6 只股票', '',
    ].join('\n');
  }

  _renderSession(session) {
    const native = session.nativeSession || {};
    return [
      '# AI Hub Session 绑定', '', stateBlock(session), '',
      '## 当前绑定', '',
      `- Hub Session ID：${session.hubSessionId || '尚未绑定'}`,
      `- 状态：${session.status || 'unbound'}`,
      `- 代次：${session.generation || 1}`,
      `- Codex SID：${native.codexSid || '—'}`,
      `- Claude Session ID：${native.ccSessionId || '—'}`,
      `- Gemini Chat ID：${native.geminiChatId || '—'}`,
      `- Kimi Session ID：${native.kimiSid || '—'}`,
      '', '## 生命周期规则', '',
      '- 活跃时直接打开现有 PTY，不执行 resume。',
      '- 自动休眠后，由普通 Hub Session 生命周期按原生 ID 唤醒。',
      '- 不可恢复时必须显式创建新代次，不得静默替换会话。', '',
    ].join('\n');
  }

  _renderPortfolio(portfolioInput) {
    const portfolio = normalizePortfolio(portfolioInput);
    const latest = portfolio.navHistory.length ? portfolio.navHistory[portfolio.navHistory.length - 1] : null;
    const rows = portfolio.positions.map((row) => [
      row.name || row.symbol, row.symbol, row.quantity,
      Number(row.avgCost || 0).toFixed(4), Number(row.lastPrice || 0).toFixed(4),
      money(row.marketValue || row.quantity * row.lastPrice),
    ]);
    return [
      '# 模拟组合', '', stateBlock(portfolio), '',
      '## 账户', '',
      `- 初始资金：${money(portfolio.initialCash)}`,
      `- 现金：${money(portfolio.cash)}`,
      `- 最新净值：${latest ? money(latest.nav) : money(portfolio.initialCash)}`,
      `- 待执行决策：${portfolio.pendingDecision ? `${portfolio.pendingDecision.decisionAsOf} → 下一完整收盘快照` : '无'}`,
      '', '## 持仓', '',
      rows.length ? markdownTable(['名称', '代码', '数量', '成本', '最新价', '市值'], rows) : '当前为空仓。', '',
      '## 净值历史', '',
      portfolio.navHistory.length
        ? markdownTable(['日期', '净值', '现金', '股票市值', '日收益'], portfolio.navHistory.map((row) => [row.date, money(row.nav), money(row.cash), money(row.marketValue), percent(row.dailyReturn)]))
        : '尚无结算记录。', '',
    ].join('\n');
  }

  _renderTrades(trades) {
    const rows = Array.isArray(trades.rows) ? trades.rows : [];
    return [
      '# 模拟交易流水', '', stateBlock({ schemaVersion: 1, rows }), '',
      rows.length
        ? markdownTable(['日期', '方向', '股票', '数量', '参考价', '成交价', '成交额', '费用', '已实现盈亏'], rows.map((row) => [
          row.date, row.side, `${row.name || ''} ${row.symbol}`, row.quantity,
          Number(row.referencePrice || 0).toFixed(4), Number(row.executionPrice || 0).toFixed(4),
          money(row.notional), money(Number(row.commission || 0) + Number(row.tax || 0) + Number(row.transferFee || 0)), money(row.realizedPnl || 0),
        ]))
        : '尚无成交。', '',
      '> 这里只记录确定性模拟成交，不连接券商。', '',
    ].join('\n');
  }

  _renderMemory(memory) {
    const candidates = Array.isArray(memory.candidates) ? memory.candidates : [];
    const promoted = Array.isArray(memory.promoted) ? memory.promoted : [];
    return [
      '# Agent 经验', '', stateBlock({ ...memory, candidates, promoted }), '',
      '## 已晋升经验', '',
      promoted.length ? promoted.map((row) => `- ${row.text}（证据 ${row.evidenceCount || 0}，${row.promotedAt || ''}）`).join('\n') : '暂无。', '',
      '## 待验证观察', '',
      candidates.length ? candidates.slice().reverse().map((row) => `- [${row.date}] ${row.text}${row.mistake ? `；反思：${row.mistake}` : ''}`).join('\n') : '暂无。', '',
      '## 晋升门', '',
      '- 至少跨 5 个独立交易日出现支持证据。',
      '- 必须记录反例；一次收益不能直接升级为规则。', '',
    ].join('\n');
  }

  _renderEvolution(evolution) {
    const proposals = Array.isArray(evolution.proposals) ? evolution.proposals : [];
    return [
      '# 策略进化提案', '', stateBlock({ ...evolution, proposals }), '',
      proposals.length ? proposals.slice().reverse().map((row) => [
        `## ${row.date} · ${row.status || 'proposed'}`,
        '', `- 假设：${row.hypothesis}`, `- 拟变更：${row.proposed_change}`,
        `- 成功指标：${row.success_metric}`, `- 验证期限：${row.expires_after_days} 个交易日`, '',
      ].join('\n')).join('\n') : '暂无提案。', '',
      '> 提案不会自动覆盖 `AGENT.md`；核心理念保持冻结。', '',
    ].join('\n');
  }

  _renderStats(stats) {
    return [
      '# 联赛统计', '', stateBlock(stats), '',
      '## 绩效', '',
      `- 当前资产：${money(stats.nav)}`,
      `- 累计收益：${percent(stats.totalReturn)}`,
      `- 今日收益：${percent(stats.dailyReturn)}`,
      `- 最大回撤：${percent(stats.maxDrawdown)}`,
      '', '## 行为', '',
      `- 股票仓位：${percent(stats.positionWeight)}`,
      `- 现金比例：${percent(stats.cashWeight)}`,
      `- 持仓数量：${stats.positions}`,
      `- 成交次数：${stats.tradeCount}`,
      `- 换手率：${percent(stats.turnover)}`,
      `- 已完成卖出胜率：${stats.winRate == null ? '样本不足' : percent(stats.winRate)}`,
      `- 统计交易日：${stats.tradingDays}`,
      `- 最近快照：${stats.lastAsOf || '无'}`, '',
    ].join('\n');
  }

  getAgent(agentId) {
    const id = this._assertId(agentId);
    const dir = this.agentDir(id);
    const agent = readMarkdownState(path.join(dir, 'AGENT.md'));
    if (!agent) return null;
    const session = readMarkdownState(path.join(dir, 'SESSION.md')) || {};
    const strategy = readMarkdownState(path.join(dir, 'STRATEGY.md')) || {};
    const portfolio = normalizePortfolio(readMarkdownState(path.join(dir, 'PORTFOLIO.md')) || { initialCash: agent.initialCash });
    const trades = readMarkdownState(path.join(dir, 'TRADES.md')) || { rows: [] };
    const memory = readMarkdownState(path.join(dir, 'MEMORY.md')) || { candidates: [], promoted: [] };
    const evolution = readMarkdownState(path.join(dir, 'EVOLUTION.md')) || { proposals: [] };
    const stats = computeStats(portfolio, trades.rows || []);
    return {
      agent,
      session,
      strategy,
      portfolio,
      trades,
      memory,
      evolution,
      stats,
      folder: dir,
      files: {
        agent: path.join(dir, 'AGENT.md'),
        session: path.join(dir, 'SESSION.md'),
        strategy: path.join(dir, 'STRATEGY.md'),
        portfolio: path.join(dir, 'PORTFOLIO.md'),
        trades: path.join(dir, 'TRADES.md'),
        memory: path.join(dir, 'MEMORY.md'),
        evolution: path.join(dir, 'EVOLUTION.md'),
        stats: path.join(dir, 'STATS.md'),
      },
    };
  }

  listAgents(sort = 'return') {
    const rows = [];
    for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !AGENT_ID_RE.test(entry.name)) continue;
      const row = this.getAgent(entry.name);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => {
      if (sort === 'asset') return Number(b.stats.nav) - Number(a.stats.nav);
      return Number(b.stats.totalReturn) - Number(a.stats.totalReturn);
    });
    return rows;
  }

  bindSession(agentId, patch = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const previous = row.session || {};
    const next = {
      ...previous,
      ...patch,
      nativeSession: { ...(previous.nativeSession || {}), ...normalizeNativeSession(patch.nativeSession || {}) },
      schemaVersion: 1,
      lastSeenAt: nowIso(this.now),
    };
    if (next.hubSessionId && !next.boundAt) next.boundAt = nowIso(this.now);
    atomicWriteText(row.files.session, this._renderSession(next));
    return this.getAgent(agentId);
  }

  findByHubSessionId(hubSessionId) {
    const id = String(hubSessionId || '');
    return this.listAgents().find((row) => row.session && row.session.hubSessionId === id) || null;
  }

  savePortfolio(agentId, portfolio, newTrades = []) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const trades = { schemaVersion: 1, rows: [...(row.trades.rows || [])] };
    const existingKeys = new Set(trades.rows.map((trade) => trade.id).filter(Boolean));
    for (const trade of newTrades) {
      const id = trade.id || `trade-${trade.date}-${trade.side}-${trade.symbol}-${trade.quantity}-${trade.executionPrice}`;
      if (existingKeys.has(id)) continue;
      existingKeys.add(id);
      trades.rows.push({ ...trade, id });
    }
    const normalized = normalizePortfolio(portfolio);
    const stats = computeStats(normalized, trades.rows);
    atomicWriteText(row.files.portfolio, this._renderPortfolio(normalized));
    atomicWriteText(row.files.trades, this._renderTrades(trades));
    atomicWriteText(row.files.stats, this._renderStats(stats));
    return this.getAgent(agentId);
  }

  settleAgent(agentId, snapshot, options = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const result = settlePendingTargets(row.portfolio, snapshot, options);
    const updated = this.savePortfolio(agentId, result.portfolio, result.trades);
    return { ...result, agent: updated };
  }

  recordRunStart(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const date = String(payload.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid run date');
    const state = {
      schemaVersion: 1,
      runId: String(payload.runId || ''),
      agentId,
      asOf: date,
      status: 'running',
      promptHash: String(payload.promptHash || ''),
      snapshotPath: String(payload.snapshotPath || ''),
      startedAt: nowIso(this.now),
    };
    const filePath = path.join(row.folder, 'daily', `${date}.md`);
    atomicWriteText(filePath, [
      `# ${date} 每日赛程`, '', stateBlock(state), '',
      '## 状态', '', '正在由绑定的普通 AI Hub Session 生成决策。', '',
      `- 快照：${state.snapshotPath || '—'}`,
      `- Prompt SHA-256：${state.promptHash || '—'}`, '',
    ].join('\n'));
    return { ...state, filePath };
  }

  recordRunFailure(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const date = String(payload.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid run date');
    const filePath = path.join(row.folder, 'daily', `${date}.md`);
    const previous = readText(filePath);
    const state = {
      ...(readStateFromText(previous) || {}),
      schemaVersion: 1,
      runId: String(payload.runId || ''),
      agentId,
      asOf: date,
      status: 'failed',
      failedAt: nowIso(this.now),
      error: String(payload.error || 'unknown error').slice(0, 2000),
    };
    const base = previous ? previous.replace(new RegExp(`<!--\\s*${escapeRegex(STATE_MARKER)}\\s*[\\s\\S]*?-->`), stateBlock(state)) : `# ${date} 每日赛程\n\n${stateBlock(state)}\n`;
    atomicWriteText(filePath, `${base.trimEnd()}\n\n## 失败\n\n${state.error}\n`);
    return { ...state, filePath };
  }

  recordDecision(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const date = String(payload.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid decision date');
    const decision = payload.decision;
    const portfolio = normalizePortfolio(row.portfolio);
    portfolio.pendingDecision = {
      runId: String(payload.runId || ''),
      decisionAsOf: date,
      queuedAt: nowIso(this.now),
      decision,
    };
    const memory = { ...(row.memory || {}), candidates: [...(row.memory.candidates || [])] };
    if (decision.reflection && decision.reflection.lesson_candidate) {
      memory.candidates.push({
        date,
        runId: payload.runId || '',
        text: decision.reflection.lesson_candidate,
        kept: decision.reflection.kept || '',
        mistake: decision.reflection.mistake || '',
        evidenceFor: decision.reflection.evidence_for || [],
        evidenceAgainst: decision.reflection.evidence_against || [],
      });
    }
    memory.updatedAt = nowIso(this.now);
    const evolution = { ...(row.evolution || {}), proposals: [...(row.evolution.proposals || [])] };
    if (decision.strategy_proposal && decision.strategy_proposal.hypothesis) {
      evolution.proposals.push({ date, runId: payload.runId || '', status: 'proposed', ...decision.strategy_proposal });
    }
    evolution.updatedAt = nowIso(this.now);
    const agent = {
      ...row.agent,
      decisionCount: Number(row.agent.decisionCount || 0) + 1,
      evolutionDays: Number(row.agent.evolutionDays || 0) + 1,
      lastDecisionAt: nowIso(this.now),
      updatedAt: nowIso(this.now),
    };
    replaceMarkdownState(row.files.agent, agent);
    atomicWriteText(row.files.portfolio, this._renderPortfolio(portfolio));
    atomicWriteText(row.files.memory, this._renderMemory(memory));
    atomicWriteText(row.files.evolution, this._renderEvolution(evolution));
    const dailyPath = path.join(row.folder, 'daily', `${date}.md`);
    const dailyState = {
      schemaVersion: 1,
      runId: String(payload.runId || ''),
      agentId,
      asOf: date,
      status: 'decision-queued',
      promptHash: String(payload.promptHash || ''),
      completedAt: nowIso(this.now),
      decision,
    };
    const dailyDoc = [
      `# ${date} 每日赛程`, '', stateBlock(dailyState), '',
      '## 决策摘要', '', decision.action_summary || '—', '',
      '## 市场判断', '', decision.market_view || '—', '',
      '## 目标组合（将在下一完整收盘快照执行）', '',
      decision.targets.length
        ? markdownTable(['股票', '目标权重', '确信度', '周期', '逻辑', '失效条件'], decision.targets.map((target) => [target.symbol, percent(target.target_weight), target.conviction, `${target.horizon_days} 日`, target.thesis, target.invalidation]))
        : '保持全现金。', '',
      `现金目标：${percent(decision.cash_target)}`, '',
      '## 每日进化', '',
      `- 保留：${decision.reflection.kept || '无新增'}`,
      `- 错误：${decision.reflection.mistake || '无新增'}`,
      `- 待验证经验：${decision.reflection.lesson_candidate || '无新增'}`,
      '', '## 原始回复', '', String(payload.markdown || ''), '',
    ].join('\n');
    atomicWriteText(dailyPath, dailyDoc);
    return this.getAgent(agentId);
  }

  _extractSection(text, heading) {
    const escaped = escapeRegex(heading);
    const match = String(text || '').match(new RegExp(`##\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`));
    return match ? match[1].trim() : '';
  }

  saveSnapshot(snapshot) {
    const asOf = String(snapshot && snapshot.asOf || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('invalid snapshot asOf');
    const filePath = path.join(this.snapshotsDir, `${asOf}.md`);
    const prices = snapshot.prices && typeof snapshot.prices === 'object' ? snapshot.prices : {};
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    const doc = [
      `# ${asOf} 联赛冻结快照`, '', stateBlock({ ...snapshot, schemaVersion: 1 }), '',
      '## 候选池', '',
      candidates.length
        ? markdownTable(['排名', '股票', '模式', '得分', '收盘价', '摘要'], candidates.map((row, index) => [index + 1, `${row.name || ''} ${row.symbol}`, row.mode || '', row.score == null ? '' : row.score, row.close, row.summary || '']))
        : '无候选。', '',
      '## 执行价格', '',
      Object.keys(prices).length
        ? markdownTable(['股票', '名称', '收盘价', '来源'], Object.entries(prices).sort().map(([symbol, row]) => [symbol, row.name || '', row.close, row.source || '初心冻结快照']))
        : '无。', '',
      '> 所有 Agent 使用同一个只读快照；历史快照不得事后改写。', '',
    ].join('\n');
    if (fs.existsSync(filePath)) {
      const previous = readMarkdownState(filePath);
      if (previous && previous.snapshotId && previous.snapshotId !== snapshot.snapshotId) {
        throw new Error(`快照 ${asOf} 已冻结，拒绝覆盖`);
      }
      return previous || snapshot;
    }
    atomicWriteText(filePath, doc);
    return snapshot;
  }

  getSnapshot(asOf) {
    return readMarkdownState(path.join(this.snapshotsDir, `${String(asOf || '')}.md`));
  }

  getDaily(agentId, asOf) {
    const date = String(asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return readMarkdownState(path.join(this.agentDir(agentId), 'daily', `${date}.md`));
  }
}

module.exports = {
  AGENT_ID_RE,
  AgentLeagueStore,
  RUN_LEASE_TTL_MS,
  STATE_MARKER,
  atomicWriteText,
  defaultRoot,
  readMarkdownState,
  readStateFromText,
  replaceMarkdownState,
  stateBlock,
};
