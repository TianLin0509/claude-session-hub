'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const { getPhilosophy } = require('../core/agent-league-philosophies.js');
const {
  buildDraftPrompt,
  buildFrozenSnapshot,
  buildHookPrompt,
  buildWeeklyPrompt,
  compactCandidate,
  findLiveQuote,
  providerCatalog,
  registerAgentLeagueIpc,
  resumeOptions,
  slugifyAgentId,
  validateProvider,
} = require('../main/ipc/agent-league-handlers.js');

const baseline = getPhilosophy('chuxin-value-speculation');

function makeDecision(weight = 0.3, cash = 0.7) {
  return {
    action_summary: weight ? '建立测试组合' : '保持现金', market_view: '市场分歧仍大', core_conflict: '逻辑与位置存在矛盾',
    cash_target: cash,
    targets: weight ? [{
      symbol: '600001.SH', name: '测试股', target_weight: weight, conviction: 0.7, horizon_days: 20,
      rule_refs: ['C1', 'P1'], thesis: '改善逻辑存在', counter_evidence: '估值扩张较快',
      timing_reason: '小仓位验证而非追高', invalidation: '改善数据转弱',
    }] : [],
    watchlist: [], risk_notes: ['主要风险'], memory_note: '沿用等待纪律',
  };
}

function makeHook(decision, verdict = 'PASS') {
  return {
    verdict,
    rule_checks: [{ rule_id: 'P1', status: 'PASS', comment: '没有因上涨追高。' }],
    strongest_counter_evidence: '估值可能先于业绩扩张。', timing_check: '已比较等待和现金。',
    portfolio_check: '仓位与证据匹配。', behavior_check: '未受排名影响。', account_feasibility: '数量可按真实账户规则执行。',
    changes: [], final_decision: decision,
    daily_brief: {
      headline: '逻辑成立也不代表必须重仓',
      body: '今天最重要的矛盾是改善逻辑与价格位置并不完全匹配。我保留了最强反证，并比较了立即买入、继续等待和保持现金。最终仓位没有因为排名或害怕错过而扩大；如果后续验证数据转弱，我会承认判断错误并退出。',
      hook_change: '自检后无变化，原预案符合个人规则。', video_hooks: ['不追高也是主动决策'],
    },
  };
}

function attemptIdFromPrompt(prompt) {
  const match = String(prompt || '').match(/"attempt_id"\s*:\s*"([^"]+)"/);
  assert(match, 'durable Agent prompt must expose attempt_id');
  return match[1];
}

function makeHarness(root, fakeHttp, extraDeps = {}) {
  const store = new AgentLeagueStore({ root });
  const ipc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
  const transcriptTap = new EventEmitter();
  const sessionManager = new EventEmitter();
  const sessions = new Map();
  const createdOptions = [];
  const directWrites = [];
  let nextId = 0;
  sessionManager.createSession = (kind, opts) => {
    createdOptions.push({ kind, opts: { ...opts } });
    const session = {
      id: opts.id || `hub-agent-${++nextId}`, kind, cwd: opts.cwd, title: opts.title,
      purpose: opts.purpose, hiddenFromSidebar: !!opts.hiddenFromSidebar, status: 'idle', currentModel: { id: opts.model },
    };
    sessions.set(session.id, session);
    return { ...session };
  };
  sessionManager.getSession = id => sessions.get(id);
  sessionManager.listSessions = () => [...sessions.values()];
  sessionManager.closeSession = id => sessions.delete(id);
  sessionManager.writeToSession = (id, data) => { directWrites.push({ id, data }); };
  const sentPrompts = [];
  const bridge = registerAgentLeagueIpc(ipc, {
    store, sessionManager, transcriptTap, getHookPort: () => 0, httpJson: fakeHttp,
    waitCliReady: async () => true,
    sendToPty: async (sessionId, prompt) => { sentPrompts.push({ sessionId, prompt }); return true; },
    ...extraDeps,
  });
  return { store, ipc, transcriptTap, sessionManager, sessions, createdOptions, directWrites, sentPrompts, bridge };
}

function fakeMarketHttp() {
  return async (_method, url) => {
    if (url.includes('/observe/overview')) return { ok: true, body: { compile_id: 'compile-1', header: { data_asof: '2026-08-26', sources_health: {} } } };
    if (url.includes('/observe/candidates')) return { ok: true, body: { items: [{
      symbol: '600001.SH', name: '测试股', state: 'new', summary: '摘要',
      tech: { mode: 'chase', close: 10, chase_score: 90 },
    }, {
      symbol: '430001.BJ', name: '北交测试', state: 'new', summary: '应过滤',
      tech: { mode: 'chase', close: 5, chase_score: 95 },
    }] } };
    if (url.includes('/api/market/600001.SH/dashboard')) return { ok: true, body: {
      identity: { symbol: '600001.SH', name: '测试股' },
      quote: { symbol: '600001.SH', name: '测试股', price: 10.5, previous_close: 10, open: 10.2, quote_at: '2026-08-27T15:01:00+08:00', source: 'fixture', confidence: 'cross_checked' },
      daily: { bars: [{ date: '2026-08-26', open: 9.8, close: 10, name: '测试股' }] },
    } };
    throw new Error(`unexpected URL ${url}`);
  };
}

async function waitFor(predicate, message = 'condition', loops = 80) {
  for (let index = 0; index < loops; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for ${message}`);
}

async function waitForTimed(predicate, message = 'condition', timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${message}`);
}

test('provider catalog covers ordinary Hub CLIs and validates exact models', () => {
  assert.deepEqual(providerCatalog().map((row) => row.provider), ['codex-cli', 'claude-cli', 'gemini-cli', 'kimi-cli', 'deepseek-cli']);
  assert.equal(validateProvider('codex-cli', 'gpt-5.6-sol').ok, true);
  assert.equal(validateProvider('codex-cli', 'made-up').ok, false);
  assert.match(slugifyAgentId('Wave Rider'), /^wave-rider$/);
});

test('resume options preserve provider-native identities', () => {
  assert.deepEqual(resumeOptions({ agent: { kind: 'codex' }, session: { nativeSession: { codexSid: 'c1' } } }), { useResume: true, codexSid: 'c1' });
  assert.deepEqual(resumeOptions({ agent: { kind: 'claude' }, session: { nativeSession: { ccSessionId: 'a1', transcriptPath: 't' } } }), { resumeCCSessionId: 'a1', resumeTranscriptPath: 't' });
});

test('candidate compaction and live quote parsing exclude Beijing while retaining open fields', () => {
  assert.equal(compactCandidate({ symbol: '600001.SH', name: '测试', tech: { mode: 'chase', close: 10, chase_score: 91 } }).score, 91);
  assert.equal(compactCandidate({ symbol: '430001.BJ', tech: { close: 5 } }), null);
  const quote = findLiveQuote({ quote: { symbol: '688001.SH', name: '科创', price: 20, open: 19.8, quote_at: '2026-08-27T09:35:00+08:00' } });
  assert.equal(quote.open, 19.8);
  assert.equal(quote.quoteDate, '2026-08-27');
});

test('freezes decision snapshot by trading date and builds DRAFT/Hook/weekly prompts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-snapshot-'));
  try {
    const store = new AgentLeagueStore({ root });
    const snapshot = await buildFrozenSnapshot({ store, httpJson: fakeMarketHttp(), requiredSymbols: new Set(), decisionFor: '2026-08-27' });
    assert.equal(snapshot.asOf, '2026-08-26');
    assert.equal(snapshot.decisionFor, '2026-08-27');
    assert.equal(snapshot.candidates.some((row) => row.symbol.endsWith('.BJ')), false);
    assert.equal(fs.existsSync(path.join(root, 'snapshots', '2026-08-27-decision.md')), true);
    const row = store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const draft = makeDecision();
    assert.match(buildDraftPrompt(row, snapshot, 'run-1'), /agent-league-draft/);
    assert.match(buildDraftPrompt(row, snapshot, 'run-1'), /PROMPT_DAILY\.md/);
    assert.match(buildHookPrompt(row, snapshot, 'run-1', draft, {}), /agent-league-hook/);
    assert.match(buildHookPrompt(row, snapshot, 'run-1', draft, {}), /PROMPT_HOOK\.md/);
    assert.match(buildWeeklyPrompt(row, '2026-08-29', [], 'weekly-1'), /agent-league-weekly/);
    assert.match(buildWeeklyPrompt(row, '2026-08-29', [], 'weekly-1'), /PROMPT_WEEKLY\.md/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('IPC creates visible ordinary session with 500k baseline and persists native binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-ipc-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    const created = harness.ipc.handlers.get('agent-league:create')(null, {
      id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', model: 'gpt-5.6-sol', philosophyKey: 'chuxin-value-speculation',
    });
    assert.equal(created.ok, true);
    assert.equal(created.agent.initialCash, 500000);
    assert.equal(created.session.purpose, 'agent-league');
    assert.equal(created.session.hiddenFromSidebar, false);
    harness.transcriptTap.emit('session-bound', { hubSessionId: created.session.id, codexSid: 'native-codex-1' });
    assert.equal(harness.store.getAgent('chuxin-baseline').session.nativeSession.codexSid, 'native-codex-1');
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude league agents stay autonomous even when the research hook is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-claude-autonomous-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp(), { getHookPort: () => 0 });
    const created = harness.ipc.handlers.get('agent-league:create')(null, {
      id: 'chuxin-avatar', name: '初心化身', provider: 'claude-cli',
      model: 'claude-opus-5[1m]', philosophyKey: 'chuxin-value-speculation',
    });
    assert.equal(created.ok, true);
    const launch = harness.createdOptions[harness.createdOptions.length - 1];
    assert.equal(launch.opts.autonomous, true);
    assert.equal(launch.opts.mcpProfile, 'none');
    assert.equal(launch.opts.mcpConfigFile, undefined);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent League repairs an unbound persisted shell with a fresh CLI and never uses a picker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-unbound-repair-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    const created = harness.ipc.handlers.get('agent-league:create')(null, {
      id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', model: 'gpt-5.6-sol', philosophyKey: 'chuxin-value-speculation',
    });
    const hubId = created.session.id;
    harness.sessions.delete(hubId); // Hub restarted before the first native turn.
    const resumed = harness.ipc.handlers.get('agent-league:ensure-session')(null, { agentId: 'chuxin-baseline' });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.session.id, hubId);
    let launch = harness.createdOptions[harness.createdOptions.length - 1];
    assert.equal(launch.opts.useResume, undefined);
    assert.equal(launch.opts.codexResumePicker, undefined);

    // Reproduce the screenshot state: a generic resume picker already occupies the Hub shell.
    harness.sessions.set(hubId, {
      id: hubId, kind: 'codex', purpose: 'agent-league', status: 'idle',
      codexAllowMtimeFallback: true, currentModel: { id: 'gpt-5.6-sol' },
    });
    const repaired = harness.ipc.handlers.get('agent-league:ensure-session')(null, { agentId: 'chuxin-baseline' });
    assert.equal(repaired.ok, true);
    launch = harness.createdOptions[harness.createdOptions.length - 1];
    assert.equal(launch.opts.id, hubId);
    assert.equal(launch.opts.useResume, undefined);
    assert.equal(harness.sessions.get(hubId).codexAllowMtimeFallback, undefined);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('prompt workbench IPC exposes editable files, read-only compiled contracts, and conflict-safe saving', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-prompt-ipc-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const loaded = harness.ipc.handlers.get('agent-league:prompt-files')(null, { agentId: 'chuxin-baseline' });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.files.length, 16);
    assert.equal(loaded.contracts.length, 3);
    assert.match(loaded.contracts.find((row) => row.key === 'contractDaily').content, /完整目标组合/);
    const daily = loaded.files.find((row) => row.key === 'dailyPrompt');
    const saved = harness.ipc.handlers.get('agent-league:save-prompt-file')(null, {
      agentId: 'chuxin-baseline', key: 'dailyPrompt', expectedSha256: daily.sha256,
      content: `${daily.content}\n- 新增：先输出最值得等待的观察条件。`,
    });
    assert.equal(saved.ok, true);
    assert.match(saved.file.content, /最值得等待/);
    const conflict = harness.ipc.handlers.get('agent-league:save-prompt-file')(null, {
      agentId: 'chuxin-baseline', key: 'dailyPrompt', expectedSha256: daily.sha256, content: daily.content,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, 'prompt-file-conflict');
    const blocked = harness.ipc.handlers.get('agent-league:save-prompt-file')(null, {
      agentId: 'chuxin-baseline', key: 'portfolio', content: 'tamper', expectedSha256: '',
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /只能查看/);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daily run uses two turns in the same Session, then open/close phases update files and ledger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-run-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { trigger: 'test', force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true, JSON.stringify(started));
    await waitFor(() => harness.sentPrompts.length === 1, 'draft prompt');
    const sessionId = harness.sentPrompts[0].sessionId;
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[0].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'hook prompt');
    assert.equal(harness.sentPrompts[1].sessionId, sessionId, 'Hook must stay in the same ordinary Session');
    const finalHook = makeHook(draft);
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({ run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[1].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...finalHook })}\n\`\`\``,
    });
    await waitFor(() => harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'completed', 'daily completion');
    let row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.latestDaily.hook.verdict, 'PASS');
    assert.equal(row.latestDaily.dailyBrief.headline, '逻辑成立也不代表必须重仓');
    assert.equal(row.portfolio.pendingDecision.decisionDate, '2026-08-27');

    const executed = await harness.ipc.handlers.get('agent-league:execute-open')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.trades.rows.length, 1);
    assert.equal(row.latestDaily.execution.trades.length, 1);
    assert.equal(harness.bridge.runtimeStore.getRun('live:open:2026-08-27').status, 'completed');
    assert.equal(harness.bridge.runtimeStore.getEffect('live:open:2026-08-27:agent:chuxin-baseline').status, 'applied');
    const closed = await harness.ipc.handlers.get('agent-league:record-close')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(closed.ok, true);
    assert(harness.store.getAgent('chuxin-baseline').latestDaily.closeResult.nav > 0);
    assert.equal(harness.bridge.runtimeStore.getRun('live:close:2026-08-27').status, 'completed');
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an Agent added after same-day completion can be caught up without rerunning completed peers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-same-day-catchup-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const first = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    await waitFor(() => harness.sentPrompts.length === 1, 'baseline DRAFT');
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: harness.sentPrompts[0].sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: first.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[0].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'baseline Hook');
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: harness.sentPrompts[1].sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({ run_id: first.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[1].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...makeHook(draft) })}\n\`\`\``,
    });
    await waitFor(() => harness.store.getAgent('chuxin-baseline').latestDaily.status === 'decision-queued', 'baseline FINAL');
    const originalDecisionCount = harness.store.getAgent('chuxin-baseline').agent.decisionCount;
    harness.store.createAgent({ id: 'chuxin-avatar', name: '初心化身', provider: 'claude-cli', kind: 'claude', model: 'claude-opus-5[1m]', philosophy: baseline });
    const caughtUp = await harness.ipc.handlers.get('agent-league:run-day')(null, {
      decisionDate: '2026-08-27', agentIds: ['chuxin-avatar'], trigger: 'test',
    });
    assert.equal(caughtUp.ok, true);
    await waitFor(() => harness.sentPrompts.length === 3, 'avatar catch-up DRAFT');
    assert.match(harness.sentPrompts[2].prompt, /盘前 DRAFT/);
    assert.equal(harness.store.getAgent('chuxin-baseline').agent.decisionCount, originalDecisionCount);
    assert.deepEqual(caughtUp.run.durable.tasks.map((task) => task.agentId).sort(), ['chuxin-avatar', 'chuxin-baseline']);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('open settlement repairs a crash after portfolio write without duplicating the trade', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-open-reconcile-'));
  let harness = null;
  let injected = false;
  try {
    harness = makeHarness(root, fakeMarketHttp(), {
      afterOpenPortfolioSaved: () => {
        if (!injected) {
          injected = true;
          throw new Error('simulated crash after portfolio write');
        }
      },
    });
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    await waitFor(() => harness.sentPrompts.length === 1, 'reconcile DRAFT');
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: harness.sentPrompts[0].sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[0].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'reconcile Hook');
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: harness.sentPrompts[1].sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({ run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[1].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...makeHook(draft) })}\n\`\`\``,
    });
    await waitFor(() => harness.store.getAgent('chuxin-baseline').latestDaily.status === 'decision-queued', 'reconcile FINAL');

    const failedOpen = await harness.ipc.handlers.get('agent-league:execute-open')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(failedOpen.ok, false);
    let row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.portfolio.pendingDecision, null, 'portfolio write already cleared pending before the injected crash');
    assert.equal(row.trades.rows.length, 1);
    assert.equal(row.latestDaily.execution, undefined, 'daily execution write was the missing suffix');
    assert.equal(harness.bridge.runtimeStore.getEffect('live:open:2026-08-27:agent:chuxin-baseline').status, 'prepared');

    const recovered = await harness.ipc.handlers.get('agent-league:execute-open')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.results[0].recoveredFromPreparedEffect, true);
    row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.trades.rows.length, 1, 'idempotency key prevents a duplicate trade');
    assert.equal(row.latestDaily.execution.trades.length, 1);
    assert.equal(harness.bridge.runtimeStore.getEffect('live:open:2026-08-27:agent:chuxin-baseline').status, 'applied');
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prompt edits are frozen while a durable Agent task is non-terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-prompt-freeze-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const file = harness.ipc.handlers.get('agent-league:prompt-files')(null, { agentId: 'chuxin-baseline' }).files.find((row) => row.key === 'dailyPrompt');
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'active DRAFT');
    const saved = harness.ipc.handlers.get('agent-league:save-prompt-file')(null, {
      agentId: 'chuxin-baseline', key: 'dailyPrompt', expectedSha256: file.sha256, content: `${file.content}\n- 不应在运行中写入`,
    });
    assert.equal(saved.ok, false);
    assert.equal(saved.error, 'agent-input-frozen');
    assert.match(saved.message, /本轮终态后/);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('health check reports scheduler, SQLite, CLI and T-1 data readiness without starting a run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-health-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp(), { commandAvailable: () => true });
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    harness.ipc.handlers.get('agent-league:update-schedule')(null, {
      enabled: true, decisionTime: '08:30', decisionCutoff: '09:15', executionTime: '09:35', resultTime: '15:10', weeklyTime: '10:00', maxConcurrency: 2,
    });
    const result = await harness.ipc.handlers.get('agent-league:health')(null, { now: new Date('2026-08-26T23:00:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.report.severity, 'pass');
    assert.equal(result.report.nextDecisionDate, '2026-08-27');
    assert.equal(result.report.expectedDataAsOf, '2026-08-26');
    assert.equal(result.report.checks.find((row) => row.id === 'runtime-db').status, 'pass');
    assert.equal(result.report.checks.find((row) => row.id === 'chuxin-api').status, 'pass');
    assert.equal(harness.sentPrompts.length, 0);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown single-Agent catch-up request fails closed instead of running everyone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-unknown-catchup-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const result = await harness.ipc.handlers.get('agent-league:run-day')(null, {
      force: true, decisionDate: '2026-08-27', agentIds: ['does-not-exist'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'agent-missing');
    assert.equal(harness.sentPrompts.length, 0);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Saturday uses one additional turn and stores memory/checklist proposal without auto-applying it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-weekly-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const draft = makeDecision();
    const checkedHook = makeHook(draft);
    harness.store.recordRunStart('chuxin-baseline', { runId: 'r1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26' });
    harness.store.recordDraft('chuxin-baseline', { runId: 'r1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', draft });
    harness.store.recordDecision('chuxin-baseline', { runId: 'r1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', decision: draft, hook: checkedHook, dailyBrief: checkedHook.daily_brief });
    const started = await harness.ipc.handlers.get('agent-league:run-weekly')(null, { force: true, saturdayDate: '2026-08-29' });
    assert.equal(started.ok, true, JSON.stringify(started));
    await waitFor(() => harness.sentPrompts.length === 1, 'weekly prompt');
    const response = {
      run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[0].prompt), saturday_date: '2026-08-29', summary: '保持等待纪律。',
      process_win: '没有追高。', process_mistake: '仓位解释不充分。', lesson: '等待也是主动决策。',
      strongest_counterexample: '等待可能踏空。', evidence_for: ['样本A'], evidence_against: ['样本B'],
      checklist_proposal: { rule_id: 'P1', old_rule: '不追高', proposed_rule: '写出等待触发条件', reason: '更可执行', evidence: ['一次样本'] },
    };
    harness.transcriptTap.emit('turn-complete', { hubSessionId: harness.sentPrompts[0].sessionId, text: `\`\`\`agent-league-weekly\n${JSON.stringify(response)}\n\`\`\`` });
    await waitFor(() => harness.store.getAgent('chuxin-baseline').latestWeekly && harness.store.getAgent('chuxin-baseline').latestWeekly.status === 'completed', 'weekly completion');
    const row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.memory.candidates.length, 1);
    assert.equal(row.evolution.proposals.length, 1);
    assert.equal(row.checklist.rules.find((rule) => rule.id === 'P1').text, '即使公司逻辑成立，当前位置和估值不舒服时也应等待，不因害怕错过而追高。');
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hook failure preserves DRAFT and automatically retries only the Hook checkpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-hook-failure-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    await waitFor(() => harness.sentPrompts.length === 1, 'draft prompt');
    const sessionId = harness.sentPrompts[0].sessionId;
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[0].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'hook prompt');
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({
        run_id: started.run.runId,
        attempt_id: attemptIdFromPrompt(harness.sentPrompts[1].prompt),
        decision_date: '2026-08-27',
        data_as_of: '2026-08-26',
        verdict: 'BROKEN',
      })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 3, 'automatic Hook retry');
    const failed = harness.store.getDaily('chuxin-baseline', '2026-08-27');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 'hook');
    assert.equal(failed.draft.targets[0].symbol, '600001.SH');
    assert.equal(harness.sentPrompts[2].sessionId, sessionId, 'retry must reuse the same ordinary Session');
    assert.match(harness.sentPrompts[2].prompt, /决策前 Hook/);
    assert.doesNotMatch(harness.sentPrompts[2].prompt, /盘前 DRAFT/);
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({ run_id: started.run.runId, attempt_id: attemptIdFromPrompt(harness.sentPrompts[2].prompt), decision_date: '2026-08-27', data_as_of: '2026-08-26', ...makeHook(draft) })}\n\`\`\``,
    });
    await waitFor(() => harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'completed', 'Hook retry completion');
    assert.equal(harness.store.currentRunLease(), null);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a successor Hub adopts an interrupted Hook checkpoint and ignores the fenced late output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-hook-handoff-'));
  let first = null;
  let second = null;
  try {
    first = makeHarness(root, fakeMarketHttp());
    first.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await first.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    await waitFor(() => first.sentPrompts.length === 1, 'first Hub DRAFT');
    const sessionId = first.sentPrompts[0].sessionId;
    const draft = makeDecision();
    first.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({
        run_id: started.run.runId,
        attempt_id: attemptIdFromPrompt(first.sentPrompts[0].prompt),
        decision_date: '2026-08-27',
        data_as_of: '2026-08-26',
        ...draft,
      })}\n\`\`\``,
    });
    await waitFor(() => first.sentPrompts.length === 2, 'first Hub Hook');
    const oldHookAttempt = attemptIdFromPrompt(first.sentPrompts[1].prompt);
    first.bridge.beginHandoff('unit-handoff');
    first.bridge.stopScheduler();
    first = null;

    second = makeHarness(root, fakeMarketHttp());
    const adopted = await second.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(adopted.ok, true);
    await waitFor(() => second.sentPrompts.length === 1, 'successor Hook prompt');
    assert.match(second.sentPrompts[0].prompt, /决策前 Hook/);
    assert.doesNotMatch(second.sentPrompts[0].prompt, /盘前 DRAFT/);
    const newHookAttempt = attemptIdFromPrompt(second.sentPrompts[0].prompt);
    assert.notEqual(newHookAttempt, oldHookAttempt);

    second.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({
        run_id: adopted.run.runId,
        attempt_id: oldHookAttempt,
        decision_date: '2026-08-27',
        data_as_of: '2026-08-26',
        ...makeHook(draft),
      })}\n\`\`\``,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(second.store.getDaily('chuxin-baseline', '2026-08-27').status, 'decision-queued');
    assert.equal(second.ipc.handlers.get('agent-league:list')(null, {}).run.active.length, 1);

    second.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({
        run_id: adopted.run.runId,
        attempt_id: newHookAttempt,
        decision_date: '2026-08-27',
        data_as_of: '2026-08-26',
        ...makeHook(draft),
      })}\n\`\`\``,
    });
    await waitFor(() => second.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'completed', 'successor completion');
    assert.equal(second.store.getAgent('chuxin-baseline').agent.decisionCount, 1);
  } finally {
    first?.bridge.stopScheduler();
    second?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('graceful PTY exit during handoff cannot mark a durable in-flight run completed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-handoff-exit-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'handoff active DRAFT');
    const sessionId = harness.sentPrompts[0].sessionId;
    harness.bridge.beginHandoff('unit-pty-drain');
    harness.sessionManager.emit('session-exited', { sessionId });
    assert.equal(harness.store.getSchedule().lastRunStatus, 'interrupted');
    assert.equal(harness.bridge.runtimeStore.getRun('live:decision:2026-08-27').status, 'running');
    assert.notEqual(harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus, 'completed');
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an incompatible runtime protocol cannot replay an unfinished run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-version-fence-'));
  let first = null;
  let second = null;
  try {
    first = makeHarness(root, fakeMarketHttp(), { hubVersion: '1.6.28', runtimeProtocolVersion: 1 });
    first.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await first.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => first.sentPrompts.length === 1, 'version A DRAFT');
    first.bridge.beginHandoff('version-fence');
    first.bridge.stopScheduler();
    first = null;

    second = makeHarness(root, fakeMarketHttp(), { hubVersion: '1.6.29', runtimeProtocolVersion: 2 });
    const adopted = await second.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(adopted.ok, false);
    assert.equal(adopted.error, 'runtime-version-conflict');
    assert.match(adopted.message, /拒绝不兼容重放/);
    assert.equal(second.sentPrompts.length, 0);
  } finally {
    first?.bridge.stopScheduler();
    second?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('open execution refuses a partial cohort after the decision owner exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-open-barrier-'));
  let first = null;
  let second = null;
  try {
    first = makeHarness(root, fakeMarketHttp());
    first.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await first.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true, JSON.stringify(started));
    await waitFor(() => first.sentPrompts.length === 1, 'in-flight DRAFT');
    first.bridge.beginHandoff('unit-open-barrier');
    first.bridge.stopScheduler();
    first = null;

    second = makeHarness(root, fakeMarketHttp());
    const opened = await second.ipc.handlers.get('agent-league:execute-open')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(opened.ok, false);
    assert.equal(opened.error, 'decision-cohort-incomplete');
    assert.deepEqual(opened.incomplete.map((row) => row.agentId), ['chuxin-baseline']);
    assert.equal(second.store.getSchedule().lastExecutionDate, '');
    assert.equal(second.store.getAgent('chuxin-baseline').trades.rows.length, 0);
  } finally {
    first?.bridge.stopScheduler();
    second?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scheduler resumes the frozen cohort after cutoff without admitting a newly added Agent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-post-cutoff-recovery-'));
  let first = null;
  let second = null;
  try {
    first = makeHarness(root, fakeMarketHttp());
    first.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    first.store.saveSchedule({ ...first.store.getSchedule(), enabled: true });
    const started = await first.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => first.sentPrompts.length === 1, 'pre-cutoff DRAFT');
    first.bridge.beginHandoff('post-cutoff-recovery');
    first.bridge.stopScheduler();
    first = null;

    second = makeHarness(root, fakeMarketHttp());
    second.store.createAgent({ id: 'late-agent', name: '截止后新增', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const tick = await second.bridge.schedulerTick(new Date('2026-08-27T01:20:00.000Z'));
    assert.equal(tick.ok, true, JSON.stringify(tick));
    await waitFor(() => second.sentPrompts.length === 1, 'successor recovery DRAFT');
    assert.equal(second.sentPrompts[0].sessionId, second.store.getAgent('chuxin-baseline').session.hubSessionId);
    assert.equal(second.store.getAgent('late-agent').latestDaily, null);
    assert.deepEqual(tick.run.durable.tasks.map((task) => task.agentId), ['chuxin-baseline']);
  } finally {
    first?.bridge.stopScheduler();
    second?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing provider completion cannot leave the league permanently running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-timeout-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp(), { agentTurnTimeoutMs: 120 });
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true, JSON.stringify(started));
    await waitFor(() => harness.sentPrompts.length === 1, 'draft prompt');
    await waitForTimed(
      () => harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'failed',
      'retry budget exhaustion',
    );
    const state = harness.ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(state.run, null, 'watchdog must close the in-memory run');
    assert.equal(state.schedule.lastRunStatus, 'failed');
    assert.equal(harness.bridge.pendingByHubSession.size, 0);
    assert.equal(harness.store.currentRunLease(), null);
    const failed = harness.store.getDaily('chuxin-baseline', '2026-08-27');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 'draft');
    assert.match(failed.error, /盘前 DRAFT/);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a PTY send without provider turn acknowledgement fails promptly instead of hanging', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-send-stuck-'));
  let harness = null;
  try {
    harness = makeHarness(root, fakeMarketHttp(), {
      sendToPty: async () => ({ ok: true, sendStatus: 'stuck' }),
    });
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'failed', 'send acknowledgement failure');
    const state = harness.ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(state.run, null);
    assert.equal(harness.bridge.pendingByHubSession.size, 0);
    const failed = harness.store.getDaily('chuxin-baseline', '2026-08-27');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /provider turn 启动确认/);
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missed prior-day opening execution is recovered from historical daily open before a new decision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-recovery-'));
  let harness = null;
  try {
    const historicalHttp = async (method, url) => {
      const base = await fakeMarketHttp()(method, url);
      if (url.includes('/api/market/600001.SH/dashboard')) {
        base.body.daily = { bars: [{ date: '2026-08-26', open: 9.8, close: 10 }] };
      }
      return base;
    };
    harness = makeHarness(root, historicalHttp);
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const draft = makeDecision();
    const checkedHook = makeHook(draft);
    harness.store.recordRunStart('chuxin-baseline', { runId: 'old-run', decisionDate: '2026-08-26', dataAsOf: '2026-08-25' });
    harness.store.recordDraft('chuxin-baseline', { runId: 'old-run', decisionDate: '2026-08-26', dataAsOf: '2026-08-25', draft });
    harness.store.recordDecision('chuxin-baseline', { runId: 'old-run', decisionDate: '2026-08-26', dataAsOf: '2026-08-25', decision: draft, hook: checkedHook, dailyBrief: checkedHook.daily_brief });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'new daily prompt after recovery');
    const row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.portfolio.pendingDecision, null);
    assert.equal(row.trades.rows.length, 1);
    assert.equal(row.trades.rows[0].referencePrice, 9.8);
    assert.equal(row.latestDaily.decisionDate, '2026-08-27');
  } finally {
    harness?.bridge.stopScheduler();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent League recovers a Codex launch command whose trailing Enter was swallowed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-launch-enter-'));
  try {
    let readinessChecks = 0;
    const harness = makeHarness(root, fakeMarketHttp(), {
      cliReadyWindowsMs: [1, 1, 1],
      waitCliReady: async () => { readinessChecks += 1; return readinessChecks >= 2; },
    });
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { trigger: 'test', force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'prompt after launch Enter recovery');
    assert.deepEqual(harness.directWrites, [{ id: harness.sentPrompts[0].sessionId, data: '\r' }]);
    assert.equal(readinessChecks, 2);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual weekend premarket click schedules the next official trading day', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-weekend-next-'));
  try {
    const baseHttp = fakeMarketHttp();
    const weekendHttp = async (method, url) => {
      const response = await baseHttp(method, url);
      if (url.includes('/observe/overview')) {
        response.body.header.data_asof = '2026-08-28'; // Monday's immediately previous trading day.
      }
      return response;
    };
    const harness = makeHarness(root, weekendHttp);
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, {
      trigger: 'manual',
      now: new Date('2026-08-29T04:00:00.000Z'),
    });
    assert.equal(started.ok, true);
    assert.equal(started.scheduledFrom, '2026-08-29');
    assert.equal(started.decisionDate, '2026-08-31');
    assert.equal(started.snapshot.decisionFor, '2026-08-31');
    await waitFor(() => harness.sentPrompts.length === 1, 'weekend Monday prompt');
    assert.match(harness.sentPrompts[0].prompt, /决策交易日：2026-08-31/);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('virtual live runtime uses a real Session turn while isolating trades, stats and dates from formal league', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-virtual-runtime-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const initialized = harness.ipc.handlers.get('agent-league:virtual-initialize')(null, {
      virtualDate: '2026-08-31', scenario: 'rally',
    });
    assert.equal(initialized.ok, true);
    assert.equal(initialized.debug.virtualDate, '2026-08-31');
    const virtualStore = harness.bridge.virtual.store;
    assert.equal(virtualStore.listAgents().length, 1);

    const started = await harness.ipc.handlers.get('agent-league-virtual:run-day')(null, { trigger: 'virtual-unit' });
    assert.equal(started.ok, true);
    assert.equal(started.run.environment, 'virtual');
    await waitFor(() => harness.sentPrompts.length === 1, 'virtual DRAFT prompt');
    const sessionId = harness.sentPrompts[0].sessionId;
    assert.equal(harness.sessions.get(sessionId).purpose, 'agent-league-virtual');
    assert.match(harness.sessions.get(sessionId).title, /^虚拟 Agent ·/);
    assert.equal(harness.ipc.handlers.get('agent-league-virtual:list')(null, {}).agents[0].session.status, 'running');
    assert.match(harness.sentPrompts[0].prompt, /虚拟实盘调试/);
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: started.run.runId, decision_date: '2026-08-31', data_as_of: '2026-08-28', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'virtual Hook prompt');
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({ run_id: started.run.runId, decision_date: '2026-08-31', data_as_of: '2026-08-28', ...makeHook(draft) })}\n\`\`\``,
    });
    await waitFor(() => harness.ipc.handlers.get('agent-league-virtual:list')(null, {}).schedule.lastRunStatus === 'completed', 'virtual decision completion');

    const opened = await harness.ipc.handlers.get('agent-league-virtual:execute-open')(null, { trigger: 'virtual-unit' });
    assert.equal(opened.ok, true);
    assert.equal(opened.results[0].trades.length, 1);
    const closed = await harness.ipc.handlers.get('agent-league-virtual:record-close')(null, { trigger: 'virtual-unit' });
    assert.equal(closed.ok, true);
    const virtualRow = virtualStore.getAgent('chuxin-baseline');
    assert(virtualRow.stats.positionWeight > 0);
    assert(virtualRow.stats.totalReturn > 0);
    assert(Math.abs(virtualRow.stats.dailyReturn - virtualRow.stats.totalReturn) < 1e-12, 'first-day daily and total return share the initial-cash baseline');
    assert.equal(harness.store.getAgent('chuxin-baseline').trades.rows.length, 0, 'formal trades remain untouched');
    assert.equal(harness.store.getAgent('chuxin-baseline').agent.decisionCount, 0, 'formal decisions remain untouched');

    const weeklyStarted = await harness.ipc.handlers.get('agent-league-virtual:run-weekly')(null, { trigger: 'virtual-unit' });
    assert.equal(weeklyStarted.ok, true);
    await waitFor(() => harness.sentPrompts.length === 3, 'virtual weekly prompt');
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-weekly\n${JSON.stringify({
        run_id: weeklyStarted.run.runId,
        saturday_date: '2026-08-31',
        summary: '虚拟周复盘完成。', process_win: '流程按顺序执行。', process_mistake: '样本仍少。',
        lesson: '先验证过程，再解释盈亏。', strongest_counterexample: '单日结果不能证明策略。',
        evidence_for: ['虚拟成交与统计一致'], evidence_against: ['只有一个交易日'], checklist_proposal: null,
      })}\n\`\`\``,
    });
    await waitFor(() => virtualStore.getAgent('chuxin-baseline').latestWeekly && virtualStore.getAgent('chuxin-baseline').latestWeekly.status === 'completed', 'virtual weekly completion');
    assert.equal(virtualStore.getAgent('chuxin-baseline').memory.candidates.length, 1);

    const debugState = harness.ipc.handlers.get('agent-league:virtual-state')();
    assert.equal(debugState.debug.phase, 'closed');
    const selfTest = harness.ipc.handlers.get('agent-league:virtual-self-test')();
    assert.equal(selfTest.report.ok, true);
    const advanced = harness.ipc.handlers.get('agent-league:virtual-advance')(null, { scenario: 'mixed' });
    assert.equal(advanced.ok, true);
    assert.equal(advanced.debug.virtualDate, '2026-09-01');
    assert.equal(advanced.debug.phase, 'pre-market');
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scheduler skips official 2026 holidays and stops outside verified calendar coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-calendar-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    harness.store.saveSchedule({ ...harness.store.getSchedule(), enabled: true });
    const holiday = await harness.bridge.schedulerTick(new Date('2026-09-25T02:30:00.000Z'));
    assert.equal(holiday.skipped, 'exchange-closed');
    const uncovered = await harness.bridge.schedulerTick(new Date('2027-01-04T02:30:00.000Z'));
    assert.match(uncovered.skipped, /calendar-out-of-coverage/);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
