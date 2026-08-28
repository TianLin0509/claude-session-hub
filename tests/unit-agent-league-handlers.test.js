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
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { trigger: 'test', force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'draft prompt');
    const sessionId = harness.sentPrompts[0].sessionId;
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: started.run.runId, decision_date: '2026-08-27', data_as_of: '2026-08-26', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'hook prompt');
    assert.equal(harness.sentPrompts[1].sessionId, sessionId, 'Hook must stay in the same ordinary Session');
    const finalHook = makeHook(draft);
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-hook\n${JSON.stringify({ run_id: started.run.runId, decision_date: '2026-08-27', data_as_of: '2026-08-26', ...finalHook })}\n\`\`\``,
    });
    await waitFor(() => harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'completed', 'daily completion');
    let row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.latestDaily.hook.verdict, 'PASS');
    assert.equal(row.latestDaily.dailyBrief.headline, '逻辑成立也不代表必须重仓');
    assert.equal(row.portfolio.pendingDecision.decisionDate, '2026-08-27');

    const executed = await harness.ipc.handlers.get('agent-league:execute-open')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(executed.ok, true);
    row = harness.store.getAgent('chuxin-baseline');
    assert.equal(row.trades.rows.length, 1);
    assert.equal(row.latestDaily.execution.trades.length, 1);
    const closed = await harness.ipc.handlers.get('agent-league:record-close')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(closed.ok, true);
    assert(harness.store.getAgent('chuxin-baseline').latestDaily.closeResult.nav > 0);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Saturday uses one additional turn and stores memory/checklist proposal without auto-applying it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-weekly-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const draft = makeDecision();
    const checkedHook = makeHook(draft);
    harness.store.recordRunStart('chuxin-baseline', { runId: 'r1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26' });
    harness.store.recordDraft('chuxin-baseline', { runId: 'r1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', draft });
    harness.store.recordDecision('chuxin-baseline', { runId: 'r1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', decision: draft, hook: checkedHook, dailyBrief: checkedHook.daily_brief });
    const started = await harness.ipc.handlers.get('agent-league:run-weekly')(null, { force: true, saturdayDate: '2026-08-29' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'weekly prompt');
    const response = {
      run_id: started.run.runId, saturday_date: '2026-08-29', summary: '保持等待纪律。',
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
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hook failure preserves DRAFT, releases lease, and retry only starts a fresh unfinished Agent turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-hook-failure-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp());
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    await waitFor(() => harness.sentPrompts.length === 1, 'draft prompt');
    const sessionId = harness.sentPrompts[0].sessionId;
    const draft = makeDecision();
    harness.transcriptTap.emit('turn-complete', {
      hubSessionId: sessionId,
      text: `\`\`\`agent-league-draft\n${JSON.stringify({ run_id: started.run.runId, decision_date: '2026-08-27', data_as_of: '2026-08-26', ...draft })}\n\`\`\``,
    });
    await waitFor(() => harness.sentPrompts.length === 2, 'hook prompt');
    harness.transcriptTap.emit('turn-complete', { hubSessionId: sessionId, text: '故意缺少 Hook 结构块' });
    await waitFor(() => harness.ipc.handlers.get('agent-league:list')(null, {}).schedule.lastRunStatus === 'failed', 'failed run');
    const failed = harness.store.getDaily('chuxin-baseline', '2026-08-27');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 'hook');
    assert.equal(failed.draft.targets[0].symbol, '600001.SH');
    assert.equal(harness.store.currentRunLease(), null);
    const retried = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(retried.ok, true);
    await waitFor(() => harness.sentPrompts.length === 3, 'retry draft prompt');
    assert.equal(harness.sentPrompts[2].sessionId, sessionId, 'retry must reuse the same ordinary Session');
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing provider completion cannot leave the league permanently running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-timeout-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp(), { agentTurnTimeoutMs: 120 });
    harness.store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy: baseline });
    const started = await harness.ipc.handlers.get('agent-league:run-day')(null, { force: true, decisionDate: '2026-08-27' });
    assert.equal(started.ok, true);
    await waitFor(() => harness.sentPrompts.length === 1, 'draft prompt');
    await new Promise(resolve => setTimeout(resolve, 260));
    const state = harness.ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(state.run, null, 'watchdog must close the in-memory run');
    assert.equal(state.schedule.lastRunStatus, 'failed');
    assert.equal(harness.bridge.pendingByHubSession.size, 0);
    assert.equal(harness.store.currentRunLease(), null);
    const failed = harness.store.getDaily('chuxin-baseline', '2026-08-27');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 'draft');
    assert.match(failed.error, /盘前 DRAFT/);
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a PTY send without provider turn acknowledgement fails promptly instead of hanging', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-send-stuck-'));
  try {
    const harness = makeHarness(root, fakeMarketHttp(), {
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
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missed prior-day opening execution is recovered from historical daily open before a new decision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-recovery-'));
  try {
    const historicalHttp = async (method, url) => {
      const base = await fakeMarketHttp()(method, url);
      if (url.includes('/api/market/600001.SH/dashboard')) {
        base.body.daily = { bars: [{ date: '2026-08-26', open: 9.8, close: 10 }] };
      }
      return base;
    };
    const harness = makeHarness(root, historicalHttp);
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
    harness.bridge.stopScheduler();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
    const harness = makeHarness(root, fakeMarketHttp());
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
