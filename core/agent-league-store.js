'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  computeStats,
  markPortfolio,
  normalizePortfolio,
  settlePendingTargets,
} = require('./agent-league-accounting.js');
const { EXCHANGE_CALENDAR } = require('./agent-league-calendar.js');

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const STATE_MARKER = 'agent-league-state:v1';
// Legacy cross-version guard. The durable SQLite epoch is the correctness
// fence; this short file lease keeps older Hub builds from entering the same
// phase while still allowing a successor to take over promptly after a crash.
const RUN_LEASE_TTL_MS = 25 * 1000;
const PROMPT_EDIT_LIMIT = 200000;
const PROMPT_FILE_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'agent', name: 'AGENT.md', group: 'investment', title: '核心投资人格', description: '为什么这样投资、长期相信什么、永远不做什么。', editable: true, protectedState: true }),
  Object.freeze({ key: 'strategy', name: 'STRATEGY.md', group: 'investment', title: '当前执行策略', description: '入场、退出、周期与 Agent 自己认可的风险纪律。', editable: true, protectedState: true }),
  Object.freeze({ key: 'checklist', name: 'CHECKLIST.md', group: 'investment', title: '决策 Hook 规则', description: '每笔交易必须引用的规则 ID；保存时会同步机器规则表。', editable: true, protectedState: true, checklist: true }),
  Object.freeze({ key: 'dailyPrompt', name: 'PROMPT_DAILY.md', group: 'runtime', title: '盘前 DRAFT 补充提示', description: '注入每个交易日第一轮决策，可按 Agent 个性定制。', editable: true }),
  Object.freeze({ key: 'hookPrompt', name: 'PROMPT_HOOK.md', group: 'runtime', title: '决策 Hook 补充提示', description: '注入第二轮自检，不改变系统的结构化输出合同。', editable: true }),
  Object.freeze({ key: 'weeklyPrompt', name: 'PROMPT_WEEKLY.md', group: 'runtime', title: '周六沉淀补充提示', description: '注入周度复盘，控制 Agent 如何总结与提出规则建议。', editable: true }),
  Object.freeze({ key: 'agentsInstructions', name: 'AGENTS.md', group: 'provider', title: 'Codex / Kimi 目录指令', description: '进入 Agent 文件夹时自动读取的 Provider 指令。', editable: true }),
  Object.freeze({ key: 'claudeInstructions', name: 'CLAUDE.md', group: 'provider', title: 'Claude 目录指令', description: 'Claude Session 在该目录运行时读取的说明。', editable: true }),
  Object.freeze({ key: 'geminiInstructions', name: 'GEMINI.md', group: 'provider', title: 'Gemini 目录指令', description: 'Gemini Session 在该目录运行时读取的说明。', editable: true }),
  Object.freeze({ key: 'promptHistory', name: 'PROMPT_HISTORY.md', group: 'system', title: '提示词编辑历史', description: '每次保存的时间、文件和哈希；由系统追加。', editable: false }),
  Object.freeze({ key: 'memory', name: 'MEMORY.md', group: 'context', title: '长期经验上下文', description: '周六沉淀产生的待验证/已晋升经验；由系统维护。', editable: false, protectedState: true }),
  Object.freeze({ key: 'evolution', name: 'EVOLUTION.md', group: 'context', title: '策略演化提案', description: '所有规则修改提案与版本链；由系统维护。', editable: false, protectedState: true }),
  Object.freeze({ key: 'session', name: 'SESSION.md', group: 'system', title: 'Session 绑定', description: 'Hub ID、原生 SID 与生命周期状态；只读。', editable: false, protectedState: true }),
  Object.freeze({ key: 'portfolio', name: 'PORTFOLIO.md', group: 'ledger', title: '模拟组合', description: '现金、持仓与净值的机器账本；禁止手改。', editable: false, protectedState: true }),
  Object.freeze({ key: 'trades', name: 'TRADES.md', group: 'ledger', title: '模拟成交', description: '费用与成交流水；禁止手改。', editable: false, protectedState: true }),
  Object.freeze({ key: 'stats', name: 'STATS.md', group: 'ledger', title: '联赛统计', description: '收益、回撤与行为统计；禁止手改。', editable: false, protectedState: true }),
]);

class PromptFileConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromptFileConflictError';
    this.code = 'prompt-file-conflict';
  }
}

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

// 理念模板的可选正文段落。传空/缺省时返回空数组，老模板渲染结果一字不变。
function renderPhilosophySections(sections) {
  if (!Array.isArray(sections) || !sections.length) return [];
  const out = [];
  for (const section of sections) {
    const title = String((section && section.title) || '').trim();
    const lines = Array.isArray(section && section.lines) ? section.lines.map((line) => String(line)) : [];
    if (!title || !lines.length) continue;
    out.push(`## ${title}`, '', ...lines, '');
  }
  return out;
}

function readStateFromText(text, marker = STATE_MARKER) {
  const match = String(text || '').match(new RegExp(`<!--\\s*${escapeRegex(marker)}\\s*([\\s\\S]*?)-->`));
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); }
  catch { return null; }
}

function isCompletedDailyDecision(state) {
  return !!state
    && state.stage === 'complete'
    && state.status === 'decision-queued'
    && !!state.decision
    && !!state.hook;
}

function summarizeDecisionHistory(rows = []) {
  const history = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const completed = history.filter(isCompletedDailyDecision);
  const failed = history.filter((row) => row.status === 'failed');
  const technicalForfeits = failed.filter((row) => row.failureKind === 'technical-forfeit');
  const resolved = completed.length + failed.length;
  const summarizeDay = (row) => row ? {
    runId: String(row.runId || ''),
    decisionDate: String(row.decisionDate || ''),
    dataAsOf: String(row.dataAsOf || ''),
    stage: String(row.stage || ''),
    status: String(row.status || ''),
    failureKind: String(row.failureKind || ''),
    verdict: String(row.hook && row.hook.verdict || ''),
    error: String(row.error || '').slice(0, 500),
  } : null;
  return {
    maxWindowDays: 260,
    attemptedDays: history.length,
    resolvedDays: resolved,
    completedDecisions: completed.length,
    failedDays: failed.length,
    technicalForfeits: technicalForfeits.length,
    validRate: resolved ? completed.length / resolved : null,
    latestAttempt: summarizeDay(history.length ? history[history.length - 1] : null),
    latestCompleted: summarizeDay(completed.length ? completed[completed.length - 1] : null),
    recentDays: history.slice(-8).reverse().map(summarizeDay),
  };
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

function textSha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stripManagedState(text, marker = STATE_MARKER) {
  return String(text || '')
    .replace(new RegExp(`\\n?<!--\\s*${escapeRegex(marker)}\\s*[\\s\\S]*?-->\\n?`), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function composeManagedMarkdown(body, state, marker = STATE_MARKER) {
  const clean = stripManagedState(body, marker);
  const match = clean.match(/^(#[^\n]*)(?:\n+)?([\s\S]*)$/);
  if (!match) return `${stateBlock(state, marker)}\n\n${clean}\n`;
  return `${match[1]}\n\n${stateBlock(state, marker)}\n\n${String(match[2] || '').trim()}\n`;
}

function parseChecklistRules(body) {
  const rows = [];
  const seen = new Set();
  for (const match of String(body || '').matchAll(/^-\s+\*\*([A-Za-z][A-Za-z0-9_-]{0,31})\*\*[：:]\s*(.+)$/gm)) {
    const id = match[1];
    const text = match[2].trim();
    if (seen.has(id)) throw new Error(`CHECKLIST 规则 ID 重复：${id}`);
    seen.add(id);
    rows.push({ id, text, status: 'active' });
  }
  if (!rows.length) throw new Error('CHECKLIST 至少保留一条 `- **规则ID**：规则内容`');
  if (rows.length > 50) throw new Error('CHECKLIST 规则不能超过 50 条');
  return rows;
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
        '- `CHECKLIST.md` 把理念变成每次决策前必须逐条检查的规则。',
        '- `PORTFOLIO.md`、`TRADES.md`、`STATS.md` 由模拟账本根据真实申报单位机械生成。',
        '- 交易日盘前形成 DRAFT，同一普通 Session 再执行 Hook，锁定后按当日开盘价模拟执行。',
        '- 周六只做经验沉淀和规则提案，不自动改写核心理念。',
        '',
      ].join('\n'));
    }
    const schedule = path.join(this.root, 'SCHEDULE.md');
    if (!fs.existsSync(schedule)) {
      this.saveSchedule({
        schemaVersion: 2,
        enabled: false,
        keepAliveOnClose: true,
        timezone: 'Asia/Shanghai',
        decisionTime: '08:30',
        decisionCutoff: '09:15',
        executionTime: '09:35',
        resultTime: '15:10',
        weeklyTime: '10:00',
        runTime: '08:30',
        maxConcurrency: 2,
        calendarCoverageEnd: EXCHANGE_CALENDAR.coverageEnd,
        lastSnapshotAsOf: '',
        lastRunId: '',
        lastRunStatus: 'never',
        lastExecutionDate: '',
        lastResultDate: '',
        lastWeeklyDate: '',
        updatedAt: nowIso(this.now),
      });
    } else {
      const previous = readMarkdownState(schedule) || {};
      if (Number(previous.schemaVersion || 0) < 2) {
        this.saveSchedule({
          ...previous,
          schemaVersion: 2,
          decisionTime: '08:30',
          decisionCutoff: '09:15',
          executionTime: '09:35',
          resultTime: '15:10',
          weeklyTime: '10:00',
          runTime: '08:30',
          calendarCoverageEnd: EXCHANGE_CALENDAR.coverageEnd,
          lastExecutionDate: previous.lastExecutionDate || '',
          lastResultDate: previous.lastResultDate || '',
          lastWeeklyDate: previous.lastWeeklyDate || '',
        });
      }
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
    const state = { ...value, schemaVersion: 2, updatedAt: nowIso(this.now) };
    const doc = [
      '# 联赛赛程', '', stateBlock(state), '',
      '## 当前设置', '',
      `- 自动赛程：${state.enabled ? '已启用' : '未启用'}`,
      `- 关窗后台守护：${state.keepAliveOnClose === false ? '已关闭' : '已启用'}`,
      `- 时区：${state.timezone || 'Asia/Shanghai'}`,
      `- 盘前决策：${state.decisionTime || state.runTime || '08:30'}（截止 ${state.decisionCutoff || '09:15'}）`,
      `- 开盘执行：${state.executionTime || '09:35'}`,
      `- 收盘记账：${state.resultTime || '15:10'}`,
      `- 周六沉淀：${state.weeklyTime || '10:00'}`,
      `- 最大并发 Agent：${Number(state.maxConcurrency || 2)}`,
      `- 交易日历覆盖至：${state.calendarCoverageEnd || EXCHANGE_CALENDAR.coverageEnd}`,
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
    const initialCash = Math.max(10000, Number(spec.initialCash || 500000));
    const philosophy = spec.philosophy && typeof spec.philosophy === 'object' ? spec.philosophy : {};
    const agent = {
      schemaVersion: 2,
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
      weeklyReviewCount: 0,
      lastHookVerdict: '',
      lastBriefHeadline: '',
      strategyPendingConfirmation: philosophy.provisional === true,
      createdAt,
      updatedAt: createdAt,
      lastDecisionAt: null,
    };
    const strategy = {
      schemaVersion: 2,
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
    fs.mkdirSync(path.join(dir, 'weekly'), { recursive: true });
    atomicWriteText(this._file(id, 'AGENT.md'), this._renderAgent(agent, philosophy));
    atomicWriteText(this._file(id, 'STRATEGY.md'), this._renderStrategy(strategy, philosophy));
    atomicWriteText(this._file(id, 'CHECKLIST.md'), this._renderChecklist(philosophy.checklist || []));
    atomicWriteText(this._file(id, 'SESSION.md'), this._renderSession(session));
    atomicWriteText(this._file(id, 'PORTFOLIO.md'), this._renderPortfolio(portfolio));
    atomicWriteText(this._file(id, 'TRADES.md'), this._renderTrades(trades));
    atomicWriteText(this._file(id, 'MEMORY.md'), this._renderMemory({ schemaVersion: 2, candidates: [], promoted: [], updatedAt: createdAt }));
    atomicWriteText(this._file(id, 'EVOLUTION.md'), this._renderEvolution({ schemaVersion: 1, proposals: [], updatedAt: createdAt }));
    atomicWriteText(this._file(id, 'STATS.md'), this._renderStats(computeStats(portfolio, [])));
    this._writeProviderInstructions(id, agent);
    for (const kind of ['daily', 'hook', 'weekly']) {
      const key = `${kind}Prompt`;
      const definition = PROMPT_FILE_DEFINITIONS.find((row) => row.key === key);
      atomicWriteText(this._file(id, definition.name), this._defaultRuntimePrompt(kind, agent, philosophy));
    }
    atomicWriteText(this._file(id, 'PROMPT_HISTORY.md'), '# 提示词编辑历史\n\n暂无编辑记录。\n');
    return this.getAgent(id);
  }

  _defaultRuntimePrompt(kind, agent, philosophy = {}) {
    const title = kind === 'daily' ? '盘前 DRAFT 补充提示'
      : kind === 'hook' ? '决策 Hook 补充提示' : '周六沉淀补充提示';
    const lines = [`# ${title}`, '', `> Agent：${agent.name} · ${philosophy.title || agent.philosophyTitle || '自定义理念'}`, ''];
    // 理念自带的运行提示优先。默认三段文案对所有 Agent 几乎逐字相同（HOOK 与
    // WEEKLY 只有标题行不同），个性化提示的实际贡献接近零；模板给了自己的版本
    // 就用它，让不同打法在盘前/自检/沉淀三个环节真的分开。
    const custom = philosophy.prompts && philosophy.prompts[kind];
    if (Array.isArray(custom) && custom.length) {
      lines.push(...custom.map((line) => String(line)));
      return `${lines.join('\n')}\n`;
    }
    if (kind === 'daily') {
      lines.push(
        '- 首先检查已有持仓逻辑是否仍成立，再研究新机会。',
        '- 把“不交易、等待、保持现金”当成真实备选方案，不为了联赛制造订单。',
        `- 保持本 Agent 的辨识度：${philosophy.summary || '严格遵守 AGENT.md 与 STRATEGY.md。'}`,
        '- 输出必须简洁、可验证；不要用资料堆砌代替动作判断。',
      );
    } else if (kind === 'hook') {
      lines.push(
        '- 先主动寻找最强违规项，不要默认替刚才的 DRAFT 辩护。',
        '- 如果证据不足或当前位置不舒服，允许缩仓或 HOLD。',
        '- 明确区分“投资逻辑正确”和“今天这个价格值得操作”。',
        '- DAILY_BRIEF 使用第一人称，说明冲突与改动，不写空泛鸡汤。',
      );
    } else {
      lines.push(
        '- 严格区分过程质量与盈亏结果；赚钱的坏决策仍然是坏决策。',
        '- 尚未达到持有周期的决策只记录状态，不仓促判定对错。',
        '- 每周最多提出一条 CHECKLIST 修改建议；样本不足时明确保持不变。',
        '- 提炼一条适合长期验证的经验，同时保留最强反例。',
      );
    }
    return `${lines.join('\n')}\n`;
  }

  _writeProviderInstructions(agentId, agent) {
    const content = [
      `# ${agent.name} · 初心 Agent 联赛`, '',
      '你是一个长期运行的模拟投资 Agent。开始任何联赛任务前，必须读取本目录中的：', '',
      '- `AGENT.md`：不可静默漂移的核心理念',
      '- `STRATEGY.md`：当前策略版本与风险边界',
      '- `CHECKLIST.md`：本次交易必须引用的个人规则 ID',
      '- `PORTFOLIO.md`：由系统维护的模拟账户',
      '- `MEMORY.md`：待验证与已晋升经验',
      '- 当日 `daily/YYYY-MM-DD.md` 和系统提供的冻结快照', '',
      '只能提交目标组合，不得直接修改 `PORTFOLIO.md`、`TRADES.md`、`STATS.md`，不得连接券商或执行真实交易。',
      '交易日先提交 DRAFT，再在同一 Session 中逐条执行 Hook；周六才沉淀经验。核心理念只能通过 `EVOLUTION.md` 的版本化提案变更。', '',
    ].join('\n');
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      atomicWriteText(this._file(agentId, name), content);
    }
  }

  _renderAgent(agent, philosophy = {}) {
    return [
      `# ${agent.name}`, '', stateBlock(agent), '',
      '## 核心理念（冻结）', '', philosophy.summary || '由创建者定义并长期保持可辨识。', '',
      ...(agent.strategyPendingConfirmation ? ['> 当前是第一版建议策略，等待创建者后续确认；在确认前仍按版本化规则完整记录。', ''] : []),
      '## 优势假设', '', philosophy.edge || '必须通过长期结果检验，而不是靠单日收益证明。', '',
      // 有些理念光靠 summary/edge/边界三段说不清楚（例如同一套选股标准下分两个
      // 进场阶段、或者组合本身要分层）。sections 让模板补自己的正文段落，而不是
      // 逼创建者事后手工改这份冻结文件。
      ...renderPhilosophySections(philosophy.sections),
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
      ...renderPhilosophySections(philosophy.strategySections),
      '## Agent 自主风险预算', '',
      `- 当前自律参考：单票通常不超过 ${(strategy.maxSingleWeight * 100).toFixed(0)}%，总股票仓位通常不超过 ${(strategy.maxGrossWeight * 100).toFixed(0)}%。`,
      '- 上述是 Agent 在 Hook 中自行解释和检查的策略纪律，不是系统替它判断的硬风控。',
      '- 系统只要求权重闭合，并按真实账户申报单位、现金和费用机械执行。', '',
    ].join('\n');
  }

  _renderChecklist(items = []) {
    const rows = Array.isArray(items) && items.length ? items : [
      { id: 'C1', text: '交易必须符合核心理念，并给出可追溯证据。' },
      { id: 'P1', text: '必须解释为什么现在操作，而不是等待或保持现金。' },
      { id: 'R1', text: '仓位必须与置信度、失效条件和组合风险匹配。' },
      { id: 'B1', text: '不得因为排名、近期盈亏或害怕错过而改变纪律。' },
    ];
    const state = {
      schemaVersion: 1,
      rules: rows.map((row) => ({ id: String(row.id || '').trim(), text: String(row.text || '').trim(), status: 'active' })).filter((row) => row.id && row.text),
    };
    return [
      '# 决策检查表', '', stateBlock(state), '',
      '每个发生仓位变化的标的都必须引用下列规则 ID。Hook 负责逐条检查，系统不替 Agent 判断投资风险。', '',
      ...state.rules.map((row) => `- **${row.id}**：${row.text}`), '',
      '## 变更规则', '',
      '- 周一至周五不得自动改写本文件。',
      '- 周六可以提出最多一条修改建议，先写入 `EVOLUTION.md`，不自动生效。', '',
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
      `- 待执行决策：${portfolio.pendingDecision ? `${portfolio.pendingDecision.decisionDate || portfolio.pendingDecision.decisionAsOf} → 当日开盘快照` : '无'}`,
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
      proposals.length ? proposals.slice().reverse().map((row) => row.type === 'checklist' ? [
        `## ${row.date} · CHECKLIST · ${row.status || 'proposed'}`, '',
        `- 规则 ID：${row.rule_id}`,
        `- 原规则：${row.old_rule || '—'}`,
        `- 建议规则：${row.proposed_rule}`,
        `- 原因：${row.reason}`,
        `- 证据：${(row.evidence || []).join('；') || '样本不足，待继续观察'}`, '',
      ].join('\n') : [
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
    const checklistPath = path.join(dir, 'CHECKLIST.md');
    if (!fs.existsSync(checklistPath)) atomicWriteText(checklistPath, this._renderChecklist([]));
    const checklist = readMarkdownState(checklistPath) || { rules: [] };
    for (const kind of ['daily', 'hook', 'weekly']) {
      const definition = PROMPT_FILE_DEFINITIONS.find((item) => item.key === `${kind}Prompt`);
      const filePath = path.join(dir, definition.name);
      if (!fs.existsSync(filePath)) {
        atomicWriteText(filePath, this._defaultRuntimePrompt(kind, agent, { title: agent.philosophyTitle }));
      }
    }
    const promptHistoryPath = path.join(dir, 'PROMPT_HISTORY.md');
    if (!fs.existsSync(promptHistoryPath)) atomicWriteText(promptHistoryPath, '# 提示词编辑历史\n\n暂无编辑记录。\n');
    const portfolio = normalizePortfolio(readMarkdownState(path.join(dir, 'PORTFOLIO.md')) || { initialCash: agent.initialCash });
    const trades = readMarkdownState(path.join(dir, 'TRADES.md')) || { rows: [] };
    const memory = readMarkdownState(path.join(dir, 'MEMORY.md')) || { candidates: [], promoted: [] };
    const evolution = readMarkdownState(path.join(dir, 'EVOLUTION.md')) || { proposals: [] };
    const stats = computeStats(portfolio, trades.rows || []);
    const dailyHistory = this.listDaily(id, { limit: 260 });
    const latestDaily = dailyHistory.length ? dailyHistory[dailyHistory.length - 1] : null;
    const completedDaily = dailyHistory.filter(isCompletedDailyDecision);
    const latestCompletedDaily = completedDaily.length ? completedDaily[completedDaily.length - 1] : null;
    return {
      agent,
      session,
      strategy,
      checklist,
      portfolio,
      trades,
      memory,
      evolution,
      stats,
      latestDaily,
      latestCompletedDaily,
      decisionReliability: summarizeDecisionHistory(dailyHistory),
      latestWeekly: this.getLatestWeekly(id),
      folder: dir,
      files: {
        agent: path.join(dir, 'AGENT.md'),
        session: path.join(dir, 'SESSION.md'),
        strategy: path.join(dir, 'STRATEGY.md'),
        checklist: checklistPath,
        dailyPrompt: path.join(dir, 'PROMPT_DAILY.md'),
        hookPrompt: path.join(dir, 'PROMPT_HOOK.md'),
        weeklyPrompt: path.join(dir, 'PROMPT_WEEKLY.md'),
        agentsInstructions: path.join(dir, 'AGENTS.md'),
        claudeInstructions: path.join(dir, 'CLAUDE.md'),
        geminiInstructions: path.join(dir, 'GEMINI.md'),
        portfolio: path.join(dir, 'PORTFOLIO.md'),
        trades: path.join(dir, 'TRADES.md'),
        memory: path.join(dir, 'MEMORY.md'),
        evolution: path.join(dir, 'EVOLUTION.md'),
        stats: path.join(dir, 'STATS.md'),
        promptHistory: path.join(dir, 'PROMPT_HISTORY.md'),
      },
    };
  }

  promptFileDefinitions() {
    return PROMPT_FILE_DEFINITIONS.map((row) => ({ ...row }));
  }

  listPromptFiles(agentId) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    return PROMPT_FILE_DEFINITIONS.map((definition) => {
      const filePath = path.join(row.folder, definition.name);
      const raw = readText(filePath);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch {}
      return {
        ...definition,
        path: filePath,
        exists: !!stat,
        content: definition.protectedState ? stripManagedState(raw) : raw.trimEnd(),
        machineState: definition.protectedState ? readStateFromText(raw) : null,
        sha256: textSha256(raw),
        bytes: Buffer.byteLength(raw, 'utf8'),
        updatedAt: stat ? stat.mtime.toISOString() : null,
      };
    });
  }

  savePromptFile(agentId, key, content, expectedSha256 = '', options = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const definition = PROMPT_FILE_DEFINITIONS.find((item) => item.key === String(key || ''));
    if (!definition) throw new Error(`未知提示词文件：${key}`);
    if (!definition.editable) throw new Error(`${definition.name} 是系统维护文件，只能查看`);
    const filePath = path.join(row.folder, definition.name);
    const previous = readText(filePath);
    const previousHash = textSha256(previous);
    if (expectedSha256 && expectedSha256 !== previousHash) {
      throw new PromptFileConflictError(`${definition.name} 已被其他进程修改，请重新载入后再保存`);
    }
    let body = String(content == null ? '' : content).replace(/\r\n/g, '\n').replace(/\u0000/g, '');
    if (Buffer.byteLength(body, 'utf8') > PROMPT_EDIT_LIMIT) throw new Error(`文件不能超过 ${PROMPT_EDIT_LIMIT} 字节`);
    body = body.trimEnd();
    if (!body) throw new Error(`${definition.name} 不能为空`);
    let next = `${body}\n`;
    if (definition.protectedState) {
      const state = readStateFromText(previous);
      if (!state) throw new Error(`${definition.name} 缺少受保护的机器状态，拒绝覆盖`);
      const nextState = definition.checklist
        ? { ...state, rules: parseChecklistRules(body), updatedAt: nowIso(this.now) }
        : state;
      next = composeManagedMarkdown(body, nextState);
    }
    if (next === previous) return this.listPromptFiles(agentId).find((item) => item.key === definition.key);
    const stamp = nowIso(this.now).replace(/[:.]/g, '-');
    const backupDir = path.join(row.folder, 'history', 'prompt-edits', stamp);
    atomicWriteText(path.join(backupDir, definition.name), previous);
    atomicWriteText(filePath, next);
    const nextHash = textSha256(next);
    const historyPath = path.join(row.folder, 'PROMPT_HISTORY.md');
    const history = readText(historyPath, '# 提示词编辑历史\n').replace(/\n暂无编辑记录。\s*$/, '\n');
    const entry = [
      '', `## ${nowIso(this.now)} · ${definition.name}`, '',
      `- 操作者：${String(options.actor || 'Hub UI')}`,
      `- 修改前 SHA-256：${previousHash}`,
      `- 修改后 SHA-256：${nextHash}`,
      `- 备份：${path.relative(row.folder, path.join(backupDir, definition.name))}`, '',
    ].join('\n');
    atomicWriteText(historyPath, `${history.trimEnd()}\n${entry}`);
    return this.listPromptFiles(agentId).find((item) => item.key === definition.key);
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
    const pending = row.portfolio.pendingDecision ? { ...row.portfolio.pendingDecision } : null;
    const result = settlePendingTargets(row.portfolio, snapshot, options);
    const updated = this.savePortfolio(agentId, result.portfolio, result.trades);
    if (typeof options.afterPortfolioSaved === 'function') {
      options.afterPortfolioSaved({ agentId, pending, result, updated });
    }
    if (result.settled && pending) {
      this.recordExecutionResult(agentId, pending.decisionDate || pending.decisionAsOf, result);
    }
    return { ...result, agent: updated };
  }

  markAgent(agentId, snapshot, decisionDate = String(snapshot && snapshot.asOf || '').slice(0, 10)) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const marked = markPortfolio(row.portfolio, snapshot);
    const updated = this.savePortfolio(agentId, marked.portfolio, []);
    this.recordCloseResult(agentId, decisionDate, updated.stats);
    return { ...marked, agent: updated };
  }

  _dailyPath(agentId, date) {
    return path.join(this.agentDir(agentId), 'daily', `${date}.md`);
  }

  _decisionTable(decision) {
    if (!decision || !(decision.targets || []).length) return '目标组合为全现金。';
    return markdownTable(
      ['股票', '目标权重', '确信度', '周期', '规则', '逻辑', '反证', '失效条件'],
      decision.targets.map((target) => [
        `${target.name || ''} ${target.symbol}`, percent(target.target_weight),
        `${(Number(target.conviction || 0) * 100).toFixed(0)}%`, `${target.horizon_days} 日`,
        (target.rule_refs || []).join('/'), target.thesis, target.counter_evidence, target.invalidation,
      ]),
    );
  }

  _renderDaily(state) {
    const hook = state.hook || null;
    const brief = state.dailyBrief || null;
    const execution = state.execution || null;
    const closeResult = state.closeResult || null;
    return [
      `# ${state.decisionDate} 每日赛程`, '', stateBlock(state), '',
      '## 运行状态', '',
      `- 阶段：${state.stage || 'draft'}`,
      `- 状态：${state.status || 'running'}`,
      `- 使用数据：${state.dataAsOf || '—'}`,
      `- Run ID：${state.runId || '—'}`,
      `- 快照：${state.snapshotPath || '—'}`,
      ...(state.failureKind ? [`- 失败分类：${state.failureKind}`] : []),
      ...(state.error ? [`- 错误：${state.error}`] : []), '',
      ...(state.draft ? [
        '## DRAFT · 盘前预案', '',
        state.draft.action_summary || '—', '',
        `**市场判断：** ${state.draft.market_view || '—'}`, '',
        `**今日核心矛盾：** ${state.draft.core_conflict || '—'}`, '',
        this._decisionTable(state.draft), '',
        `现金目标：${percent(state.draft.cash_target)}`, '',
      ] : []),
      ...(hook ? [
        '## SELF CHECK · 决策 Hook', '',
        `结论：**${hook.verdict}**`, '',
        hook.rule_checks && hook.rule_checks.length
          ? markdownTable(['规则', '结果', '说明'], hook.rule_checks.map((row) => [row.rule_id, row.status, row.comment]))
          : '未记录逐条规则检查。', '',
        `- 最强反证：${hook.strongest_counter_evidence || '—'}`,
        `- 时机检查：${hook.timing_check || '—'}`,
        `- 组合检查：${hook.portfolio_check || '—'}`,
        `- 行为检查：${hook.behavior_check || '—'}`,
        `- 账户可行性：${hook.account_feasibility || '—'}`, '',
      ] : []),
      ...(state.decision ? [
        '## FINAL · 最终目标组合', '',
        state.decision.action_summary || '—', '',
        this._decisionTable(state.decision), '',
        `现金目标：${percent(state.decision.cash_target)}`, '',
      ] : []),
      ...(brief ? [
        `## DAILY BRIEF · ${brief.headline || '今日思考'}`, '',
        brief.body || '—', '',
        `> Hook 变化：${brief.hook_change || '无'}`, '',
        ...(brief.video_hooks && brief.video_hooks.length ? ['短视频素材：', ...brief.video_hooks.map((value) => `- ${value}`), ''] : []),
      ] : []),
      ...(execution ? [
        '## OPEN · 开盘执行', '',
        `- 是否执行：${execution.settled ? '是' : '否'}`,
        `- 成交：${(execution.trades || []).length} 笔`,
        `- 订单说明：${(execution.orderNotes || []).map((row) => `${row.symbol} ${row.status} ${row.reason}`).join('；') || '无'}`,
        `- 执行后净值：${money(execution.nav || 0)}`, '',
      ] : []),
      ...(closeResult ? [
        '## RESULT · 收盘结果', '',
        `- 收盘净值：${money(closeResult.nav || 0)}`,
        `- 当日收益：${percent(closeResult.dailyReturn || 0)}`,
        `- 累计收益：${percent(closeResult.totalReturn || 0)}`,
        `- 股票仓位：${percent(closeResult.positionWeight || 0)}`,
        `- 记录时间：${closeResult.recordedAt || '—'}`, '',
      ] : []),
      ...(state.rawDraft ? ['## 原始 DRAFT 回复', '', state.rawDraft, ''] : []),
      ...(state.rawHook ? ['## 原始 Hook 回复', '', state.rawHook, ''] : []),
    ].join('\n');
  }

  recordRunStart(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const decisionDate = String(payload.decisionDate || payload.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) throw new Error('invalid run date');
    const state = {
      schemaVersion: 2,
      runId: String(payload.runId || ''),
      agentId,
      decisionDate,
      dataAsOf: String(payload.dataAsOf || payload.asOf || '').slice(0, 10),
      stage: 'draft',
      status: 'running',
      draftPromptHash: String(payload.promptHash || ''),
      snapshotPath: String(payload.snapshotPath || ''),
      startedAt: nowIso(this.now),
    };
    const filePath = this._dailyPath(agentId, decisionDate);
    atomicWriteText(filePath, this._renderDaily(state));
    return { ...state, filePath };
  }

  recordDraft(agentId, payload = {}) {
    const date = String(payload.decisionDate || payload.asOf || '').slice(0, 10);
    const filePath = this._dailyPath(agentId, date);
    const previous = readMarkdownState(filePath) || {};
    const state = {
      ...previous,
      schemaVersion: 2,
      runId: String(payload.runId || previous.runId || ''),
      agentId,
      decisionDate: date,
      dataAsOf: String(payload.dataAsOf || previous.dataAsOf || '').slice(0, 10),
      stage: 'hook',
      status: 'hook-running',
      draft: payload.draft,
      targetContexts: payload.targetContexts && typeof payload.targetContexts === 'object' ? payload.targetContexts : {},
      rawDraft: String(payload.markdown || '').slice(0, 40000),
      hookPromptHash: String(payload.hookPromptHash || ''),
      draftCompletedAt: nowIso(this.now),
    };
    atomicWriteText(filePath, this._renderDaily(state));
    return { ...state, filePath };
  }

  recordRunFailure(agentId, payload = {}) {
    const date = String(payload.decisionDate || payload.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid run date');
    const filePath = this._dailyPath(agentId, date);
    const previous = readMarkdownState(filePath) || {};
    const state = {
      ...previous,
      schemaVersion: 2,
      runId: String(payload.runId || previous.runId || ''),
      agentId,
      decisionDate: date,
      stage: String(payload.stage || previous.stage || 'draft'),
      status: payload.failureKind === 'retrying' ? 'retrying' : 'failed',
      failureKind: String(payload.failureKind || 'runtime-failure'),
      failedAt: nowIso(this.now),
      error: String(payload.error || 'unknown error').slice(0, 2000),
    };
    atomicWriteText(filePath, this._renderDaily(state));
    return { ...state, filePath };
  }

  recordDecision(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const decisionDate = String(payload.decisionDate || payload.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionDate)) throw new Error('invalid decision date');
    const decision = payload.decision;
    const runId = String(payload.runId || '');
    const alreadyCounted = !!runId && String(row.agent.lastDecisionRunId || '') === runId;
    const portfolio = normalizePortfolio(row.portfolio);
    portfolio.pendingDecision = {
      runId,
      decisionDate,
      decisionDataAsOf: String(payload.dataAsOf || '').slice(0, 10),
      decisionAsOf: String(payload.dataAsOf || decisionDate).slice(0, 10),
      queuedAt: nowIso(this.now),
      hookVerdict: String(payload.hook && payload.hook.verdict || ''),
      dailyBrief: payload.dailyBrief || null,
      decision,
    };
    const agent = {
      ...row.agent,
      schemaVersion: 2,
      decisionCount: Number(row.agent.decisionCount || 0) + (alreadyCounted ? 0 : 1),
      lastDecisionAt: alreadyCounted ? row.agent.lastDecisionAt : nowIso(this.now),
      lastDecisionRunId: runId || row.agent.lastDecisionRunId || '',
      lastHookVerdict: String(payload.hook && payload.hook.verdict || ''),
      lastBriefHeadline: String(payload.dailyBrief && payload.dailyBrief.headline || ''),
      updatedAt: nowIso(this.now),
    };
    replaceMarkdownState(row.files.agent, agent);
    atomicWriteText(row.files.portfolio, this._renderPortfolio(portfolio));
    const dailyPath = this._dailyPath(agentId, decisionDate);
    const previous = readMarkdownState(dailyPath) || {};
    const recovered = { ...previous };
    delete recovered.failureKind;
    delete recovered.failedAt;
    delete recovered.error;
    const dailyState = {
      ...recovered,
      schemaVersion: 2,
      runId: runId || String(previous.runId || ''),
      agentId,
      decisionDate,
      dataAsOf: String(payload.dataAsOf || previous.dataAsOf || '').slice(0, 10),
      stage: 'complete',
      status: 'decision-queued',
      hook: payload.hook,
      decision,
      dailyBrief: payload.dailyBrief,
      rawHook: String(payload.markdown || '').slice(0, 40000),
      completedAt: nowIso(this.now),
    };
    atomicWriteText(dailyPath, this._renderDaily(dailyState));
    return this.getAgent(agentId);
  }

  recordExecutionResult(agentId, decisionDate, result = {}) {
    const filePath = this._dailyPath(agentId, decisionDate);
    const previous = readMarkdownState(filePath);
    if (!previous) return null;
    const state = {
      ...previous,
      execution: {
        settled: result.settled === true,
        reason: String(result.reason || ''),
        trades: Array.isArray(result.trades) ? result.trades : [],
        orderNotes: Array.isArray(result.orderNotes) ? result.orderNotes : [],
        nav: Number(result.nav || 0),
        recordedAt: nowIso(this.now),
      },
    };
    atomicWriteText(filePath, this._renderDaily(state));
    return state;
  }

  recordCloseResult(agentId, decisionDate, stats) {
    const filePath = this._dailyPath(agentId, decisionDate);
    const previous = readMarkdownState(filePath);
    if (!previous) return null;
    const state = {
      ...previous,
      closeResult: {
        nav: Number(stats.nav || 0),
        dailyReturn: Number(stats.dailyReturn || 0),
        totalReturn: Number(stats.totalReturn || 0),
        positionWeight: Number(stats.positionWeight || 0),
        recordedAt: nowIso(this.now),
      },
    };
    atomicWriteText(filePath, this._renderDaily(state));
    return state;
  }

  _weeklyPath(agentId, saturdayDate) {
    return path.join(this.agentDir(agentId), 'weekly', `${saturdayDate}.md`);
  }

  _renderWeekly(state) {
    const review = state.review || null;
    return [
      `# ${state.saturdayDate} 周度沉淀`, '', stateBlock(state), '',
      '## 状态', '',
      `- 状态：${state.status || 'running'}`,
      `- 覆盖交易日：${(state.tradingDates || []).join('、') || '无'}`,
      `- Session：${state.sessionId || '沿用绑定 Session'}`,
      ...(state.error ? [`- 错误：${state.error}`] : []), '',
      ...(review ? [
        '## 本周结论', '', review.summary, '',
        '## 过程正确的地方', '', review.process_win, '',
        '## 过程需要纠正的地方', '', review.process_mistake, '',
        '## 本周沉淀经验', '', review.lesson, '',
        '## 最强反例', '', review.strongest_counterexample, '',
        '## CHECKLIST 修改提案', '',
        review.checklist_proposal
          ? `- 规则：${review.checklist_proposal.rule_id}\n- 原规则：${review.checklist_proposal.old_rule}\n- 建议：${review.checklist_proposal.proposed_rule}\n- 原因：${review.checklist_proposal.reason}`
          : '本周不建议修改规则。', '',
      ] : []),
      ...(state.raw ? ['## 原始回复', '', state.raw, ''] : []),
    ].join('\n');
  }

  recordWeeklyStart(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const saturdayDate = String(payload.saturdayDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(saturdayDate)) throw new Error('invalid weekly date');
    const state = {
      schemaVersion: 1,
      runId: String(payload.runId || ''),
      agentId,
      saturdayDate,
      tradingDates: Array.isArray(payload.tradingDates) ? payload.tradingDates : [],
      status: 'running',
      startedAt: nowIso(this.now),
      promptHash: String(payload.promptHash || ''),
    };
    atomicWriteText(this._weeklyPath(agentId, saturdayDate), this._renderWeekly(state));
    return state;
  }

  recordWeeklyFailure(agentId, payload = {}) {
    const saturdayDate = String(payload.saturdayDate || '').slice(0, 10);
    const filePath = this._weeklyPath(agentId, saturdayDate);
    const state = {
      ...(readMarkdownState(filePath) || {}),
      status: 'failed',
      error: String(payload.error || 'unknown error').slice(0, 2000),
      failedAt: nowIso(this.now),
    };
    atomicWriteText(filePath, this._renderWeekly(state));
    return state;
  }

  recordWeeklyReview(agentId, payload = {}) {
    const row = this.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const saturdayDate = String(payload.saturdayDate || '').slice(0, 10);
    const filePath = this._weeklyPath(agentId, saturdayDate);
    const previous = readMarkdownState(filePath) || {};
    if (previous.status === 'completed') return this.getAgent(agentId);
    const review = payload.review;
    const runId = String(payload.runId || previous.runId || '');
    const alreadyCounted = !!runId && String(row.agent.lastWeeklyRunId || '') === runId;
    const memory = { ...(row.memory || {}), schemaVersion: 2, candidates: [...(row.memory.candidates || [])] };
    if (!runId || !memory.candidates.some((item) => item.runId === runId)) {
      memory.candidates.push({
        date: saturdayDate,
        runId,
        source: 'weekly-review',
        text: review.lesson,
        processWin: review.process_win,
        mistake: review.process_mistake,
        evidenceFor: review.evidence_for || [],
        evidenceAgainst: review.evidence_against || [],
      });
    }
    memory.updatedAt = nowIso(this.now);
    const evolution = { ...(row.evolution || {}), proposals: [...(row.evolution.proposals || [])] };
    if (review.checklist_proposal && (!runId || !evolution.proposals.some((item) => item.runId === runId && item.type === 'checklist'))) {
      evolution.proposals.push({
        date: saturdayDate,
        runId,
        type: 'checklist',
        ...review.checklist_proposal,
      });
    }
    evolution.updatedAt = nowIso(this.now);
    const agent = {
      ...row.agent,
      weeklyReviewCount: Number(row.agent.weeklyReviewCount || 0) + (alreadyCounted ? 0 : 1),
      evolutionDays: Number(row.agent.evolutionDays || 0) + (alreadyCounted ? 0 : 1),
      lastWeeklyAt: alreadyCounted ? row.agent.lastWeeklyAt : nowIso(this.now),
      lastWeeklyRunId: runId || row.agent.lastWeeklyRunId || '',
      updatedAt: nowIso(this.now),
    };
    replaceMarkdownState(row.files.agent, agent);
    atomicWriteText(row.files.memory, this._renderMemory(memory));
    atomicWriteText(row.files.evolution, this._renderEvolution(evolution));
    const state = {
      ...previous,
      runId,
      status: 'completed',
      review,
      raw: String(payload.markdown || '').slice(0, 40000),
      completedAt: nowIso(this.now),
    };
    atomicWriteText(filePath, this._renderWeekly(state));
    return this.getAgent(agentId);
  }

  _extractSection(text, heading) {
    const escaped = escapeRegex(heading);
    const match = String(text || '').match(new RegExp(`##\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`));
    return match ? match[1].trim() : '';
  }

  snapshotPath(snapshotOrDate, phase = 'decision') {
    const snapshot = snapshotOrDate && typeof snapshotOrDate === 'object' ? snapshotOrDate : null;
    const date = String(snapshot ? (snapshot.decisionFor || snapshot.asOf) : snapshotOrDate || '').slice(0, 10);
    const snapshotPhase = String(snapshot && snapshot.phase || phase || 'decision').replace(/[^a-z0-9_-]/gi, '') || 'decision';
    return path.join(this.snapshotsDir, `${date}-${snapshotPhase}.md`);
  }

  saveSnapshot(snapshot, options = {}) {
    const asOf = String(snapshot && snapshot.asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('invalid snapshot asOf');
    const phase = String(snapshot.phase || 'decision');
    const filePath = this.snapshotPath(snapshot, phase);
    const prices = snapshot.prices && typeof snapshot.prices === 'object' ? snapshot.prices : {};
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    const doc = [
      `# ${snapshot.decisionFor || asOf} 联赛${phase === 'decision' ? '盘前决策' : phase === 'open' ? '开盘执行' : '收盘结果'}快照`, '',
      stateBlock({ ...snapshot, schemaVersion: 2 }), '',
      '## 时点', '',
      `- 阶段：${phase}`,
      `- 数据日期：${asOf}`,
      `- 对应交易日：${snapshot.decisionFor || asOf}`,
      `- 生成时间：${snapshot.createdAt || '—'}`, '',
      '## 候选池', '',
      candidates.length
        ? markdownTable(['排名', '股票', '模式', '得分', '收盘价', '摘要'], candidates.map((row, index) => [index + 1, `${row.name || ''} ${row.symbol}`, row.mode || '', row.score == null ? '' : row.score, row.close, row.summary || '']))
        : '无候选。', '',
      '## 价格', '',
      Object.keys(prices).length
        ? markdownTable(['股票', '名称', '开盘价', '最新/收盘价', '来源'], Object.entries(prices).sort().map(([symbol, row]) => [symbol, row.name || '', row.open || '', row.close, row.source || '初心冻结快照']))
        : '无。', '',
      '> 所有 Agent 使用同一个只读快照；历史快照不得事后改写。', '',
    ].join('\n');
    if (fs.existsSync(filePath)) {
      const previous = readMarkdownState(filePath);
      if (options.allowSupplement && previous) {
        const previousPrices = previous.prices && typeof previous.prices === 'object' ? previous.prices : {};
        for (const [symbol, row] of Object.entries(previousPrices)) {
          const next = prices[symbol];
          if (!next || Number(next.open || 0) !== Number(row.open || 0) || Number(next.close || 0) !== Number(row.close || 0)) {
            throw new Error(`快照 ${asOf} 已冻结，补充时不得改写 ${symbol} 的既有价格`);
          }
        }
      } else if (previous && previous.snapshotId && previous.snapshotId !== snapshot.snapshotId) {
        throw new Error(`快照 ${asOf} 已冻结，拒绝覆盖`);
      } else {
        return previous || snapshot;
      }
    }
    atomicWriteText(filePath, doc);
    return snapshot;
  }

  getSnapshot(asOf, phase = 'decision') {
    return readMarkdownState(this.snapshotPath(asOf, phase))
      || (phase === 'decision' ? readMarkdownState(path.join(this.snapshotsDir, `${String(asOf || '')}.md`)) : null);
  }

  getDaily(agentId, asOf) {
    const date = String(asOf || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return readMarkdownState(this._dailyPath(agentId, date));
  }

  listDaily(agentId, options = {}) {
    const dir = path.join(this.agentDir(agentId), 'daily');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort(); }
    catch { return []; }
    const before = String(options.before || '9999-12-31');
    const after = String(options.after || '0000-01-01');
    const limit = Math.max(1, Math.min(260, Number(options.limit || 20)));
    return names
      .map((name) => name.slice(0, 10))
      .filter((date) => date <= before && date >= after)
      .slice(-limit)
      .map((date) => readMarkdownState(path.join(dir, `${date}.md`)))
      .filter(Boolean);
  }

  getLatestDaily(agentId) {
    const rows = this.listDaily(agentId, { limit: 1 });
    return rows.length ? rows[0] : null;
  }

  getWeekly(agentId, saturdayDate) {
    const date = String(saturdayDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return readMarkdownState(this._weeklyPath(agentId, date));
  }

  getLatestWeekly(agentId) {
    const dir = path.join(this.agentDir(agentId), 'weekly');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort(); }
    catch { return null; }
    return names.length ? readMarkdownState(path.join(dir, names[names.length - 1])) : null;
  }
}

module.exports = {
  AGENT_ID_RE,
  AgentLeagueStore,
  isCompletedDailyDecision,
  PROMPT_EDIT_LIMIT,
  PROMPT_FILE_DEFINITIONS,
  PromptFileConflictError,
  RUN_LEASE_TTL_MS,
  summarizeDecisionHistory,
  STATE_MARKER,
  atomicWriteText,
  composeManagedMarkdown,
  defaultRoot,
  readMarkdownState,
  readStateFromText,
  replaceMarkdownState,
  stripManagedState,
  stateBlock,
};
