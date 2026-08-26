'use strict';

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { AgentLeagueStore } = require('../../core/agent-league-store.js');
const {
  parseDecisionMarkdown,
  validateDecision,
} = require('../../core/agent-league-accounting.js');
const {
  PHILOSOPHY_TEMPLATES,
  getPhilosophy,
} = require('../../core/agent-league-philosophies.js');
const {
  MODEL_OPTIONS_BY_KIND,
  DEFAULT_MODEL_BY_KIND,
} = require('../../core/model-options.js');
const scenes = require('../../core/group-chat-scenes.js');
const { waitCliReady, sendToPty } = require('../../core/group-chat-watcher.js');

const API_BASE = process.env.CHUXIN_API_BASE || 'http://127.0.0.1:3004';
const WORKSPACE = 'hub-primary-workspace';
const AGENT_SCOPE_PREFIX = 'agent-league-';
const SCHEDULER_CHECK_MS = 5 * 60 * 1000;
const PROVIDERS = Object.freeze({
  'codex-cli': { kind: 'codex', label: 'Codex', mark: 'CX' },
  'claude-cli': { kind: 'claude', label: 'Claude', mark: 'CL' },
  'gemini-cli': { kind: 'gemini', label: 'Gemini', mark: 'GM' },
  'kimi-cli': { kind: 'kimi', label: 'Kimi', mark: 'KM' },
  'deepseek-cli': { kind: 'deepseek', label: 'DeepSeek', mark: 'DS' },
});

function httpJson(method, url, timeoutMs, body = null, headers = {}) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request({
      method,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = text ? JSON.parse(text) : {};
          resolve({ ok: response.statusCode < 400, status: response.statusCode, body: parsed, error: response.statusCode < 400 ? null : (parsed.detail || text) });
        } catch (error) {
          resolve({ ok: false, status: response.statusCode, error: `bad json: ${error.message}`, text });
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ ok: false, status: 0, error: error.message }));
    if (payload) request.write(payload);
    request.end();
  });
}

function providerCatalog() {
  return Object.entries(PROVIDERS).map(([provider, row]) => ({
    provider,
    kind: row.kind,
    name: row.label,
    mark: row.mark,
    defaultModel: DEFAULT_MODEL_BY_KIND[row.kind],
    models: (MODEL_OPTIONS_BY_KIND[row.kind] || []).map((item) => ({ ...item })),
  }));
}

function validateProvider(provider, model) {
  const row = PROVIDERS[String(provider || '')];
  if (!row) return { ok: false, error: 'unsupported-provider', message: `不支持的 Provider：${provider}` };
  const selected = String(model || DEFAULT_MODEL_BY_KIND[row.kind] || '');
  if (!(MODEL_OPTIONS_BY_KIND[row.kind] || []).some((item) => item.id === selected)) {
    return { ok: false, error: 'unsupported-model', message: `模型 ${selected} 不在 Hub 的 ${row.label} 目录中。` };
  }
  return { ok: true, ...row, provider: String(provider), model: selected };
}

function nativeSessionMeta(session) {
  if (!session) return {};
  return {
    ...(session.ccSessionId ? { ccSessionId: session.ccSessionId } : {}),
    ...(session.codexSid ? { codexSid: session.codexSid } : {}),
    ...(session.geminiChatId ? { geminiChatId: session.geminiChatId } : {}),
    ...(session.geminiProjectHash ? { geminiProjectHash: session.geminiProjectHash } : {}),
    ...(session.geminiProjectRoot ? { geminiProjectRoot: session.geminiProjectRoot } : {}),
    ...(session.kimiSid ? { kimiSid: session.kimiSid } : {}),
    ...(session.kimiSessionDir ? { kimiSessionDir: session.kimiSessionDir } : {}),
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
  };
}

function resumeOptions(record) {
  const native = record && record.session && record.session.nativeSession
    ? record.session.nativeSession
    : (record && record.nativeSession) || {};
  const kind = record && record.agent ? record.agent.kind : record && record.kind;
  if (kind === 'codex' && native.codexSid) return { useResume: true, codexSid: native.codexSid };
  if (kind === 'deepseek' && native.codexSid) return { useResume: true, codexSid: native.codexSid };
  if (kind === 'claude' && native.ccSessionId) return { resumeCCSessionId: native.ccSessionId, resumeTranscriptPath: native.transcriptPath };
  if (kind === 'gemini' && native.geminiChatId) {
    return {
      useResume: true,
      geminiChatId: native.geminiChatId,
      geminiProjectHash: native.geminiProjectHash,
      geminiProjectRoot: native.geminiProjectRoot,
    };
  }
  if (kind === 'kimi' && native.kimiSid) {
    return { useResume: true, kimiSid: native.kimiSid, kimiSessionDir: native.kimiSessionDir };
  }
  return null;
}

function addCodexMcpEntry(options, entry) {
  if (!entry) return;
  options.codexMcpEntries = Array.isArray(options.codexMcpEntries) ? options.codexMcpEntries : [];
  if (!options.codexMcpEntries.some((row) => row && row.name === entry.name)) options.codexMcpEntries.push(entry);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function slugifyAgentId(value) {
  const ascii = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ascii.length >= 3 ? ascii : `agent-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

function compactCandidate(item) {
  const tech = item && item.tech && typeof item.tech === 'object' ? item.tech : {};
  const close = Number(tech.close);
  if (!item || !/^\d{6}\.(SH|SZ|BJ)$/.test(String(item.symbol || '')) || !Number.isFinite(close) || close <= 0) return null;
  const mode = String(tech.mode || '');
  const score = mode === 'chase' ? Number(tech.chase_score || tech.quality_score || 0) : Number(tech.setup_score || tech.quality_score || 0);
  return {
    symbol: String(item.symbol),
    name: String(item.name || tech.name || item.symbol),
    mode,
    score,
    close,
    state: String(item.state || ''),
    summary: String(item.summary || ''),
    tech: {
      p_rs: Number(tech.p_rs || 0),
      bias20: Number(tech.bias20 || 0),
      ret5: Number(tech.ret5 || 0),
      ret20: Number(tech.ret20 || 0),
      dd60: Number(tech.dd60 || 0),
      vr: Number(tech.vr || 0),
      temp: String(tech.temp || ''),
    },
  };
}

function findDailyClose(payload, asOf) {
  const arrays = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) {
      if (value.some((row) => row && typeof row === 'object' && ('date' in row) && ('close' in row))) arrays.push(value);
      for (const row of value.slice(0, 5)) visit(row, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  };
  visit(payload);
  for (const rows of arrays) {
    const hit = rows.find((row) => String(row.date || '').slice(0, 10) === asOf && Number(row.close) > 0);
    if (hit) return { close: Number(hit.close), name: String(hit.name || ''), source: '初心日线快照' };
  }
  return null;
}

async function buildFrozenSnapshot(options = {}) {
  const apiBase = options.apiBase || API_BASE;
  const workspace = options.workspace || WORKSPACE;
  const request = options.httpJson || httpJson;
  const store = options.store;
  const overview = await request('GET', `${apiBase}/api/observe/overview`, 15000, null, { 'X-Chuxin-Workspace': workspace });
  if (!overview.ok || !overview.body) throw new Error(`初心概况不可用：${overview.error || overview.status}`);
  const asOf = String(overview.body.header && overview.body.header.data_asof || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('初心概况缺少有效 data_asof');
  const existingSnapshot = store && store.getSnapshot(asOf);
  if (existingSnapshot) return existingSnapshot;
  const response = await request('GET', `${apiBase}/api/observe/candidates?limit=120`, 20000, null, { 'X-Chuxin-Workspace': workspace });
  if (!response.ok || !response.body || !Array.isArray(response.body.items)) {
    throw new Error(`初心候选池不可用：${response.error || response.status}`);
  }
  const candidates = response.body.items.map(compactCandidate).filter(Boolean).slice(0, 80);
  if (!candidates.length) throw new Error('初心冻结候选池为空，拒绝生成联赛快照');
  const prices = Object.fromEntries(candidates.map((row) => [row.symbol, {
    name: row.name, close: row.close, source: '初心技术雷达冻结收盘价',
  }]));
  const requiredSymbols = new Set(options.requiredSymbols || []);
  for (const symbol of requiredSymbols) {
    if (prices[symbol]) continue;
    const dashboard = await request('GET', `${apiBase}/api/market/${encodeURIComponent(symbol)}/dashboard?include_daily=true`, 20000, null, { 'X-Chuxin-Workspace': workspace });
    if (!dashboard.ok || !dashboard.body) throw new Error(`无法补齐 ${symbol} 的冻结价格：${dashboard.error || dashboard.status}`);
    const close = findDailyClose(dashboard.body, asOf);
    if (!close) throw new Error(`初心日线中找不到 ${symbol} 在 ${asOf} 的收盘价`);
    prices[symbol] = { name: close.name || symbol, close: close.close, source: close.source };
  }
  const normalized = {
    schemaVersion: 1,
    asOf,
    createdAt: new Date().toISOString(),
    compileId: String(overview.body.compile_id || ''),
    candidates,
    prices,
    sourceHealth: overview.body.header && overview.body.header.sources_health || {},
  };
  normalized.snapshotId = `snapshot-${asOf}-${sha256(JSON.stringify({ asOf, candidates, prices })).slice(0, 12)}`;
  return store ? store.saveSnapshot(normalized) : normalized;
}

function buildDailyPrompt(agentRow, snapshot, runId) {
  const { agent, files, folder, stats } = agentRow;
  const snapshotPath = path.join(path.dirname(path.dirname(folder)), 'snapshots', `${snapshot.asOf}.md`);
  const schema = {
    run_id: runId,
    as_of: snapshot.asOf,
    action_summary: '一句话说明今天的组合动作',
    market_view: '市场判断与最重要的证据/反证',
    cash_target: 0.40,
    targets: [{
      symbol: '600000.SH', name: '示例', target_weight: 0.20,
      conviction: 0.65, horizon_days: 10, thesis: '买入逻辑', invalidation: '失效条件',
    }],
    risk_notes: ['主要风险'],
    reflection: {
      kept: '今天继续保留的纪律',
      mistake: '上一轮需要纠正的错误；没有则写无',
      lesson_candidate: '只作为待验证经验，不得宣称已验证',
      evidence_for: ['支持证据'],
      evidence_against: ['反例或反证'],
    },
    strategy_proposal: null,
  };
  return [
    '# 初心 Agent 投资联赛 · 每日赛程',
    '',
    `Agent：${agent.name}（${agent.philosophyTitle}）`,
    `Run ID：${runId}`,
    `冻结快照日：${snapshot.asOf}`,
    '',
    '这是模拟交易，不连接券商。你只能提交完整目标组合；现金、成交、费用、净值和排名由确定性账本计算。',
    `本轮使用 T=${snapshot.asOf} 的冻结数据形成决策，最早在下一份日期晚于 T 的完整收盘快照执行。`,
    '',
    '## 必须读取',
    '',
    `- 核心理念：${files.agent}`,
    `- 当前策略：${files.strategy}`,
    `- 当前组合：${files.portfolio}`,
    `- 长期经验：${files.memory}`,
    `- 统一冻结快照：${snapshotPath}`,
    '',
    '## 竞赛约束',
    '',
    '- 只能选择冻结快照候选池中的股票；已有持仓即使不在候选池，也可继续持有或退出。',
    '- 最多 6 只股票；单票不超过 30%；现金不少于 5%；完整目标权重与现金之和接近 100%。',
    '- 不得读取其他 Agent 的文件或答案，不得事后改写历史。',
    '- 每日必须复盘并提出一个待验证经验；核心理念不能在本轮静默修改。',
    '- 若确实需要改变可执行策略，只能填写 strategy_proposal，系统会记录到 EVOLUTION.md，不会自动覆盖核心理念。',
    '',
    `当前资产：${Number(stats.nav || agent.initialCash).toFixed(2)}；累计收益：${(Number(stats.totalReturn || 0) * 100).toFixed(2)}%；最大回撤：${(Number(stats.maxDrawdown || 0) * 100).toFixed(2)}%。`,
    '',
    '## 输出合同',
    '',
    '先用自然语言解释，最后必须且只能出现一个以下代码块；JSON 中的 run_id 与 as_of 必须原样保留：',
    '',
    '```agent-league-decision',
    JSON.stringify(schema, null, 2),
    '```',
    '',
  ].join('\n');
}

function publicAgent(row, sessionManager) {
  const live = row.session && row.session.hubSessionId && sessionManager
    ? sessionManager.getSession(row.session.hubSessionId)
    : null;
  const philosophy = getPhilosophy(row.agent.philosophyKey) || {
    key: row.agent.philosophyKey,
    title: row.agent.philosophyTitle,
    summary: '', edge: '', horizon: '',
  };
  return {
    id: row.agent.id,
    name: row.agent.name,
    initialCash: row.agent.initialCash,
    provider: row.agent.provider,
    kind: row.agent.kind,
    model: row.agent.model,
    status: row.agent.status,
    philosophy,
    strategyVersion: row.agent.strategyVersion,
    decisionCount: row.agent.decisionCount,
    evolutionDays: row.agent.evolutionDays,
    lastDecisionAt: row.agent.lastDecisionAt,
    folder: row.folder,
    files: row.files,
    stats: row.stats,
    portfolio: {
      cash: row.portfolio.cash,
      positions: row.portfolio.positions,
      pendingDecision: row.portfolio.pendingDecision ? {
        runId: row.portfolio.pendingDecision.runId,
        decisionAsOf: row.portfolio.pendingDecision.decisionAsOf,
      } : null,
    },
    session: {
      ...row.session,
      live: !!live,
      status: live ? (live.status || 'idle') : (row.session.status || (row.session.hubSessionId ? 'restorable' : 'unbound')),
      nativeSession: live ? { ...(row.session.nativeSession || {}), ...nativeSessionMeta(live) } : (row.session.nativeSession || {}),
    },
    recentTrades: (row.trades.rows || []).slice(-5).reverse(),
    recentLessons: (row.memory.candidates || []).slice(-5).reverse(),
    recentProposals: (row.evolution.proposals || []).slice(-5).reverse(),
  };
}

function registerAgentLeagueIpc(ipcMain, deps = {}) {
  const {
    sessionManager = null,
    transcriptTap = null,
    registerSessionForTap = () => {},
    sendToRenderer = () => {},
    getHubDataDir = () => process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub'),
    getHookPort = () => 0,
    hookToken = '',
  } = deps;
  const store = deps.store || new AgentLeagueStore({ env: deps.env || process.env });
  const request = deps.httpJson || httpJson;
  const waitReady = deps.waitCliReady || waitCliReady;
  const sendPrompt = deps.sendToPty || sendToPty;
  const pendingByHubSession = new Map();
  let currentRun = null;
  let schedulerTimer = null;
  const initialSchedule = store.getSchedule();
  if (initialSchedule.lastRunStatus === 'running' && !store.currentRunLease()) {
    store.saveSchedule({ ...initialSchedule, lastRunStatus: 'interrupted' });
  }

  function researchMcpOptions(kind, agentId) {
    const options = {};
    const hookPort = Number(getHookPort() || 0);
    if (!hookPort) return options;
    const hubDataDir = getHubDataDir();
    const scopeId = `${AGENT_SCOPE_PREFIX}${agentId}`;
    if (kind === 'claude') {
      options.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, scopeId, hookPort, hookToken, kind, { enableChuxin: true });
    } else if (kind === 'codex') {
      options.codexBypassApprovals = true;
      addCodexMcpEntry(options, scenes.buildResearchMcpEntryForCodex(scopeId, hookPort, hookToken, hubDataDir, { enableChuxin: true }));
    }
    return options;
  }

  function createNativeSession(row, resume = null) {
    if (!sessionManager) throw new Error('session-manager-unavailable');
    const selection = validateProvider(row.agent.provider, row.agent.model);
    if (!selection.ok) throw new Error(selection.message || selection.error);
    const existingHubId = String(row.session.hubSessionId || '');
    const options = {
      ...(existingHubId ? { id: existingHubId } : {}),
      cwd: row.folder,
      title: `Agent · ${row.agent.name}`,
      model: selection.model,
      userRenamed: true,
      purpose: 'agent-league',
      hiddenFromSidebar: false,
      ...researchMcpOptions(selection.kind, row.agent.id),
      ...(resume || {}),
    };
    const session = sessionManager.createSession(selection.kind, options);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    store.bindSession(row.agent.id, {
      hubSessionId: session.id,
      status: 'active',
      nativeSession: { ...(row.session.nativeSession || {}), ...nativeSessionMeta(session) },
    });
    return session;
  }

  function ensureAgentSession(agentId) {
    const row = store.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const hubId = String(row.session.hubSessionId || '');
    const live = hubId && sessionManager ? sessionManager.getSession(hubId) : null;
    if (live) {
      store.bindSession(agentId, { status: live.status || 'active', nativeSession: nativeSessionMeta(live) });
      return live;
    }
    const resume = hubId ? resumeOptions(row) : null;
    if (hubId && !resume) {
      throw new Error('该 Agent 已有 Hub 绑定，但尚未取得原生 Session ID；不能静默新建会话，请先显式创建新代次。');
    }
    return createNativeSession(row, resume);
  }

  function requiredSymbols() {
    const symbols = new Set();
    for (const row of store.listAgents()) {
      for (const position of row.portfolio.positions || []) symbols.add(position.symbol);
      for (const target of row.portfolio.pendingDecision && row.portfolio.pendingDecision.decision && row.portfolio.pendingDecision.decision.targets || []) {
        symbols.add(target.symbol);
      }
    }
    return symbols;
  }

  function runPublicState() {
    if (!currentRun) return null;
    return {
      runId: currentRun.runId,
      asOf: currentRun.asOf,
      trigger: currentRun.trigger,
      startedAt: currentRun.startedAt,
      queue: [...currentRun.queue],
      active: [...currentRun.active],
      completed: [...currentRun.completed],
      failed: [...currentRun.failed],
      settlement: currentRun.settlement,
    };
  }

  function emitRunUpdate() {
    sendToRenderer('agent-league:run-updated', { run: runPublicState() });
  }

  function finishRunIfDone() {
    if (!currentRun || currentRun.queue.length || currentRun.active.size) return false;
    const status = currentRun.failed.length ? (currentRun.completed.length ? 'partial' : 'failed') : 'completed';
    const schedule = store.getSchedule();
    store.saveSchedule({
      ...schedule,
      lastSnapshotAsOf: currentRun.asOf,
      lastRunId: currentRun.runId,
      lastRunStatus: status,
    });
    const finished = { ...runPublicState(), status, finishedAt: new Date().toISOString() };
    if (currentRun.leaseTimer) clearInterval(currentRun.leaseTimer);
    store.releaseRunLease(currentRun.leaseToken);
    currentRun = null;
    sendToRenderer('agent-league:run-finished', { run: finished });
    return true;
  }

  function markFailed(agentId, error) {
    if (!currentRun) return;
    if (currentRun.completed.includes(agentId)
        || currentRun.failed.some((row) => row.agentId === agentId)) return;
    currentRun.active.delete(agentId);
    currentRun.failed.push({ agentId, error: String(error && error.message || error) });
    try {
      store.recordRunFailure(agentId, { runId: currentRun.runId, asOf: currentRun.asOf, error: String(error && error.message || error) });
    } catch (persistError) {
      console.warn('[agent-league] failed to persist run failure:', persistError && persistError.message);
    }
    sendToRenderer('agent-league:agent-failed', { runId: currentRun.runId, agentId, message: String(error && error.message || error) });
    emitRunUpdate();
  }

  async function startAgentTurn(agentId) {
    if (!currentRun) return;
    const row = store.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const session = ensureAgentSession(agentId);
    const prompt = buildDailyPrompt(row, currentRun.snapshot, currentRun.runId);
    const promptHash = sha256(prompt);
    store.recordRunStart(agentId, {
      runId: currentRun.runId,
      asOf: currentRun.asOf,
      promptHash,
      snapshotPath: path.join(store.snapshotsDir, `${currentRun.asOf}.md`),
    });
    pendingByHubSession.set(session.id, {
      runId: currentRun.runId,
      agentId,
      asOf: currentRun.asOf,
      snapshot: currentRun.snapshot,
      promptHash,
      startedAt: Date.now(),
    });
    const ready = await waitReady(session.id, row.agent.kind, 60000);
    if (!ready) throw new Error(`${row.agent.provider} CLI 在 60 秒内未就绪`);
    const sent = await sendPrompt(session.id, prompt, row.agent.kind);
    if (!sent) throw new Error('每日 Prompt 写入 PTY 后未检测到提交活动');
    store.bindSession(agentId, { status: 'running', nativeSession: nativeSessionMeta(session) });
    sendToRenderer('agent-league:agent-started', { runId: currentRun.runId, agentId, sessionId: session.id });
  }

  function pumpQueue() {
    if (!currentRun) return;
    const maxConcurrency = Math.max(1, Math.min(8, Number(store.getSchedule().maxConcurrency || 2)));
    while (currentRun.active.size < maxConcurrency && currentRun.queue.length) {
      const agentId = currentRun.queue.shift();
      currentRun.active.add(agentId);
      startAgentTurn(agentId).catch((error) => {
        for (const [sessionId, pending] of pendingByHubSession.entries()) {
          if (pending.agentId === agentId) pendingByHubSession.delete(sessionId);
        }
        markFailed(agentId, error);
        pumpQueue();
        finishRunIfDone();
      });
    }
    emitRunUpdate();
    finishRunIfDone();
  }

  async function runDay(input = {}) {
    if (currentRun) return { ok: false, error: 'run-busy', message: '上一轮联赛仍在运行', run: runPublicState() };
    const rows = store.listAgents();
    if (!rows.length) return { ok: false, error: 'no-agents', message: '请先创建至少一个 Agent' };
    const snapshot = await buildFrozenSnapshot({
      apiBase: input.apiBase || API_BASE,
      workspace: WORKSPACE,
      httpJson: request,
      store,
      requiredSymbols: requiredSymbols(),
    });
    const schedule = store.getSchedule();
    if (!input.force && schedule.lastSnapshotAsOf === snapshot.asOf && ['completed', 'running'].includes(schedule.lastRunStatus)) {
      return { ok: true, alreadyRun: true, snapshot, schedule };
    }
    const runnableRows = rows.filter((row) => {
      const daily = store.getDaily(row.agent.id, snapshot.asOf);
      return !daily || daily.status !== 'decision-queued';
    });
    if (!runnableRows.length) {
      store.saveSchedule({ ...schedule, lastSnapshotAsOf: snapshot.asOf, lastRunStatus: 'completed' });
      return { ok: true, alreadyRun: true, snapshot, schedule: store.getSchedule() };
    }
    const runId = `league-${snapshot.asOf.replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
    const claim = store.claimRunLease({
      ownerHub: String(process.env.CLAUDE_HUB_DATA_DIR || 'default'),
      runId,
    });
    if (!claim.ok) {
      return { ok: false, error: 'run-busy-elsewhere', message: '同一联赛正在另一 Hub 中运行', lease: claim.lease };
    }
    const leaseTimer = setInterval(() => {
      if (!store.renewRunLease(claim.token)) console.warn('[agent-league] run lease renewal failed');
    }, 30000);
    leaseTimer.unref?.();
    try {
      const settlement = [];
      for (const row of rows) {
        try {
          const result = store.settleAgent(row.agent.id, snapshot);
          settlement.push({ agentId: row.agent.id, settled: result.settled, trades: result.trades.length, reason: result.reason });
        } catch (error) {
          throw new Error(`结算 ${row.agent.name} 失败：${error.message}`);
        }
      }
      currentRun = {
        runId,
        asOf: snapshot.asOf,
        trigger: String(input.trigger || 'manual'),
        startedAt: new Date().toISOString(),
        snapshot,
        settlement,
        queue: runnableRows.map((row) => row.agent.id),
        active: new Set(),
        completed: [],
        failed: [],
        leaseToken: claim.token,
        leaseTimer,
      };
    } catch (error) {
      clearInterval(leaseTimer);
      store.releaseRunLease(claim.token);
      throw error;
    }
    store.saveSchedule({ ...schedule, lastSnapshotAsOf: snapshot.asOf, lastRunId: runId, lastRunStatus: 'running' });
    pumpQueue();
    return { ok: true, run: runPublicState(), snapshot };
  }

  function currentChinaClock(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  async function schedulerTick(now = new Date()) {
    const schedule = store.getSchedule();
    if (!schedule.enabled || currentRun) return { ok: true, skipped: 'disabled-or-running' };
    const clock = currentChinaClock(now);
    if (['Sat', 'Sun'].includes(clock.weekday)) return { ok: true, skipped: 'weekend' };
    const currentMinutes = Number(clock.hour) * 60 + Number(clock.minute);
    const [hour, minute] = String(schedule.runTime || '18:30').split(':').map(Number);
    if (currentMinutes < hour * 60 + minute) return { ok: true, skipped: 'before-run-time' };
    try { return await runDay({ trigger: 'scheduler' }); }
    catch (error) { return { ok: false, error: 'scheduler-run-failed', message: error.message }; }
  }

  function startScheduler() {
    if (schedulerTimer) return schedulerTimer;
    schedulerTimer = setInterval(() => {
      schedulerTick().then((result) => {
        if (result && result.ok === false) console.warn('[agent-league] scheduler tick failed:', result.message || result.error);
      }).catch((error) => console.warn('[agent-league] scheduler tick threw:', error && error.message));
    }, SCHEDULER_CHECK_MS);
    schedulerTimer.unref?.();
    return schedulerTimer;
  }

  function stopScheduler() {
    const hadTimer = !!schedulerTimer;
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    if (currentRun && currentRun.leaseTimer) clearInterval(currentRun.leaseTimer);
    if (currentRun && currentRun.leaseToken) store.releaseRunLease(currentRun.leaseToken);
    return hadTimer;
  }

  function isAuthorizedResearchScope(scopeId) {
    const value = String(scopeId || '');
    if (!value.startsWith(AGENT_SCOPE_PREFIX)) return false;
    const agentId = value.slice(AGENT_SCOPE_PREFIX.length);
    const row = store.getAgent(agentId);
    if (!row || !row.session.hubSessionId || !sessionManager) return false;
    return !!sessionManager.getSession(row.session.hubSessionId);
  }

  function listPublic(sort = 'return') {
    return store.listAgents(sort).map((row) => publicAgent(row, sessionManager));
  }

  ipcMain.handle('agent-league:catalog', () => ({
    ok: true,
    providers: providerCatalog(),
    philosophies: PHILOSOPHY_TEMPLATES.map((row) => ({ ...row })),
  }));
  ipcMain.handle('agent-league:list', (_event, input = {}) => ({
    ok: true,
    agents: listPublic(input.sort === 'asset' ? 'asset' : 'return'),
    schedule: store.getSchedule(),
    run: runPublicState(),
    root: store.root,
  }));
  ipcMain.handle('agent-league:create', (_event, input = {}) => {
    try {
      const selection = validateProvider(String(input.provider || 'codex-cli'), String(input.model || ''));
      if (!selection.ok) return selection;
      const philosophy = getPhilosophy(String(input.philosophyKey || ''));
      if (!philosophy) return { ok: false, error: 'invalid-philosophy', message: '请选择一个有效投资理念' };
      const id = input.id ? slugifyAgentId(input.id) : slugifyAgentId(input.name);
      const row = store.createAgent({
        id,
        name: String(input.name || philosophy.title),
        provider: selection.provider,
        kind: selection.kind,
        model: selection.model,
        philosophy,
        initialCash: Number(input.initialCash || 1000000),
      });
      const session = createNativeSession(row);
      return { ok: true, agent: publicAgent(store.getAgent(id), sessionManager), session };
    } catch (error) {
      return { ok: false, error: 'create-agent-failed', message: error.message };
    }
  });
  ipcMain.handle('agent-league:ensure-session', (_event, input = {}) => {
    try {
      const session = ensureAgentSession(String(input.agentId || ''));
      return { ok: true, session, agent: publicAgent(store.getAgent(String(input.agentId || '')), sessionManager) };
    } catch (error) {
      return { ok: false, error: 'ensure-session-failed', message: error.message };
    }
  });
  ipcMain.handle('agent-league:run-day', async (_event, input = {}) => {
    try { return await runDay({ ...input, trigger: input.trigger || 'manual' }); }
    catch (error) { return { ok: false, error: 'run-day-failed', message: error.message }; }
  });
  ipcMain.handle('agent-league:update-schedule', (_event, input = {}) => {
    const previous = store.getSchedule();
    const next = store.saveSchedule({
      ...previous,
      enabled: input.enabled === true,
      runTime: /^\d{2}:\d{2}$/.test(String(input.runTime || '')) ? input.runTime : previous.runTime,
      maxConcurrency: Math.max(1, Math.min(8, Number(input.maxConcurrency || previous.maxConcurrency || 2))),
    });
    return { ok: true, schedule: next };
  });

  if (transcriptTap && typeof transcriptTap.on === 'function') {
    transcriptTap.on('session-bound', (event = {}) => {
      const row = store.findByHubSessionId(event.hubSessionId);
      if (!row) return;
      store.bindSession(row.agent.id, {
        status: 'active',
        nativeSession: {
          ...nativeSessionMeta(sessionManager && sessionManager.getSession(event.hubSessionId)),
          ...(event.ccSessionId ? { ccSessionId: event.ccSessionId } : {}),
          ...(event.codexSid ? { codexSid: event.codexSid } : {}),
          ...(event.geminiChatId ? { geminiChatId: event.geminiChatId } : {}),
          ...(event.kimiSid ? { kimiSid: event.kimiSid } : {}),
          ...(event.sessionDir ? { kimiSessionDir: event.sessionDir } : {}),
          ...(event.rolloutPath || event.wirePath ? { transcriptPath: event.rolloutPath || event.wirePath } : {}),
        },
      });
    });

    transcriptTap.on('turn-complete', (event = {}) => {
      const pending = pendingByHubSession.get(event.hubSessionId);
      if (!pending) return;
      pendingByHubSession.delete(event.hubSessionId);
      try {
        const raw = parseDecisionMarkdown(event.text || '');
        if (String(raw.run_id || '') !== pending.runId) throw new Error(`run_id 不匹配：${raw.run_id || '(empty)'}`);
        if (String(raw.as_of || '') !== pending.asOf) throw new Error(`as_of 不匹配：${raw.as_of || '(empty)'}`);
        const row = store.getAgent(pending.agentId);
        const allowedSymbols = new Set(pending.snapshot.candidates.map((item) => item.symbol));
        const existingSymbols = new Set((row.portfolio.positions || []).map((item) => item.symbol));
        const decision = validateDecision(raw, { allowedSymbols, existingSymbols });
        const updated = store.recordDecision(pending.agentId, {
          runId: pending.runId,
          asOf: pending.asOf,
          decision,
          markdown: String(event.text || ''),
          promptHash: pending.promptHash,
        });
        store.bindSession(pending.agentId, {
          status: 'idle',
          nativeSession: nativeSessionMeta(sessionManager && sessionManager.getSession(event.hubSessionId)),
        });
        if (currentRun && currentRun.runId === pending.runId) {
          currentRun.active.delete(pending.agentId);
          currentRun.completed.push(pending.agentId);
        }
        sendToRenderer('agent-league:agent-completed', {
          runId: pending.runId,
          agentId: pending.agentId,
          agent: publicAgent(updated, sessionManager),
        });
      } catch (error) {
        markFailed(pending.agentId, error);
      }
      pumpQueue();
      finishRunIfDone();
    });
  }

  if (sessionManager && typeof sessionManager.on === 'function') {
    sessionManager.on('session-exited', (event = {}) => {
      const row = store.findByHubSessionId(event.sessionId);
      if (row) store.bindSession(row.agent.id, { status: 'restorable' });
      const pending = pendingByHubSession.get(event.sessionId);
      if (!pending) return;
      pendingByHubSession.delete(event.sessionId);
      markFailed(pending.agentId, new Error('Agent Session 在决策完成前退出；可恢复后重跑当日赛程。'));
      pumpQueue();
      finishRunIfDone();
    });
  }

  startScheduler();
  return {
    store,
    pendingByHubSession,
    providerCatalog,
    ensureAgentSession,
    getProtectedSessionIds: () => new Set(pendingByHubSession.keys()),
    isAuthorizedResearchScope,
    listPublic,
    runDay,
    schedulerTick,
    startScheduler,
    stopScheduler,
  };
}

module.exports = {
  AGENT_SCOPE_PREFIX,
  PROVIDERS,
  SCHEDULER_CHECK_MS,
  buildDailyPrompt,
  buildFrozenSnapshot,
  compactCandidate,
  findDailyClose,
  httpJson,
  nativeSessionMeta,
  providerCatalog,
  publicAgent,
  registerAgentLeagueIpc,
  resumeOptions,
  slugifyAgentId,
  validateProvider,
};
