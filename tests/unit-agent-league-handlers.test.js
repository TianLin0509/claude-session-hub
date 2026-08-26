'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const {
  buildDailyPrompt,
  buildFrozenSnapshot,
  compactCandidate,
  providerCatalog,
  registerAgentLeagueIpc,
  resumeOptions,
  slugifyAgentId,
  validateProvider,
} = require('../main/ipc/agent-league-handlers.js');

test('provider catalog covers ordinary Hub CLIs and validates exact models', () => {
  assert.deepEqual(providerCatalog().map((row) => row.provider), [
    'codex-cli', 'claude-cli', 'gemini-cli', 'kimi-cli', 'deepseek-cli',
  ]);
  assert.equal(validateProvider('codex-cli', 'gpt-5.6-sol').ok, true);
  assert.equal(validateProvider('gemini-cli', 'gemini-3-pro-preview').ok, true);
  assert.equal(validateProvider('codex-cli', 'made-up').ok, false);
  assert.match(slugifyAgentId('Wave Rider'), /^wave-rider$/);
  assert.match(slugifyAgentId('逐浪'), /^agent-/);
});

test('resume options preserve provider-native identities', () => {
  assert.deepEqual(resumeOptions({ agent: { kind: 'codex' }, session: { nativeSession: { codexSid: 'c1' } } }), { useResume: true, codexSid: 'c1' });
  assert.deepEqual(resumeOptions({ agent: { kind: 'deepseek' }, session: { nativeSession: { codexSid: 'd1' } } }), { useResume: true, codexSid: 'd1' });
  assert.deepEqual(resumeOptions({ agent: { kind: 'claude' }, session: { nativeSession: { ccSessionId: 'a1', transcriptPath: 't' } } }), { resumeCCSessionId: 'a1', resumeTranscriptPath: 't' });
  assert.deepEqual(resumeOptions({ agent: { kind: 'gemini' }, session: { nativeSession: { geminiChatId: 'g1', geminiProjectRoot: 'p' } } }), {
    useResume: true, geminiChatId: 'g1', geminiProjectHash: undefined, geminiProjectRoot: 'p',
  });
});

test('compacts candidate rows into one frozen competition universe', () => {
  const row = compactCandidate({
    symbol: '600001.SH', name: '测试', state: 'new', summary: '摘要',
    tech: { mode: 'chase', close: 10.2, chase_score: 91, p_rs: 88, bias20: 0.1 },
  });
  assert.equal(row.symbol, '600001.SH');
  assert.equal(row.close, 10.2);
  assert.equal(row.score, 91);
  assert.equal(compactCandidate({ symbol: 'bad', tech: { close: 1 } }), null);
});

test('freezes candidate prices once and produces a file-based daily prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-snapshot-'));
  try {
    const store = new AgentLeagueStore({ root });
    const calls = [];
    const fakeHttp = async (_method, url) => {
      calls.push(url);
      if (url.includes('/overview')) return { ok: true, body: { compile_id: 'compile-1', header: { data_asof: '2026-08-25', sources_health: {} } } };
      if (url.includes('/candidates')) return { ok: true, body: { items: [{
        symbol: '600001.SH', name: '测试', state: 'new', summary: '摘要',
        tech: { mode: 'setup', close: 10, setup_score: 90 },
      }] } };
      throw new Error(`unexpected URL ${url}`);
    };
    const snapshot = await buildFrozenSnapshot({ store, httpJson: fakeHttp, requiredSymbols: new Set() });
    assert.equal(snapshot.asOf, '2026-08-25');
    assert.equal(snapshot.prices['600001.SH'].close, 10);
    assert.equal(fs.existsSync(path.join(root, 'snapshots', '2026-08-25.md')), true);
    const created = store.createAgent({
      id: 'wave-rider', name: '逐浪', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol',
      philosophy: { key: 'trend-confirmation', title: '右侧趋势确认', summary: '理念', edge: '优势' },
    });
    const prompt = buildDailyPrompt(created, snapshot, 'run-1');
    assert.match(prompt, /Run ID：run-1/);
    assert.match(prompt, /2026-08-25\.md/);
    assert.match(prompt, /```agent-league-decision/);
    assert.match(prompt, /不得读取其他 Agent/);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('IPC creates a visible ordinary Hub session and persists the reverse binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-ipc-'));
  try {
    const store = new AgentLeagueStore({ root });
    const ipc = {
      handlers: new Map(),
      handle(channel, fn) { this.handlers.set(channel, fn); },
    };
    const sessionManager = new EventEmitter();
    const sessions = new Map();
    sessionManager.createSession = (kind, opts) => {
      const session = {
        id: opts.id || 'hub-agent-1', kind, title: opts.title, cwd: opts.cwd,
        purpose: opts.purpose, hiddenFromSidebar: !!opts.hiddenFromSidebar,
        status: 'idle', currentModel: { id: opts.model },
      };
      sessions.set(session.id, session);
      return { ...session };
    };
    sessionManager.getSession = id => sessions.get(id);
    sessionManager.listSessions = () => [...sessions.values()];
    const transcriptTap = new EventEmitter();
    const sent = [];
    const bridge = registerAgentLeagueIpc(ipc, {
      store,
      sessionManager,
      transcriptTap,
      registerSessionForTap: session => sent.push({ channel: 'tap', session }),
      sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
      getHookPort: () => 0,
    });
    const created = ipc.handlers.get('agent-league:create')(null, {
      id: 'wave-rider', name: '逐浪', provider: 'codex-cli', model: 'gpt-5.6-sol',
      philosophyKey: 'trend-confirmation', initialCash: 1_000_000,
    });
    assert.equal(created.ok, true);
    assert.equal(created.session.purpose, 'agent-league');
    assert.equal(created.session.hiddenFromSidebar, false);
    assert.equal(store.getAgent('wave-rider').session.hubSessionId, 'hub-agent-1');
    assert.equal(sent.some((row) => row.channel === 'session-created'), true);
    transcriptTap.emit('session-bound', { hubSessionId: 'hub-agent-1', codexSid: 'native-codex-1' });
    assert.equal(store.getAgent('wave-rider').session.nativeSession.codexSid, 'native-codex-1');
    const listed = ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(listed.agents.length, 1);
    assert.equal(listed.agents[0].session.live, true);
    bridge.stopScheduler();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daily run queues ordinary sessions, parses decisions, and completes durably', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-run-'));
  try {
    const store = new AgentLeagueStore({ root });
    const philosophy = {
      key: 'trend-confirmation', title: '右侧趋势确认', summary: '只做确认趋势。', edge: '趋势延续。',
    };
    for (const [id, name] of [['wave-rider', '逐浪'], ['steady-hand', '守拙']]) {
      store.createAgent({ id, name, provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
    }
    const ipc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
    const transcriptTap = new EventEmitter();
    const sessionManager = new EventEmitter();
    const sessions = new Map();
    let nextId = 0;
    sessionManager.createSession = (kind, opts) => {
      const session = { id: opts.id || `hub-run-${++nextId}`, kind, cwd: opts.cwd, title: opts.title, purpose: opts.purpose, status: 'idle' };
      sessions.set(session.id, session);
      return { ...session };
    };
    sessionManager.getSession = id => sessions.get(id);
    sessionManager.listSessions = () => [...sessions.values()];
    const sentPrompts = [];
    const fakeHttp = async (_method, url) => {
      if (url.includes('/overview')) return { ok: true, body: { compile_id: 'c1', header: { data_asof: '2026-08-25', sources_health: {} } } };
      if (url.includes('/candidates')) return { ok: true, body: { items: [{
        symbol: '600001.SH', name: '测试股', state: 'new', summary: '摘要',
        tech: { mode: 'chase', close: 10, chase_score: 90 },
      }] } };
      throw new Error(`unexpected ${url}`);
    };
    const bridge = registerAgentLeagueIpc(ipc, {
      store,
      sessionManager,
      transcriptTap,
      getHookPort: () => 0,
      httpJson: fakeHttp,
      waitCliReady: async () => true,
      sendToPty: async (sessionId, prompt) => { sentPrompts.push({ sessionId, prompt }); return true; },
    });
    const started = await ipc.handlers.get('agent-league:run-day')(null, { trigger: 'test' });
    assert.equal(started.ok, true);
    for (let index = 0; index < 20 && sentPrompts.length < 2; index += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(sentPrompts.length, 2);
    const response = {
      run_id: started.run.runId,
      as_of: '2026-08-25',
      action_summary: '建立测试组合',
      market_view: '测试',
      cash_target: 0.7,
      targets: [{ symbol: '600001.SH', name: '测试股', target_weight: 0.3, conviction: 0.7, horizon_days: 10, thesis: '逻辑', invalidation: '失效' }],
      risk_notes: [],
      reflection: { kept: '纪律', mistake: '无', lesson_candidate: '测试经验', evidence_for: [], evidence_against: [] },
      strategy_proposal: null,
    };
    transcriptTap.emit('turn-complete', {
      hubSessionId: sentPrompts[0].sessionId,
      text: `完成\n\n\`\`\`agent-league-decision\n${JSON.stringify(response)}\n\`\`\``,
    });
    transcriptTap.emit('turn-complete', {
      hubSessionId: sentPrompts[1].sessionId,
      text: '这轮故意缺少结构化决策块',
    });
    await new Promise(resolve => setImmediate(resolve));
    let listed = ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(listed.schedule.lastRunStatus, 'partial');
    assert.equal(listed.agents.filter(agent => agent.portfolio.pendingDecision).length, 1);

    const retried = await ipc.handlers.get('agent-league:run-day')(null, { trigger: 'retry' });
    assert.equal(retried.ok, true);
    for (let index = 0; index < 20 && sentPrompts.length < 3; index += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(sentPrompts.length, 3, 'retry should only send the previously failed Agent');
    const retryResponse = { ...response, run_id: retried.run.runId };
    transcriptTap.emit('turn-complete', {
      hubSessionId: sentPrompts[2].sessionId,
      text: `完成\n\n\`\`\`agent-league-decision\n${JSON.stringify(retryResponse)}\n\`\`\``,
    });
    await new Promise(resolve => setImmediate(resolve));
    listed = ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(listed.run, null);
    assert.equal(listed.schedule.lastRunStatus, 'completed');
    assert.equal(store.currentRunLease(), null);
    assert.equal(listed.agents.every(agent => agent.portfolio.pendingDecision && agent.portfolio.pendingDecision.decisionAsOf === '2026-08-25'), true);
    assert.equal(store.getDaily('wave-rider', '2026-08-25').status, 'decision-queued');
    bridge.stopScheduler();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
