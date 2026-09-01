'use strict';

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { AgentLeagueStore } = require('../../core/agent-league-store.js');
const {
  parseDraftMarkdown,
  parseHookMarkdown,
  parseWeeklyMarkdown,
  validateDecision,
  validateHookReview,
  validateWeeklyReview,
} = require('../../core/agent-league-accounting.js');
const {
  EXCHANGE_CALENDAR,
  chinaClock,
  nextTradingDay,
  parseClock,
  tradingDayStatus,
} = require('../../core/agent-league-calendar.js');
const { AgentLeagueVirtualDebug } = require('../../core/agent-league-virtual-debug.js');
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
const VIRTUAL_AGENT_SCOPE_PREFIX = 'agent-league-virtual-';
const SCHEDULER_CHECK_MS = 60 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
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
  if (!item || !/^\d{6}\.(SH|SZ)$/.test(String(item.symbol || '')) || !Number.isFinite(close) || close <= 0) return null;
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

function findDailyBar(payload, asOf) {
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
    if (hit) return {
      open: Number(hit.open) > 0 ? Number(hit.open) : null,
      close: Number(hit.close),
      name: String(hit.name || ''),
      source: '初心日线快照',
      quoteAt: `${asOf}T15:00:00+08:00`,
      quoteDate: asOf,
      tradable: true,
    };
  }
  return null;
}

function findDailyClose(payload, asOf) {
  const row = findDailyBar(payload, asOf);
  return row ? { close: row.close, name: row.name, source: row.source } : null;
}

function findLiveQuote(payload) {
  const quote = payload && payload.quote && typeof payload.quote === 'object' ? payload.quote : null;
  if (!quote) return null;
  const symbol = String(quote.symbol || payload.identity && payload.identity.symbol || '').toUpperCase();
  const price = Number(quote.price);
  const open = Number(quote.open);
  const quoteAt = String(quote.quote_at || '');
  if (!/^\d{6}\.(SH|SZ)$/.test(symbol) || !Number.isFinite(price) || price <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(quoteAt)) return null;
  return {
    symbol,
    name: String(quote.name || payload.identity && payload.identity.name || symbol),
    open: Number.isFinite(open) && open > 0 ? open : null,
    close: price,
    quoteAt,
    quoteDate: quoteAt.slice(0, 10),
    source: String(quote.source || quote.provider || '初心实时行情'),
    tradable: true,
    confidence: String(quote.confidence || ''),
  };
}

async function mapLimit(items, limit, worker) {
  const rows = [...items];
  const output = new Array(rows.length);
  let cursor = 0;
  async function next() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(rows[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), rows.length || 1) }, next));
  return output;
}

async function fetchTargetContexts(options = {}) {
  const request = options.httpJson || httpJson;
  const apiBase = options.apiBase || API_BASE;
  const workspace = options.workspace || WORKSPACE;
  const symbols = [...new Set(options.symbols || [])].map((value) => String(value).toUpperCase())
    .filter((value) => /^\d{6}\.(SH|SZ)$/.test(value));
  const rows = await mapLimit(symbols, 4, async (symbol) => {
    const response = await request(
      'GET',
      `${apiBase}/api/market/${encodeURIComponent(symbol)}/dashboard?include_daily=true&force=true`,
      25000,
      null,
      { 'X-Chuxin-Workspace': workspace },
    );
    let quote = response.ok ? findLiveQuote(response.body) : null;
    const targetDate = String(options.targetDate || '');
    if (response.ok && targetDate && (!quote || quote.quoteDate !== targetDate)) {
      const historical = findDailyBar(response.body, targetDate);
      quote = historical ? { symbol, name: historical.name || symbol, ...historical } : null;
    }
    return quote
      ? { ok: true, ...quote }
      : {
        ok: false,
        symbol,
        error: targetDate && response.ok
          ? `quote-date-mismatch:${targetDate}`
          : String(response.error || response.status || 'quote-unavailable'),
      };
  });
  return Object.fromEntries(rows.map((row) => [row.symbol, row]));
}

async function buildLivePriceSnapshot(options = {}) {
  const store = options.store;
  const phase = options.phase === 'close' ? 'close' : 'open';
  const decisionFor = String(options.decisionFor || chinaClock().date).slice(0, 10);
  const existing = store && store.getSnapshot(decisionFor, phase);
  const requestedSymbols = [...new Set(options.symbols || [])].map((value) => String(value).toUpperCase());
  const missingSymbols = existing
    ? requestedSymbols.filter((symbol) => !existing.prices || !existing.prices[symbol])
    : requestedSymbols;
  if (existing && !missingSymbols.length) return existing;
  const contexts = await fetchTargetContexts({ ...options, symbols: missingSymbols, targetDate: decisionFor });
  const missing = Object.values(contexts).filter((row) => !row.ok || row.quoteDate !== decisionFor || (phase === 'open' && !(row.open > 0)));
  if (missing.length) {
    const detail = missing.map((row) => `${row.symbol}:${row.error || `quote-date-${row.quoteDate || 'missing'}`}`).join(', ');
    throw new Error(`${phase === 'open' ? '开盘' : '收盘'}行情不完整：${detail}`);
  }
  const fetchedPrices = Object.fromEntries(Object.values(contexts).map((row) => [row.symbol, {
    name: row.name,
    open: row.open,
    close: row.close,
    quoteAt: row.quoteAt,
    tradable: row.tradable,
    source: row.source,
  }]));
  const prices = { ...(existing && existing.prices || {}), ...fetchedPrices };
  const snapshot = {
    ...(existing || {}),
    schemaVersion: 2,
    phase,
    decisionFor,
    asOf: decisionFor,
    createdAt: new Date().toISOString(),
    candidates: [],
    prices,
    sourceHealth: { liveMarket: 'ok' },
  };
  snapshot.snapshotId = existing && existing.snapshotId
    ? existing.snapshotId
    : `snapshot-${decisionFor}-${phase}-${sha256(JSON.stringify(prices)).slice(0, 12)}`;
  if (existing) snapshot.supplementedAt = new Date().toISOString();
  return store ? store.saveSnapshot(snapshot, { allowSupplement: !!existing }) : snapshot;
}

async function buildFrozenSnapshot(options = {}) {
  const apiBase = options.apiBase || API_BASE;
  const workspace = options.workspace || WORKSPACE;
  const request = options.httpJson || httpJson;
  const store = options.store;
  const decisionFor = String(options.decisionFor || chinaClock().date).slice(0, 10);
  const overview = await request('GET', `${apiBase}/api/observe/overview`, 15000, null, { 'X-Chuxin-Workspace': workspace });
  if (!overview.ok || !overview.body) throw new Error(`初心概况不可用：${overview.error || overview.status}`);
  const asOf = String(overview.body.header && overview.body.header.data_asof || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('初心概况缺少有效 data_asof');
  const existingSnapshot = store && store.getSnapshot(decisionFor, 'decision');
  if (existingSnapshot) return existingSnapshot;
  const response = await request('GET', `${apiBase}/api/observe/candidates?limit=200`, 20000, null, { 'X-Chuxin-Workspace': workspace });
  if (!response.ok || !response.body || !Array.isArray(response.body.items)) {
    throw new Error(`初心候选池不可用：${response.error || response.status}`);
  }
  const candidates = response.body.items.map(compactCandidate).filter(Boolean).slice(0, 200);
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
    schemaVersion: 2,
    phase: 'decision',
    decisionFor,
    asOf,
    createdAt: new Date().toISOString(),
    compileId: String(overview.body.compile_id || ''),
    candidates,
    prices,
    sourceHealth: overview.body.header && overview.body.header.sources_health || {},
  };
  normalized.snapshotId = `snapshot-${decisionFor}-decision-${sha256(JSON.stringify({ asOf, candidates, prices })).slice(0, 12)}`;
  return store ? store.saveSnapshot(normalized) : normalized;
}

function buildDraftPrompt(agentRow, snapshot, runId) {
  const { agent, files, folder, stats } = agentRow;
  const snapshotPath = path.join(path.dirname(path.dirname(folder)), 'snapshots', `${snapshot.decisionFor || snapshot.asOf}-decision.md`);
  const schema = {
    run_id: runId,
    decision_date: snapshot.decisionFor,
    data_as_of: snapshot.asOf,
    action_summary: '一句话说明今天的组合动作',
    market_view: '盘前市场判断',
    core_conflict: '今天最重要、最纠结的矛盾',
    cash_target: 0.40,
    targets: [{
      symbol: '600000.SH', name: '示例', target_weight: 0.20,
      conviction: 0.65, horizon_days: 10,
      rule_refs: ['C1', 'P1', 'R2'],
      thesis: '支持这个目标仓位的主要逻辑',
      counter_evidence: '最强反对证据',
      timing_reason: '为什么今天操作，而不是等待或保持现金',
      invalidation: '以后什么事实会证明判断错误',
    }],
    watchlist: [{ symbol: '000001.SZ', reason: '为什么值得观察', trigger: '什么条件发生后再考虑交易' }],
    risk_notes: ['主要风险'],
    memory_note: '只记录与今天判断直接相关的既有经验；周六才沉淀新经验',
  };
  return [
    '# 初心 Agent 投资联赛 · 盘前 DRAFT',
    '',
    `Agent：${agent.name}（${agent.philosophyTitle}）`,
    `Run ID：${runId}`,
    `决策交易日：${snapshot.decisionFor}`,
    `可用数据截至：${snapshot.asOf}`,
    '',
    ...(snapshot.virtualDebug ? [
      '> 【虚拟实盘调试】本轮时钟、候选与价格全部是确定性合成数据；不会进入正式排行榜，也不得把任何内容当成真实证券事实。',
      '',
    ] : []),
    '这是模拟交易，不连接券商。你负责决定完整目标组合和风险；系统只按真实账户申报单位、现金和费用机械执行。',
    `本轮在 ${snapshot.decisionFor} 盘前锁定，锁定后按该交易日${snapshot.virtualDebug ? '虚拟' : '真实'}开盘价模拟执行，盘中不再调用你修改订单。`,
    '',
    '## 必须读取',
    '',
    `- 核心理念：${files.agent}`,
    `- 当前策略：${files.strategy}`,
    `- 决策检查表：${files.checklist}`,
    `- 当前组合：${files.portfolio}`,
    `- 长期经验：${files.memory}`,
    `- 本轮个性化提示：${files.dailyPrompt}`,
    `- 统一冻结快照：${snapshotPath}`,
    '',
    '## 决策边界',
    '',
    snapshot.virtualDebug
      ? '- 虚拟调试只能选择本快照列出的合成标的或当前已有虚拟持仓；禁止引入快照外真实股票。'
      : '- 投资范围是除北交所外的沪深 A 股全市场。冻结候选池只是高优先级研究入口，不是硬性股票白名单。',
    snapshot.virtualDebug
      ? '- 不调用真实行情补充虚拟数据；所有结论只服务于功能验收。'
      : '- 若研究候选池外股票，必须通过初心只读工具补充可追溯依据；不得凭模型记忆猜行情。',
    '- 系统不设置单票或总仓位硬风控；你必须在自己的 CHECKLIST 和后续 Hook 中为仓位负责。',
    '- 完整股票目标权重与现金目标之和必须接近 100%。',
    '- 不得读取其他 Agent 的文件或答案，不得事后改写历史。',
    '- 周一至周五不得修改核心理念、策略或检查表；周六才进行经验沉淀和规则提案。',
    '- 信息不足时可以保持现金或完全不交易，不得为了节目效果制造订单。',
    '',
    `当前资产：${Number(stats.nav || agent.initialCash).toFixed(2)}；累计收益：${(Number(stats.totalReturn || 0) * 100).toFixed(2)}%；最大回撤：${(Number(stats.maxDrawdown || 0) * 100).toFixed(2)}%。`,
    '',
    '## 输出合同',
    '',
    '先用简短自然语言说明你看到的核心矛盾，再提交完整预案。最后必须且只能出现一个以下代码块；日期与 run_id 必须原样保留：',
    '',
    '```agent-league-draft',
    JSON.stringify(schema, null, 2),
    '```',
    '',
  ].join('\n');
}

function buildHookPrompt(agentRow, snapshot, runId, draft, targetContexts = {}) {
  const { agent, files } = agentRow;
  const schema = {
    run_id: runId,
    decision_date: snapshot.decisionFor,
    data_as_of: snapshot.asOf,
    verdict: 'REVISE',
    rule_checks: [{ rule_id: 'P1', status: 'WARN', comment: '逻辑成立，但当前价格位置不够舒服。' }],
    strongest_counter_evidence: '最可能推翻当前判断的具体证据',
    timing_check: '为什么现在操作，是否追高，等待是否更优',
    portfolio_check: '由你自行判断仓位、现金、集中度和错误后的损失是否合理',
    behavior_check: '是否受到排名、近期盈亏或害怕错过影响',
    account_feasibility: '是否考虑 50 万账户、手续费/印花税和沪深/科创板申报数量',
    changes: ['原计划与最终计划的明确差异'],
    final_decision: draft,
    daily_brief: {
      headline: '一句有辨识度但不夸张的标题',
      body: '300-500 字第一人称决策摘要：核心矛盾、最强反证、最终操作和什么会证明我错了。不得补写 DRAFT 中不存在的新证据。',
      hook_change: 'Hook 是否改变了操作，具体改变什么；没有则明确写无变化及原因。',
      video_hooks: ['一句短视频开场', '一个最有冲突的自我质疑', '最终动作'],
    },
  };
  return [
    '# 初心 Agent 投资联赛 · 决策前 Hook', '',
    `Agent：${agent.name}（同一个普通 AI Hub Session）`,
    `Run ID：${runId}`, `决策交易日：${snapshot.decisionFor}`, `数据截至：${snapshot.asOf}`, '',
    ...(snapshot.virtualDebug ? ['> 【虚拟实盘调试】继续使用同一份确定性合成快照；不得调用或混入真实行情。', ''] : []),
    '你现在不是重新选股，也不是为了让草案通过而找理由。请审查刚才已经冻结的 DRAFT，最多修订一次。',
    '先找最强违规项和反对证据，再决定 PASS / REVISE / HOLD。不得新增 DRAFT 中没有的交易股票。', '',
    '## 必须重新读取', '',
    `- 核心理念：${files.agent}`,
    `- 当前策略：${files.strategy}`,
    `- 决策检查表：${files.checklist}`,
    `- 当前组合：${files.portfolio}`, '',
    `- 本轮个性化 Hook 提示：${files.hookPrompt}`, '',
    '## 已冻结 DRAFT', '', '```json', JSON.stringify(draft, null, 2), '```', '',
    '## 目标股票只读行情核验', '', '```json', JSON.stringify(targetContexts, null, 2), '```', '',
    '## 必须完成的检查', '',
    '1. 每个变动标的逐条引用 CHECKLIST 规则并给 PASS/WARN/FAIL。',
    '2. 给出最强反证、失效条件和“保持现金/等待”这一替代方案。',
    '3. 由你自行判断仓位、现金、行业集中和错误后的损失，不等待系统替你风控。',
    '4. 检查是否因排行榜、近期盈亏或害怕错过而改变纪律。',
    '5. 预检查账户可行性：初始资金 50 万；佣金双边万分之一；卖出印花税千分之一；沪深主板/创业板买入 100 股整数倍；科创板单笔买入至少 200 股。',
    '6. DAILY_BRIEF 是给人看的可审计摘要，不是原始思维链，也不能事后创造新证据。', '',
    '最后必须且只能出现一个以下代码块：', '',
    '```agent-league-hook', JSON.stringify(schema, null, 2), '```', '',
  ].join('\n');
}

function buildWeeklyPrompt(agentRow, saturdayDate, dailyStates, runId) {
  const { agent, files } = agentRow;
  const compactDays = dailyStates.map((row) => ({
    decision_date: row.decisionDate,
    draft: row.draft,
    hook: row.hook,
    final: row.decision,
    daily_brief: row.dailyBrief,
    execution: row.execution,
    result: row.closeResult,
  }));
  const schema = {
    run_id: runId,
    saturday_date: saturdayDate,
    summary: '本周最重要的总体结论',
    process_win: '本周过程正确的决策；不能只因为赚钱',
    process_mistake: '本周过程错误的决策；即使赚钱也必须指出',
    lesson: '一条值得进入 MEMORY.md 的待验证经验',
    strongest_counterexample: '对这条经验最强的反例；没有足够证据时明确说样本不足',
    evidence_for: ['支持证据'],
    evidence_against: ['反对证据'],
    checklist_proposal: null,
  };
  return [
    '# 初心 Agent 投资联赛 · 周六沉淀', '',
    `Agent：${agent.name}`, `Run ID：${runId}`, `周六日期：${saturdayDate}`, '',
    '本轮不产生任何股票订单。请区分“决策过程是否正确”和“最终盈亏”，未达到原定持有周期的交易不得仓促判对错。',
    'MEMORY.md 可以自动增加一条待验证经验；CHECKLIST.md 最多提出一条修改建议，只写入 EVOLUTION.md，不自动生效。AGENT.md 不得修改。', '',
    '## 当前文件', '',
    `- 核心理念：${files.agent}`, `- 当前策略：${files.strategy}`, `- 决策检查表：${files.checklist}`,
    `- 经验：${files.memory}`, `- 进化提案：${files.evolution}`, `- 本轮个性化沉淀提示：${files.weeklyPrompt}`, '',
    '## 本周交易日记录', '', '```json', JSON.stringify(compactDays, null, 2), '```', '',
    '最后必须且只能出现一个以下代码块：', '',
    '```agent-league-weekly', JSON.stringify(schema, null, 2), '```', '',
  ].join('\n');
}

// 保留旧导出名，避免其他调用者在一次升级中断裂。
const buildDailyPrompt = buildDraftPrompt;

function publicDailyState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    runId: value.runId || '',
    decisionDate: value.decisionDate || '',
    dataAsOf: value.dataAsOf || '',
    stage: value.stage || '',
    status: value.status || '',
    error: value.error || '',
    draft: value.draft || null,
    hook: value.hook || null,
    decision: value.decision || null,
    dailyBrief: value.dailyBrief || null,
    execution: value.execution || null,
    closeResult: value.closeResult || null,
  };
}

function publicWeeklyState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    runId: value.runId || '',
    saturdayDate: value.saturdayDate || '',
    tradingDates: value.tradingDates || [],
    status: value.status || '',
    error: value.error || '',
    review: value.review || null,
  };
}

function publicAgent(row, sessionManager, options = {}) {
  const live = row.session && row.session.hubSessionId && sessionManager
    ? sessionManager.getSession(row.session.hubSessionId)
    : null;
  const automationRunning = !!(row.session && row.session.hubSessionId
    && options.pendingSessionIds instanceof Set
    && options.pendingSessionIds.has(row.session.hubSessionId));
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
    strategyPendingConfirmation: row.agent.strategyPendingConfirmation === true,
    decisionCount: row.agent.decisionCount,
    evolutionDays: row.agent.evolutionDays,
    weeklyReviewCount: row.agent.weeklyReviewCount || 0,
    lastDecisionAt: row.agent.lastDecisionAt,
    lastHookVerdict: row.agent.lastHookVerdict || '',
    lastBriefHeadline: row.agent.lastBriefHeadline || '',
    folder: row.folder,
    files: row.files,
    stats: row.stats,
    portfolio: {
      cash: row.portfolio.cash,
      positions: row.portfolio.positions,
      pendingDecision: row.portfolio.pendingDecision ? {
        runId: row.portfolio.pendingDecision.runId,
        decisionDate: row.portfolio.pendingDecision.decisionDate || row.portfolio.pendingDecision.decisionAsOf,
        decisionDataAsOf: row.portfolio.pendingDecision.decisionDataAsOf || row.portfolio.pendingDecision.decisionAsOf,
        hookVerdict: row.portfolio.pendingDecision.hookVerdict || '',
      } : null,
    },
    session: {
      ...row.session,
      live: !!live,
      status: automationRunning
        ? 'running'
        : live ? (live.status || 'idle') : (row.session.status || (row.session.hubSessionId ? 'restorable' : 'unbound')),
      nativeSession: live ? { ...(row.session.nativeSession || {}), ...nativeSessionMeta(live) } : (row.session.nativeSession || {}),
    },
    recentTrades: (row.trades.rows || []).slice(-5).reverse(),
    recentLessons: (row.memory.candidates || []).slice(-5).reverse(),
    recentProposals: (row.evolution.proposals || []).slice(-5).reverse(),
    checklist: row.checklist || { rules: [] },
    latestDaily: publicDailyState(row.latestDaily),
    latestWeekly: publicWeeklyState(row.latestWeekly),
  };
}

function registerAgentLeagueRuntime(ipcMain, deps = {}) {
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
  const channelPrefix = String(deps.channelPrefix || 'agent-league');
  const channel = (name) => `${channelPrefix}:${name}`;
  const scopePrefix = String(deps.scopePrefix || AGENT_SCOPE_PREFIX);
  const sessionPurpose = String(deps.sessionPurpose || 'agent-league');
  const sessionTitlePrefix = String(deps.sessionTitlePrefix || 'Agent ·');
  const environment = String(deps.environment || 'live');
  const enforceMarketClock = deps.enforceMarketClock !== false;
  const autoStartScheduler = deps.autoStartScheduler !== false;
  const defaultDecisionDate = typeof deps.getDecisionDate === 'function' ? deps.getDecisionDate : () => '';
  const decisionSnapshotBuilder = deps.buildDecisionSnapshot || buildFrozenSnapshot;
  const priceSnapshotBuilder = deps.buildPriceSnapshot || buildLivePriceSnapshot;
  const targetContextBuilder = deps.fetchTargetContexts || fetchTargetContexts;
  const emit = (name, payload = {}) => sendToRenderer(channel(name), { environment, ...payload });
  const agentTurnTimeoutMs = Math.max(100, Number(deps.agentTurnTimeoutMs || DEFAULT_AGENT_TURN_TIMEOUT_MS));
  const cliReadyWindowsMs = Array.isArray(deps.cliReadyWindowsMs) && deps.cliReadyWindowsMs.length
    ? deps.cliReadyWindowsMs.map((value) => Math.max(1, Number(value) || 1))
    : [10000, 18000, 32000];
  const pendingByHubSession = new Map();
  const publicRow = (row) => publicAgent(row, sessionManager, { pendingSessionIds: new Set(pendingByHubSession.keys()) });
  let currentRun = null;
  let schedulerTimer = null;
  const initialSchedule = store.getSchedule();
  if (initialSchedule.lastRunStatus === 'running' && !store.currentRunLease()) {
    store.saveSchedule({ ...initialSchedule, lastRunStatus: 'interrupted' });
  }

  // 联赛 Agent 的会话运行时选项。赛程由调度器驱动，终端前没有人：任何一次权限
  // 询问、任何一个会吞掉 turn 文本的加速开关，都会让这一轮只能等硬超时判 failed。
  // 因此自动化旁路必须与 research MCP 分开算 —— hookPort 缺失只该让 Agent 少一套
  // 工具，不该顺带把它退回“需要人工点确认”的模式。
  function agentRuntimeOptions(kind, agentId) {
    const options = {};
    if (kind === 'claude') {
      // Claude 侧的 codexBypassApprovals 等价物：权限旁路 + 关 fast（fast 可能不落
      // transcript jsonl，transcript-tap 就收不到 turn-complete）+ plugin 隔离 +
      // strict MCP。四项由 session-manager 的 autonomous 语义统一落实。
      options.autonomous = true;
      // 明确写死档位，不依赖 Claude 的 MCP 默认值：它已经改过一次（full→none），
      // Agent 的工具面不能跟着默认值漂。
      options.mcpProfile = 'none';
    } else if (kind === 'codex') {
      options.codexBypassApprovals = true;
      // 普通 Codex 默认 mcpProfile=none，会把下方临时 Chuxin 条目一起过滤。
      // Agent 需要只保留任务所需工具，明确使用 Lean，而不是继承全局 Full。
      options.mcpProfile = 'lean';
    }
    const hookPort = Number(getHookPort() || 0);
    if (!hookPort) return options;
    const hubDataDir = getHubDataDir();
    const scopeId = `${scopePrefix}${agentId}`;
    if (kind === 'claude') {
      options.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, scopeId, hookPort, hookToken, kind, { enableChuxin: true });
    } else if (kind === 'codex') {
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
      title: `${sessionTitlePrefix} ${row.agent.name}`,
      model: selection.model,
      userRenamed: true,
      purpose: sessionPurpose,
      hiddenFromSidebar: false,
      ...agentRuntimeOptions(selection.kind, row.agent.id),
      ...(resume || {}),
    };
    const session = sessionManager.createSession(selection.kind, options);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    const updated = store.bindSession(row.agent.id, {
      hubSessionId: session.id,
      status: 'active',
      nativeSession: { ...(row.session.nativeSession || {}), ...nativeSessionMeta(session) },
    });
    emit('session-updated', { agent: publicRow(updated) });
    return session;
  }

  function ensureAgentSession(agentId) {
    const row = store.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const hubId = String(row.session.hubSessionId || '');
    const live = hubId && sessionManager ? sessionManager.getSession(hubId) : null;
    const resume = hubId ? resumeOptions(row) : null;
    if (live) {
      const pickerLikeUnbound = !resume && (
        live.codexAllowMtimeFallback === true
        || /-resume$/.test(String(live.kind || ''))
      );
      if (pickerLikeUnbound) {
        // 该 Agent 从未完成过一次原生 CLI turn，因此没有历史可恢复。
        // 通用 dormant resume 会把它降级成 Codex picker，后续自动 Prompt
        // 只会落进选择器。原地保留 Hub ID，杀掉 picker 并启动 fresh CLI。
        sessionManager.closeSession(hubId);
        return createNativeSession(row, null);
      }
      const updated = store.bindSession(agentId, { status: live.status || 'active', nativeSession: nativeSessionMeta(live) });
      emit('session-updated', { agent: publicRow(updated) });
      return live;
    }
    if (hubId && !resume) {
      // Hub shell 已持久化但从未拿到 provider-native ID：这不是“历史丢失”，
      // 而是从未产生过历史。复用同一 Hub ID fresh start，绝不进入通用 picker。
      return createNativeSession(row, null);
    }
    return createNativeSession(row, resume);
  }

  async function waitForAgentCliReady(sessionId, row, stage) {
    const kind = row && row.agent && row.agent.kind;
    const codexRuntime = kind === 'codex' || kind === 'deepseek';
    // Claude 冷启动同样可能超过单个 60s 窗口：--mcp-config 要先把 research MCP
    // 子进程拉起来，Opus 1M 档在忙碌的机器上启动本身就要几十秒。窗口只是轮询上限，
    // 就绪即返回，多给一段不增加正常路径的耗时。Enter 兜底仍只对 Codex 生效——
    // 它修的是 PowerShell 吞掉启动命令换行这个 Codex 专有现象。
    const windows = codexRuntime ? cliReadyWindowsMs : [...cliReadyWindowsMs, 60000];
    for (let index = 0; index < windows.length; index += 1) {
      if (await waitReady(sessionId, kind, windows[index])) return true;
      if (!codexRuntime || index >= windows.length - 1 || !sessionManager
          || typeof sessionManager.writeToSession !== 'function') continue;
      const live = typeof sessionManager.getSession === 'function' ? sessionManager.getSession(sessionId) : null;
      // Once a native SID exists, Codex itself has launched; an Enter at that
      // point could only interfere with a busy TUI. Recovery is exclusively for
      // the observed host-shell state where Hub wrote the long launch command
      // but PowerShell's paste handling swallowed its trailing newline.
      if (live && live.codexSid) continue;
      const signal = index === 0 ? '\r' : '\n';
      console.warn(`[agent-league] ${stage} CLI launch not ready after ${windows.slice(0, index + 1).reduce((sum, value) => sum + value, 0)}ms; sending isolated ${signal === '\r' ? 'CR' : 'LF'} recovery for ${String(sessionId).slice(0, 8)}`);
      sessionManager.writeToSession(sessionId, signal);
    }
    return false;
  }

  function promptWasSubmitted(result) {
    return !!result && result.ok !== false && result.sendStatus !== 'stuck';
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
      environment,
      mode: currentRun.mode || 'daily',
      decisionDate: currentRun.decisionDate || currentRun.asOf,
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
    emit('run-updated', { run: runPublicState() });
  }

  function clearPending(sessionId) {
    const pending = pendingByHubSession.get(sessionId);
    if (pending && pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    pendingByHubSession.delete(sessionId);
    return pending || null;
  }

  function armPendingTimeout(sessionId, pending) {
    if (!pending || pendingByHubSession.get(sessionId) !== pending) return;
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    pending.timeoutTimer = setTimeout(() => {
      if (pendingByHubSession.get(sessionId) !== pending) return;
      // Parsing and read-only market verification can briefly outlive the
      // provider turn. Do not race a watchdog against that critical section.
      if (pending.processing) {
        armPendingTimeout(sessionId, pending);
        return;
      }
      const stage = pending.stage === 'hook'
        ? '决策 Hook'
        : pending.stage === 'weekly' ? '周六沉淀' : '盘前 DRAFT';
      markFailed(pending.agentId, new Error(`${stage} 在 ${Math.max(1, Math.ceil(agentTurnTimeoutMs / 60000))} 分钟内未完成；Session 已保留，可从 PTY 检查后重跑。`));
      clearPending(sessionId);
      pumpQueue();
      finishRunIfDone();
    }, agentTurnTimeoutMs);
    pending.timeoutTimer.unref?.();
  }

  function setPending(sessionId, pending) {
    clearPending(sessionId);
    pendingByHubSession.set(sessionId, pending);
    armPendingTimeout(sessionId, pending);
  }

  function finishRunIfDone() {
    if (!currentRun || currentRun.queue.length || currentRun.active.size) return false;
    const status = currentRun.failed.length ? (currentRun.completed.length ? 'partial' : 'failed') : 'completed';
    const schedule = store.getSchedule();
    store.saveSchedule(currentRun.mode === 'weekly' ? {
      ...schedule,
      lastWeeklyDate: currentRun.decisionDate,
      lastWeeklyRunId: currentRun.runId,
      lastWeeklyStatus: status,
    } : {
      ...schedule,
      lastSnapshotAsOf: currentRun.asOf,
      lastDecisionDate: currentRun.decisionDate,
      lastRunId: currentRun.runId,
      lastRunStatus: status,
    });
    const finished = { ...runPublicState(), status, finishedAt: new Date().toISOString() };
    if (currentRun.leaseTimer) clearInterval(currentRun.leaseTimer);
    store.releaseRunLease(currentRun.leaseToken);
    currentRun = null;
    emit('run-finished', { run: finished });
    return true;
  }

  function markFailed(agentId, error) {
    if (!currentRun) return;
    if (currentRun.completed.includes(agentId)
        || currentRun.failed.some((row) => row.agentId === agentId)) return;
    currentRun.active.delete(agentId);
    currentRun.failed.push({ agentId, error: String(error && error.message || error) });
    try {
      const pending = [...pendingByHubSession.values()].find((value) => value.agentId === agentId && value.runId === currentRun.runId);
      if (currentRun.mode === 'weekly') {
        store.recordWeeklyFailure(agentId, {
          runId: currentRun.runId,
          saturdayDate: currentRun.decisionDate,
          error: String(error && error.message || error),
        });
      } else {
        store.recordRunFailure(agentId, {
          runId: currentRun.runId,
          decisionDate: currentRun.decisionDate,
          dataAsOf: currentRun.asOf,
          stage: pending && pending.stage || 'draft',
          error: String(error && error.message || error),
        });
      }
    } catch (persistError) {
      console.warn('[agent-league] failed to persist run failure:', persistError && persistError.message);
    }
    emit('agent-failed', { runId: currentRun.runId, agentId, message: String(error && error.message || error) });
    emitRunUpdate();
  }

  async function startDailyAgentTurn(agentId) {
    if (!currentRun) return;
    const row = store.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const session = ensureAgentSession(agentId);
    const prompt = buildDraftPrompt(row, currentRun.snapshot, currentRun.runId);
    const promptHash = sha256(prompt);
    store.recordRunStart(agentId, {
      runId: currentRun.runId,
      decisionDate: currentRun.decisionDate,
      dataAsOf: currentRun.asOf,
      promptHash,
      snapshotPath: store.snapshotPath(currentRun.snapshot),
    });
    const pending = {
      kind: 'daily',
      stage: 'draft',
      runId: currentRun.runId,
      agentId,
      decisionDate: currentRun.decisionDate,
      dataAsOf: currentRun.asOf,
      snapshot: currentRun.snapshot,
      promptHash,
      startedAt: Date.now(),
      processing: false,
    };
    setPending(session.id, pending);
    const ready = await waitForAgentCliReady(session.id, row, '盘前 DRAFT');
    if (!ready) throw new Error(`${row.agent.provider} CLI 在 60 秒内未就绪`);
    const sent = await sendPrompt(session.id, prompt, row.agent.kind);
    if (!promptWasSubmitted(sent)) throw new Error('每日 Prompt 写入 PTY 后未得到 provider turn 启动确认');
    store.bindSession(agentId, { status: 'running', nativeSession: nativeSessionMeta(session) });
    emit('agent-started', { runId: currentRun.runId, agentId, sessionId: session.id });
  }

  async function startWeeklyAgentTurn(agentId) {
    if (!currentRun) return;
    const row = store.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const session = ensureAgentSession(agentId);
    const dailyStates = currentRun.dailyStatesByAgent.get(agentId) || [];
    const prompt = buildWeeklyPrompt(row, currentRun.decisionDate, dailyStates, currentRun.runId);
    const promptHash = sha256(prompt);
    store.recordWeeklyStart(agentId, {
      runId: currentRun.runId,
      saturdayDate: currentRun.decisionDate,
      tradingDates: dailyStates.map((day) => day.decisionDate),
      promptHash,
    });
    const pending = {
      kind: 'weekly',
      stage: 'weekly',
      runId: currentRun.runId,
      agentId,
      saturdayDate: currentRun.decisionDate,
      promptHash,
      startedAt: Date.now(),
      processing: false,
    };
    setPending(session.id, pending);
    const ready = await waitForAgentCliReady(session.id, row, '周度沉淀');
    if (!ready) throw new Error(`${row.agent.provider} CLI 在 60 秒内未就绪`);
    const sent = await sendPrompt(session.id, prompt, row.agent.kind);
    if (!promptWasSubmitted(sent)) throw new Error('周六沉淀 Prompt 写入 PTY 后未得到 provider turn 启动确认');
    store.bindSession(agentId, { status: 'running', nativeSession: nativeSessionMeta(session) });
    emit('agent-started', { runId: currentRun.runId, agentId, sessionId: session.id, mode: 'weekly' });
  }

  async function startAgentTurn(agentId) {
    return currentRun && currentRun.mode === 'weekly'
      ? startWeeklyAgentTurn(agentId)
      : startDailyAgentTurn(agentId);
  }

  function pumpQueue() {
    if (!currentRun) return;
    const maxConcurrency = Math.max(1, Math.min(8, Number(store.getSchedule().maxConcurrency || 2)));
    while (currentRun.active.size < maxConcurrency && currentRun.queue.length) {
      const agentId = currentRun.queue.shift();
      currentRun.active.add(agentId);
      startAgentTurn(agentId).catch((error) => {
        markFailed(agentId, error);
        for (const [sessionId, pending] of pendingByHubSession.entries()) {
          if (pending.agentId === agentId) clearPending(sessionId);
        }
        pumpQueue();
        finishRunIfDone();
      });
    }
    emitRunUpdate();
    finishRunIfDone();
  }

  async function runDay(input = {}) {
    if (currentRun) return { ok: false, error: 'run-busy', message: '上一轮联赛仍在运行', run: runPublicState() };
    let rows = store.listAgents();
    if (!rows.length) return { ok: false, error: 'no-agents', message: '请先创建至少一个 Agent' };
    const clock = chinaClock(input.now || new Date());
    const explicitDecisionDate = !!input.decisionDate;
    let decisionDate = String(input.decisionDate || defaultDecisionDate() || clock.date).slice(0, 10);
    let trading = tradingDayStatus(decisionDate);
    let scheduledFrom = '';
    // 手动“盘前决策”表达的是为下一次开市准备，不是“今天必须开市”。
    // 周末/休市日，或当日盘前截止后点击时，自动落到官方日历中的
    // 下一交易日；显式传入的非交易日仍拒绝，避免调用方日期写错后
    // 被静默改写。
    if (enforceMarketClock && !input.force && !trading.isTradingDay && !explicitDecisionDate && String(input.trigger || 'manual') === 'manual') {
      const next = nextTradingDay(decisionDate);
      if (next) {
        scheduledFrom = decisionDate;
        decisionDate = next;
        trading = tradingDayStatus(decisionDate);
      }
    }
    if (enforceMarketClock && !input.force && trading.isTradingDay && !explicitDecisionDate
        && String(input.trigger || 'manual') === 'manual'
        && decisionDate === clock.date
        && clock.minutes >= parseClock(store.getSchedule().decisionCutoff, '09:15')) {
      const next = nextTradingDay(decisionDate);
      if (next) {
        scheduledFrom = decisionDate;
        decisionDate = next;
        trading = tradingDayStatus(decisionDate);
      }
    }
    if (enforceMarketClock && !input.force && !trading.isTradingDay) {
      return { ok: false, error: 'not-trading-day', message: `今天不运行交易决策：${trading.reason}`, calendar: trading };
    }
    const stalePendingDates = [...new Set(rows
      .map((row) => row.portfolio.pendingDecision && String(row.portfolio.pendingDecision.decisionDate || row.portfolio.pendingDecision.decisionAsOf || ''))
      .filter((date) => date && date < decisionDate))].sort();
    for (const staleDate of stalePendingDates) {
      const recovery = await executeOpen({
        trigger: 'recovery-before-decision',
        decisionDate: staleDate,
        force: true,
        apiBase: input.apiBase || API_BASE,
      });
      if (!recovery.ok) {
        return { ok: false, error: 'pending-recovery-failed', message: `旧决策 ${staleDate} 尚未执行：${recovery.message || recovery.error}`, recovery };
      }
    }
    if (stalePendingDates.length) rows = store.listAgents();
    const snapshot = await decisionSnapshotBuilder({
      apiBase: input.apiBase || API_BASE,
      workspace: WORKSPACE,
      httpJson: request,
      store,
      requiredSymbols: requiredSymbols(),
      decisionFor: decisionDate,
    });
    const schedule = store.getSchedule();
    // 只跑指定 Agent（单个 Agent 的补跑）。必须显式存在，否则宁可报错也不要
    // 静默退化成"跑全部"——调用方 id 写错时那是最糟的失败方式。
    const requestedIds = Array.isArray(input.agentIds)
      ? [...new Set(input.agentIds.map((value) => String(value || '')).filter(Boolean))]
      : [];
    if (requestedIds.length) {
      const known = new Set(rows.map((row) => row.agent.id));
      const unknown = requestedIds.filter((id) => !known.has(id));
      if (unknown.length) {
        return { ok: false, error: 'agent-missing', message: `Agent 不存在：${unknown.join(', ')}` };
      }
      rows = rows.filter((row) => requestedIds.includes(row.agent.id));
    }
    // 当日已经产出决策（decision-queued）的 Agent 不重复跑。这一条同时就是补跑的
    // 判据：中途新建的 Agent 当天没有记录，所以它 runnable，而已决策的不会被重来。
    const runnableRows = rows.filter((row) => {
      const daily = store.getDaily(row.agent.id, decisionDate);
      return !daily || daily.status !== 'decision-queued';
    });
    // 赛程级的"今天已经跑过"只在确实没人可跑时才短路。以前它排在 runnableRows
    // 之前无条件返回，于是当天开跑之后再加入的 Agent 永远补不上当日决策，
    // 只能等第二天——联赛里这等于凭空少一个参赛者。
    if (!runnableRows.length) {
      if (!input.force && schedule.lastDecisionDate === decisionDate && ['completed', 'running'].includes(schedule.lastRunStatus)) {
        return { ok: true, alreadyRun: true, snapshot, schedule, decisionDate, scheduledFrom };
      }
      store.saveSchedule({ ...schedule, lastSnapshotAsOf: snapshot.asOf, lastDecisionDate: decisionDate, lastRunStatus: 'completed' });
      return { ok: true, alreadyRun: true, snapshot, schedule: store.getSchedule(), decisionDate, scheduledFrom };
    }
    const runId = `league-${environment === 'virtual' ? 'virtual-' : ''}${decisionDate.replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
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
      currentRun = {
        mode: 'daily',
        runId,
        decisionDate,
        asOf: snapshot.asOf,
        trigger: String(input.trigger || 'manual'),
        startedAt: new Date().toISOString(),
        snapshot,
        settlement: [],
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
    store.saveSchedule({
      ...schedule,
      lastSnapshotAsOf: snapshot.asOf,
      lastDecisionDate: decisionDate,
      lastRunId: runId,
      lastRunStatus: 'running',
    });
    pumpQueue();
    return { ok: true, run: runPublicState(), snapshot, decisionDate, scheduledFrom };
  }

  async function executeOpen(input = {}) {
    if (currentRun) return { ok: false, error: 'run-busy', message: 'Agent 决策/沉淀仍在运行' };
    const clock = chinaClock(input.now || new Date());
    const decisionDate = String(input.decisionDate || defaultDecisionDate() || clock.date).slice(0, 10);
    const trading = tradingDayStatus(decisionDate);
    if (enforceMarketClock && !input.force && !trading.isTradingDay) return { ok: false, error: 'not-trading-day', message: `今天不执行开盘订单：${trading.reason}` };
    if (enforceMarketClock && !input.force && decisionDate === clock.date && clock.minutes < parseClock(store.getSchedule().executionTime, '09:35')) {
      return { ok: false, error: 'before-execution-time', message: `开盘执行时间尚未到：${store.getSchedule().executionTime || '09:35'}` };
    }
    const rows = store.listAgents().filter((row) => row.portfolio.pendingDecision
      && String(row.portfolio.pendingDecision.decisionDate || row.portfolio.pendingDecision.decisionAsOf) === decisionDate);
    if (!rows.length) return { ok: true, alreadyRun: true, decisionDate, results: [], message: '没有待执行决策' };
    const symbols = new Set();
    for (const row of rows) {
      for (const position of row.portfolio.positions || []) symbols.add(position.symbol);
      for (const target of row.portfolio.pendingDecision.decision.targets || []) symbols.add(target.symbol);
    }
    const snapshot = await priceSnapshotBuilder({
      apiBase: input.apiBase || API_BASE,
      workspace: WORKSPACE,
      httpJson: request,
      store,
      decisionFor: decisionDate,
      phase: 'open',
      symbols,
    });
    const results = [];
    const errors = [];
    for (const row of rows) {
      try {
        const result = store.settleAgent(row.agent.id, snapshot, { executionPriceField: 'open' });
        results.push({
          agentId: row.agent.id,
          settled: result.settled,
          trades: result.trades,
          orderNotes: result.orderNotes,
          nav: result.nav,
        });
      } catch (error) {
        errors.push({ agentId: row.agent.id, error: error.message });
      }
    }
    const schedule = store.getSchedule();
    store.saveSchedule({
      ...schedule,
      lastExecutionDate: decisionDate,
      lastExecutionStatus: errors.length ? (results.length ? 'partial' : 'failed') : 'completed',
    });
    emit('execution-completed', { decisionDate, results, errors });
    return { ok: !errors.length, decisionDate, snapshotId: snapshot.snapshotId, results, errors };
  }

  async function recordClose(input = {}) {
    if (currentRun) return { ok: false, error: 'run-busy', message: 'Agent 决策/沉淀仍在运行' };
    const clock = chinaClock(input.now || new Date());
    const decisionDate = String(input.decisionDate || defaultDecisionDate() || clock.date).slice(0, 10);
    const trading = tradingDayStatus(decisionDate);
    if (enforceMarketClock && !input.force && !trading.isTradingDay) return { ok: false, error: 'not-trading-day', message: `今天不记录收盘结果：${trading.reason}` };
    if (enforceMarketClock && !input.force && decisionDate === clock.date && clock.minutes < parseClock(store.getSchedule().resultTime, '15:10')) {
      return { ok: false, error: 'before-result-time', message: `收盘记账时间尚未到：${store.getSchedule().resultTime || '15:10'}` };
    }
    const rows = store.listAgents();
    const symbols = new Set(rows.flatMap((row) => (row.portfolio.positions || []).map((position) => position.symbol)));
    const snapshot = await priceSnapshotBuilder({
      apiBase: input.apiBase || API_BASE,
      workspace: WORKSPACE,
      httpJson: request,
      store,
      decisionFor: decisionDate,
      phase: 'close',
      symbols,
    });
    const results = [];
    const errors = [];
    for (const row of rows) {
      try {
        const result = store.markAgent(row.agent.id, snapshot, decisionDate);
        results.push({ agentId: row.agent.id, nav: result.nav, dailyReturn: result.dailyReturn });
      } catch (error) {
        errors.push({ agentId: row.agent.id, error: error.message });
      }
    }
    const schedule = store.getSchedule();
    store.saveSchedule({
      ...schedule,
      lastResultDate: decisionDate,
      lastResultStatus: errors.length ? (results.length ? 'partial' : 'failed') : 'completed',
    });
    emit('close-completed', { decisionDate, results, errors });
    return { ok: !errors.length, decisionDate, snapshotId: snapshot.snapshotId, results, errors };
  }

  async function runWeekly(input = {}) {
    if (currentRun) return { ok: false, error: 'run-busy', message: '上一轮联赛仍在运行', run: runPublicState() };
    const saturdayDate = String(input.saturdayDate || defaultDecisionDate() || chinaClock(input.now || new Date()).date).slice(0, 10);
    const clock = chinaClock(new Date(`${saturdayDate}T04:00:00.000Z`));
    if (enforceMarketClock && !input.force && clock.weekday !== 'Sat') {
      return { ok: false, error: 'not-saturday', message: '周度沉淀只在周六自动运行' };
    }
    const after = new Date(`${saturdayDate}T00:00:00.000Z`);
    after.setUTCDate(after.getUTCDate() - 7);
    const afterDate = after.toISOString().slice(0, 10);
    const dailyStatesByAgent = new Map();
    const runnable = [];
    for (const row of store.listAgents()) {
      const days = store.listDaily(row.agent.id, { after: afterDate, before: saturdayDate, limit: 7 })
        .filter((day) => day.status === 'decision-queued');
      dailyStatesByAgent.set(row.agent.id, days);
      const weekly = store.getWeekly(row.agent.id, saturdayDate);
      if (days.length && (!weekly || weekly.status !== 'completed')) runnable.push(row);
    }
    if (!runnable.length) return { ok: true, alreadyRun: true, saturdayDate, message: '本周没有需要沉淀的新交易日记录' };
    const runId = `weekly-${saturdayDate.replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
    const claim = store.claimRunLease({ ownerHub: String(process.env.CLAUDE_HUB_DATA_DIR || 'default'), runId });
    if (!claim.ok) return { ok: false, error: 'run-busy-elsewhere', message: '同一联赛正在另一 Hub 中运行', lease: claim.lease };
    const leaseTimer = setInterval(() => {
      if (!store.renewRunLease(claim.token)) console.warn('[agent-league] weekly lease renewal failed');
    }, 30000);
    leaseTimer.unref?.();
    currentRun = {
      mode: 'weekly',
      runId,
      decisionDate: saturdayDate,
      asOf: saturdayDate,
      trigger: String(input.trigger || 'manual'),
      startedAt: new Date().toISOString(),
      settlement: [],
      queue: runnable.map((row) => row.agent.id),
      active: new Set(),
      completed: [],
      failed: [],
      dailyStatesByAgent,
      leaseToken: claim.token,
      leaseTimer,
    };
    const schedule = store.getSchedule();
    store.saveSchedule({ ...schedule, lastWeeklyDate: saturdayDate, lastWeeklyRunId: runId, lastWeeklyStatus: 'running' });
    pumpQueue();
    return { ok: true, run: runPublicState() };
  }

  async function schedulerTick(now = new Date()) {
    const schedule = store.getSchedule();
    if (!schedule.enabled || currentRun) return { ok: true, skipped: 'disabled-or-running' };
    const clock = chinaClock(now);
    if (clock.weekday === 'Sat') {
      if (clock.minutes < parseClock(schedule.weeklyTime, '10:00')) return { ok: true, skipped: 'before-weekly-time' };
      if (schedule.lastWeeklyDate === clock.date && schedule.lastWeeklyStatus === 'completed') return { ok: true, skipped: 'weekly-already-completed' };
      try { return await runWeekly({ trigger: 'scheduler', saturdayDate: clock.date }); }
      catch (error) { return { ok: false, error: 'scheduler-weekly-failed', message: error.message }; }
    }
    const trading = tradingDayStatus(clock.date);
    if (!trading.isTradingDay) return { ok: true, skipped: trading.reason, calendar: trading };
    const decisionTime = parseClock(schedule.decisionTime || schedule.runTime, '08:30');
    const cutoff = parseClock(schedule.decisionCutoff, '09:15');
    const executionTime = parseClock(schedule.executionTime, '09:35');
    const resultTime = parseClock(schedule.resultTime, '15:10');
    try {
      if (clock.minutes >= decisionTime && clock.minutes < cutoff && schedule.lastDecisionDate !== clock.date) {
        return await runDay({ trigger: 'scheduler', decisionDate: clock.date });
      }
      if (clock.minutes >= executionTime && clock.minutes < resultTime && schedule.lastExecutionDate !== clock.date) {
        return await executeOpen({ trigger: 'scheduler', decisionDate: clock.date });
      }
      if (clock.minutes >= resultTime && schedule.lastResultDate !== clock.date) {
        return await recordClose({ trigger: 'scheduler', decisionDate: clock.date });
      }
      if (clock.minutes >= cutoff && schedule.lastDecisionDate !== clock.date) {
        return { ok: true, skipped: 'missed-decision-window' };
      }
      return { ok: true, skipped: 'no-phase-due' };
    } catch (error) {
      return { ok: false, error: 'scheduler-phase-failed', message: error.message };
    }
  }

  function startScheduler() {
    if (!autoStartScheduler) return null;
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
    if (!value.startsWith(scopePrefix)) return false;
    const agentId = value.slice(scopePrefix.length);
    const row = store.getAgent(agentId);
    if (!row || !row.session.hubSessionId || !sessionManager) return false;
    return !!sessionManager.getSession(row.session.hubSessionId);
  }

  function listPublic(sort = 'return') {
    return store.listAgents(sort).map((row) => publicRow(row));
  }

  function promptWorkbench(agentId) {
    const row = store.getAgent(agentId);
    if (!row) throw new Error(`Agent 不存在：${agentId}`);
    const snapshot = {
      schemaVersion: 2,
      phase: 'decision',
      snapshotId: 'preview-snapshot',
      decisionFor: '<交易日>',
      asOf: '<数据截至日>',
      candidates: [],
      prices: {},
    };
    const sampleDecision = {
      action_summary: '示例：保持现金或调整目标组合',
      market_view: '示例市场判断',
      core_conflict: '示例核心矛盾',
      cash_target: 1,
      targets: [],
      watchlist: [],
      risk_notes: [],
      memory_note: '示例既有经验引用',
    };
    return {
      files: store.listPromptFiles(agentId),
      contracts: [
        {
          key: 'contractDaily', group: 'contract', title: '系统合同 · 盘前 DRAFT',
          description: '系统实际发送的完整第一轮 Prompt 预览；结构合同只读。', editable: false,
          content: buildDraftPrompt(row, snapshot, 'preview-run-id'),
        },
        {
          key: 'contractHook', group: 'contract', title: '系统合同 · 决策 Hook',
          description: '系统实际发送的完整第二轮 Prompt 预览；包含所有检查项和输出合同。', editable: false,
          content: buildHookPrompt(row, snapshot, 'preview-run-id', sampleDecision, {}),
        },
        {
          key: 'contractWeekly', group: 'contract', title: '系统合同 · 周六沉淀',
          description: '系统实际发送的周度 Prompt 预览；结构合同只读。', editable: false,
          content: buildWeeklyPrompt(row, '<周六日期>', [], 'preview-weekly-id'),
        },
      ],
      loadOrder: [
        'AGENT.md：核心投资人格',
        'STRATEGY.md：当前执行方法',
        'CHECKLIST.md：每笔交易的 Hook 规则',
        'MEMORY.md / EVOLUTION.md：长期经验与待批准提案',
        'PROMPT_DAILY / HOOK / WEEKLY：每个 Agent 的个性化补充',
        '系统运行合同：时间、数据、账户与结构化输出边界',
      ],
    };
  }

  ipcMain.handle(channel('catalog'), () => ({
    ok: true,
    providers: providerCatalog(),
    philosophies: PHILOSOPHY_TEMPLATES.map((row) => ({ ...row })),
    account: {
      initialCash: 500000,
      commissionRate: 0.0001,
      sellTaxRate: 0.001,
      minimumCommission: 0,
      universe: '沪深 A 股全市场（不含北交所）',
      execution: '盘前锁定，按当日开盘价模拟执行，P0 无盘中交易',
    },
    calendar: { ...EXCHANGE_CALENDAR, closedDates: [...EXCHANGE_CALENDAR.closedDates] },
  }));
  ipcMain.handle(channel('list'), (_event, input = {}) => ({
    ok: true,
    environment,
    agents: listPublic(input.sort === 'asset' ? 'asset' : 'return'),
    schedule: store.getSchedule(),
    run: runPublicState(),
    root: store.root,
  }));
  ipcMain.handle(channel('prompt-files'), (_event, input = {}) => {
    try { return { ok: true, ...promptWorkbench(String(input.agentId || '')) }; }
    catch (error) { return { ok: false, error: 'prompt-files-failed', message: error.message }; }
  });
  ipcMain.handle(channel('save-prompt-file'), (_event, input = {}) => {
    try {
      const file = store.savePromptFile(
        String(input.agentId || ''),
        String(input.key || ''),
        String(input.content == null ? '' : input.content),
        String(input.expectedSha256 || ''),
        { actor: 'AI Hub Agent League UI' },
      );
      return { ok: true, file, workbench: promptWorkbench(String(input.agentId || '')) };
    } catch (error) {
      return { ok: false, error: error.code || 'save-prompt-file-failed', message: error.message };
    }
  });
  ipcMain.handle(channel('create'), (_event, input = {}) => {
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
        initialCash: Number(input.initialCash || 500000),
      });
      const session = createNativeSession(row);
      return { ok: true, agent: publicRow(store.getAgent(id)), session };
    } catch (error) {
      return { ok: false, error: 'create-agent-failed', message: error.message };
    }
  });
  ipcMain.handle(channel('ensure-session'), (_event, input = {}) => {
    try {
      const session = ensureAgentSession(String(input.agentId || ''));
      return { ok: true, session, agent: publicRow(store.getAgent(String(input.agentId || ''))) };
    } catch (error) {
      return { ok: false, error: 'ensure-session-failed', message: error.message };
    }
  });
  ipcMain.handle(channel('run-day'), async (_event, input = {}) => {
    try { return await runDay({ ...input, trigger: input.trigger || 'manual' }); }
    catch (error) { return { ok: false, error: 'run-day-failed', message: error.message }; }
  });
  ipcMain.handle(channel('execute-open'), async (_event, input = {}) => {
    try { return await executeOpen({ ...input, trigger: input.trigger || 'manual' }); }
    catch (error) { return { ok: false, error: 'execute-open-failed', message: error.message }; }
  });
  ipcMain.handle(channel('record-close'), async (_event, input = {}) => {
    try { return await recordClose({ ...input, trigger: input.trigger || 'manual' }); }
    catch (error) { return { ok: false, error: 'record-close-failed', message: error.message }; }
  });
  ipcMain.handle(channel('run-weekly'), async (_event, input = {}) => {
    try { return await runWeekly({ ...input, trigger: input.trigger || 'manual' }); }
    catch (error) { return { ok: false, error: 'run-weekly-failed', message: error.message }; }
  });
  ipcMain.handle(channel('update-schedule'), (_event, input = {}) => {
    const previous = store.getSchedule();
    const next = store.saveSchedule({
      ...previous,
      enabled: input.enabled === true,
      decisionTime: /^\d{2}:\d{2}$/.test(String(input.decisionTime || '')) ? input.decisionTime : (previous.decisionTime || '08:30'),
      decisionCutoff: /^\d{2}:\d{2}$/.test(String(input.decisionCutoff || '')) ? input.decisionCutoff : (previous.decisionCutoff || '09:15'),
      executionTime: /^\d{2}:\d{2}$/.test(String(input.executionTime || '')) ? input.executionTime : (previous.executionTime || '09:35'),
      resultTime: /^\d{2}:\d{2}$/.test(String(input.resultTime || '')) ? input.resultTime : (previous.resultTime || '15:10'),
      weeklyTime: /^\d{2}:\d{2}$/.test(String(input.weeklyTime || '')) ? input.weeklyTime : (previous.weeklyTime || '10:00'),
      runTime: /^\d{2}:\d{2}$/.test(String(input.decisionTime || '')) ? input.decisionTime : (previous.decisionTime || previous.runTime || '08:30'),
      maxConcurrency: Math.max(1, Math.min(8, Number(input.maxConcurrency || previous.maxConcurrency || 2))),
    });
    return { ok: true, schedule: next };
  });

  function finishAgentTurn(pending, updated, event = {}) {
    store.bindSession(pending.agentId, {
      status: 'idle',
      nativeSession: nativeSessionMeta(sessionManager && sessionManager.getSession(event.hubSessionId)),
    });
    if (currentRun && currentRun.runId === pending.runId) {
      currentRun.active.delete(pending.agentId);
      if (!currentRun.completed.includes(pending.agentId)) currentRun.completed.push(pending.agentId);
    }
    emit('agent-completed', {
      runId: pending.runId,
      mode: pending.kind,
      agentId: pending.agentId,
      agent: publicRow(updated),
    });
    emitRunUpdate();
    pumpQueue();
    finishRunIfDone();
  }

  async function handleAgentTurnComplete(event, pending) {
    if (!pending || pending.processing) return;
    pending.processing = true;
    try {
      const row = store.getAgent(pending.agentId);
      if (!row) throw new Error(`Agent 不存在：${pending.agentId}`);
      if (pending.kind === 'weekly') {
        const raw = parseWeeklyMarkdown(event.text || '');
        if (String(raw.run_id || '') !== pending.runId) throw new Error(`run_id 不匹配：${raw.run_id || '(empty)'}`);
        if (String(raw.saturday_date || '') !== pending.saturdayDate) throw new Error(`saturday_date 不匹配：${raw.saturday_date || '(empty)'}`);
        const review = validateWeeklyReview(raw);
        const updated = store.recordWeeklyReview(pending.agentId, {
          runId: pending.runId,
          saturdayDate: pending.saturdayDate,
          review,
          markdown: String(event.text || ''),
        });
        clearPending(event.hubSessionId);
        finishAgentTurn(pending, updated, event);
        return;
      }

      if (pending.stage === 'draft') {
        const raw = parseDraftMarkdown(event.text || '');
        if (String(raw.run_id || '') !== pending.runId) throw new Error(`run_id 不匹配：${raw.run_id || '(empty)'}`);
        if (String(raw.decision_date || '') !== pending.decisionDate) throw new Error(`decision_date 不匹配：${raw.decision_date || '(empty)'}`);
        if (String(raw.data_as_of || '') !== pending.dataAsOf) throw new Error(`data_as_of 不匹配：${raw.data_as_of || '(empty)'}`);
        const existingSymbols = new Set((row.portfolio.positions || []).map((item) => item.symbol));
        const allowedSymbols = pending.snapshot && pending.snapshot.virtualDebug
          ? new Set((pending.snapshot.candidates || []).map((item) => item.symbol))
          : null;
        const draft = validateDecision(raw, { existingSymbols, ...(allowedSymbols ? { allowedSymbols } : {}) });
        const targetContexts = await targetContextBuilder({
          apiBase: API_BASE,
          workspace: WORKSPACE,
          httpJson: request,
          symbols: [...draft.targets.map((target) => target.symbol), ...existingSymbols],
          targetDate: pending.dataAsOf,
          snapshot: pending.snapshot,
        });
        const hookPrompt = buildHookPrompt(row, pending.snapshot, pending.runId, draft, targetContexts);
        const hookPromptHash = sha256(hookPrompt);
        store.recordDraft(pending.agentId, {
          runId: pending.runId,
          decisionDate: pending.decisionDate,
          dataAsOf: pending.dataAsOf,
          draft,
          targetContexts,
          markdown: String(event.text || ''),
          hookPromptHash,
        });
        pending.stage = 'hook';
        pending.draft = draft;
        pending.targetContexts = targetContexts;
        pending.hookPromptHash = hookPromptHash;
        const ready = await waitForAgentCliReady(event.hubSessionId, row, '决策 Hook');
        if (!ready) throw new Error(`${row.agent.provider} CLI 在 Hook 前 60 秒内未就绪`);
        const sent = await sendPrompt(event.hubSessionId, hookPrompt, row.agent.kind);
        if (!promptWasSubmitted(sent)) throw new Error('Hook Prompt 写入 PTY 后未得到 provider turn 启动确认');
        armPendingTimeout(event.hubSessionId, pending);
        emit('hook-started', { runId: pending.runId, agentId: pending.agentId, sessionId: event.hubSessionId });
        return;
      }

      if (pending.stage !== 'hook') throw new Error(`未知 Agent 赛程阶段：${pending.stage}`);
      const raw = parseHookMarkdown(event.text || '');
      if (String(raw.run_id || '') !== pending.runId) throw new Error(`run_id 不匹配：${raw.run_id || '(empty)'}`);
      if (String(raw.decision_date || '') !== pending.decisionDate) throw new Error(`decision_date 不匹配：${raw.decision_date || '(empty)'}`);
      if (String(raw.data_as_of || '') !== pending.dataAsOf) throw new Error(`data_as_of 不匹配：${raw.data_as_of || '(empty)'}`);
      const existingSymbols = new Set((row.portfolio.positions || []).map((item) => item.symbol));
      const allowedSymbols = pending.snapshot && pending.snapshot.virtualDebug
        ? new Set((pending.snapshot.candidates || []).map((item) => item.symbol))
        : null;
      const hook = validateHookReview(raw, { draft: pending.draft, existingSymbols, ...(allowedSymbols ? { allowedSymbols } : {}) });
      const missingContext = hook.final_decision.targets.filter((target) => {
        const context = pending.targetContexts && pending.targetContexts[target.symbol];
        return !context || context.ok !== true || (context.quoteDate && context.quoteDate !== pending.dataAsOf);
      });
      if (missingContext.length) {
        throw new Error(`FINAL 仍包含无法由初心只读行情核验的股票：${missingContext.map((row) => row.symbol).join(', ')}`);
      }
      const updated = store.recordDecision(pending.agentId, {
        runId: pending.runId,
        decisionDate: pending.decisionDate,
        dataAsOf: pending.dataAsOf,
        decision: hook.final_decision,
        hook,
        dailyBrief: hook.daily_brief,
        markdown: String(event.text || ''),
      });
      clearPending(event.hubSessionId);
      finishAgentTurn(pending, updated, event);
    } catch (error) {
      markFailed(pending.agentId, error);
      clearPending(event.hubSessionId);
      pumpQueue();
      finishRunIfDone();
    } finally {
      pending.processing = false;
    }
  }

  if (transcriptTap && typeof transcriptTap.on === 'function') {
    transcriptTap.on('session-bound', (event = {}) => {
      const row = store.findByHubSessionId(event.hubSessionId);
      if (!row) return;
      const automatedTurn = pendingByHubSession.get(event.hubSessionId);
      const updated = store.bindSession(row.agent.id, {
        // A fresh native id is often discovered just after the automation
        // prompt starts. Do not let session-bound overwrite the more useful
        // running state shown in the league row.
        status: automatedTurn ? 'running' : 'active',
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
      emit('session-updated', { agent: publicRow(updated) });
    });

    transcriptTap.on('turn-complete', (event = {}) => {
      const pending = pendingByHubSession.get(event.hubSessionId);
      if (!pending) return;
      handleAgentTurnComplete(event, pending).catch((error) => {
        markFailed(pending.agentId, error);
        clearPending(event.hubSessionId);
        pumpQueue();
        finishRunIfDone();
      });
    });
  }

  if (sessionManager && typeof sessionManager.on === 'function') {
    sessionManager.on('session-exited', (event = {}) => {
      const row = store.findByHubSessionId(event.sessionId);
      if (row) {
        const updated = store.bindSession(row.agent.id, { status: 'restorable' });
        emit('session-updated', { agent: publicRow(updated) });
      }
      const pending = pendingByHubSession.get(event.sessionId);
      if (!pending) return;
      markFailed(pending.agentId, new Error('Agent Session 在决策完成前退出；可恢复后重跑当日赛程。'));
      clearPending(event.sessionId);
      pumpQueue();
      finishRunIfDone();
    });
  }

  if (autoStartScheduler) startScheduler();
  return {
    environment,
    channelPrefix,
    store,
    pendingByHubSession,
    providerCatalog,
    ensureAgentSession,
    getProtectedSessionIds: () => new Set(pendingByHubSession.keys()),
    isAuthorizedResearchScope,
    listPublic,
    getRunState: runPublicState,
    runDay,
    executeOpen,
    recordClose,
    runWeekly,
    schedulerTick,
    startScheduler,
    stopScheduler,
  };
}

function registerAgentLeagueIpc(ipcMain, deps = {}) {
  const live = registerAgentLeagueRuntime(ipcMain, {
    ...deps,
    channelPrefix: 'agent-league',
    environment: 'live',
    scopePrefix: AGENT_SCOPE_PREFIX,
    sessionPurpose: 'agent-league',
    sessionTitlePrefix: 'Agent ·',
    enforceMarketClock: true,
    autoStartScheduler: true,
  });
  if (deps.enableVirtualDebug === false) return live;

  const virtualDebug = deps.virtualDebug || new AgentLeagueVirtualDebug({
    liveStore: live.store,
    ...(deps.virtualDebugOptions || {}),
  });
  const virtual = registerAgentLeagueRuntime(ipcMain, {
    ...deps,
    store: virtualDebug.store,
    channelPrefix: 'agent-league-virtual',
    environment: 'virtual',
    scopePrefix: VIRTUAL_AGENT_SCOPE_PREFIX,
    sessionPurpose: 'agent-league-virtual',
    sessionTitlePrefix: '虚拟 Agent ·',
    enforceMarketClock: false,
    autoStartScheduler: false,
    getDecisionDate: () => virtualDebug.getVirtualDate(),
    buildDecisionSnapshot: (options) => virtualDebug.buildDecisionSnapshot(options),
    buildPriceSnapshot: (options) => virtualDebug.buildPriceSnapshot(options),
    fetchTargetContexts: (options) => virtualDebug.fetchTargetContexts(options),
  });

  const publishDebugState = () => {
    const debug = virtualDebug.publicState(virtual.getRunState());
    if (typeof deps.sendToRenderer === 'function') {
      deps.sendToRenderer('agent-league-virtual:debug-updated', { environment: 'virtual', debug });
    }
    return debug;
  };
  const respond = (work, fallback) => {
    try { return { ok: true, debug: work() }; }
    catch (error) { return { ok: false, error: fallback, message: error.message }; }
  };

  ipcMain.handle('agent-league:virtual-state', () => ({ ok: true, debug: virtualDebug.publicState(virtual.getRunState()) }));
  ipcMain.handle('agent-league:virtual-initialize', (_event, input = {}) => respond(() => {
    virtualDebug.initialize({ ...input, runState: virtual.getRunState() });
    return publishDebugState();
  }, 'virtual-initialize-failed'));
  ipcMain.handle('agent-league:virtual-configure', (_event, input = {}) => respond(() => {
    virtualDebug.configure({ ...input, runState: virtual.getRunState() });
    return publishDebugState();
  }, 'virtual-configure-failed'));
  ipcMain.handle('agent-league:virtual-advance', (_event, input = {}) => respond(() => {
    virtualDebug.advance({ ...input, runState: virtual.getRunState() });
    return publishDebugState();
  }, 'virtual-advance-failed'));
  ipcMain.handle('agent-league:virtual-reset', (_event, input = {}) => respond(() => {
    virtualDebug.reset({
      ...input,
      runState: virtual.getRunState(),
      sessionManager: deps.sessionManager,
    });
    return publishDebugState();
  }, 'virtual-reset-failed'));
  ipcMain.handle('agent-league:virtual-self-test', () => {
    try { return { ok: true, report: virtualDebug.selfTest() }; }
    catch (error) { return { ok: false, error: 'virtual-self-test-failed', message: error.message }; }
  });

  return {
    ...live,
    live,
    virtual,
    virtualDebug,
    getProtectedSessionIds() {
      return new Set([...live.getProtectedSessionIds(), ...virtual.getProtectedSessionIds()]);
    },
    isAuthorizedResearchScope(scopeId) {
      return live.isAuthorizedResearchScope(scopeId) || virtual.isAuthorizedResearchScope(scopeId);
    },
    stopScheduler() {
      const liveStopped = live.stopScheduler();
      const virtualStopped = virtual.stopScheduler();
      return liveStopped || virtualStopped;
    },
  };
}

module.exports = {
  AGENT_SCOPE_PREFIX,
  PROVIDERS,
  SCHEDULER_CHECK_MS,
  buildDailyPrompt,
  buildDraftPrompt,
  buildHookPrompt,
  buildWeeklyPrompt,
  buildFrozenSnapshot,
  buildLivePriceSnapshot,
  compactCandidate,
  fetchTargetContexts,
  findDailyClose,
  findLiveQuote,
  httpJson,
  nativeSessionMeta,
  providerCatalog,
  publicAgent,
  registerAgentLeagueIpc,
  registerAgentLeagueRuntime,
  resumeOptions,
  slugifyAgentId,
  validateProvider,
};
