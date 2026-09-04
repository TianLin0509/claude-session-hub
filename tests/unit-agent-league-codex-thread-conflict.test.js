'use strict';

// 联赛席位撞上 Codex thread writer 占用时的行为（2026-09-04）。
//
// 真实故障：2026-09-02/03/04 连续三天，两个 Codex 席位每天都在 draft 阶段
// technical-forfeit，last_error 全是「codex-cli CLI 在 120 秒内未就绪」——
// 别的进程还攥着同一个 thread 的写者位，`codex resume <sid>` 起不来，
// 于是干等满 120 秒就绪预算。已知被占用就不该去撞。

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentLeagueStore } = require('../core/agent-league-store.js');
const { getPhilosophy } = require('../core/agent-league-philosophies.js');
const { registerAgentLeagueIpc } = require('../main/ipc/agent-league-handlers.js');

const baseline = getPhilosophy('chuxin-value-speculation');
const OCCUPIED_SID = '01a05397-7f2b-7d61-8270-040765f51db1';

function fakeMarketHttp() {
  return async (_method, url) => {
    if (url.includes('/observe/overview')) {
      return { ok: true, body: { compile_id: 'compile-1', header: { data_asof: '2026-08-26', sources_health: {} } } };
    }
    if (url.includes('/observe/candidates')) {
      return { ok: true, body: { items: [{
        symbol: '600001.SH', name: '测试股', state: 'new', summary: '摘要',
        tech: { mode: 'chase', close: 10, chase_score: 90 },
      }] } };
    }
    if (url.includes('/api/market/600001.SH/dashboard')) {
      return { ok: true, body: {
        identity: { symbol: '600001.SH', name: '测试股' },
        quote: { symbol: '600001.SH', name: '测试股', price: 10.5, previous_close: 10, open: 10.2, quote_at: '2026-08-27T15:01:00+08:00', source: 'fixture', confidence: 'cross_checked' },
        daily: { bars: [{ date: '2026-08-26', open: 9.8, close: 10, name: '测试股' }] },
      } };
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function makeHarness(root, extraDeps = {}) {
  const store = new AgentLeagueStore({ root });
  const ipc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
  const transcriptTap = new EventEmitter();
  const sessionManager = new EventEmitter();
  const sessions = new Map();
  const createdOptions = [];
  let nextId = 0;
  sessionManager.createSession = (kind, opts) => {
    createdOptions.push({ kind, opts: { ...opts } });
    const session = {
      id: opts.id || `hub-agent-${++nextId}`, kind, cwd: opts.cwd, title: opts.title,
      purpose: opts.purpose, status: 'idle', currentModel: { id: opts.model },
    };
    sessions.set(session.id, session);
    return { ...session };
  };
  sessionManager.getSession = (id) => sessions.get(id);
  sessionManager.listSessions = () => [...sessions.values()];
  sessionManager.closeSession = (id) => sessions.delete(id);
  sessionManager.writeToSession = () => {};
  const bridge = registerAgentLeagueIpc(ipc, {
    store, sessionManager, transcriptTap, getHookPort: () => 0, httpJson: fakeMarketHttp(),
    schedulerElectionEnabled: false,
    waitCliReady: async () => true,
    sendToPty: async () => true,
    ...extraDeps,
  });
  return { store, ipc, sessionManager, createdOptions, bridge };
}

// 席位有历史 codexSid，但它的 Hub 会话已经不在了 —— 正是会走 `codex resume` 的那条路。
function seedDormantCodexAgent(store) {
  store.createAgent({
    id: 'codex-seat', name: 'Codex Seat', provider: 'codex-cli', kind: 'codex',
    model: 'gpt-5.6-sol', philosophy: baseline,
  });
  store.bindSession('codex-seat', {
    hubSessionId: 'hub-gone-with-old-hub', status: 'restorable',
    nativeSession: { codexSid: OCCUPIED_SID },
  });
}

async function runDayWith(root, findCodexThreadWriters) {
  const harness = makeHarness(root, { findCodexThreadWriters });
  try {
    seedDormantCodexAgent(harness.store);
    await harness.ipc.handlers.get('agent-league:run-day')(null, {
      trigger: 'test', force: true, decisionDate: '2026-08-27',
    });
    const created = harness.createdOptions.filter((row) => row.kind === 'codex');
    assert.equal(created.length, 1, '应该正好为这个席位建了一个 Codex 会话');
    return created[0].opts;
  } finally {
    harness.bridge.stopScheduler();
  }
}

test('an occupied Codex thread makes the seat start fresh instead of waiting out the readiness budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-thread-conflict-'));
  try {
    let askedFor = null;
    const opts = await runDayWith(root, async (sids) => {
      askedFor = sids;
      return new Map([[OCCUPIED_SID, [{ pid: 40496, cmd: `codex.exe resume ${OCCUPIED_SID}` }]]]);
    });
    assert.deepEqual(askedFor, [OCCUPIED_SID], '应该拿这个席位的 sid 去探占用');
    assert.equal(opts.useResume, undefined, '被占用时不能再发 codex resume');
    assert.equal(opts.codexSid, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a free Codex thread still resumes exactly as before', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-thread-free-'));
  try {
    const opts = await runDayWith(root, async () => new Map());
    assert.equal(opts.useResume, true, '没被占用就必须照旧 resume，不能白丢上下文');
    assert.equal(opts.codexSid, OCCUPIED_SID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing probe degrades to the old behaviour rather than forcing fresh sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-thread-probe-fail-'));
  try {
    const opts = await runDayWith(root, async () => { throw new Error('probe exploded'); });
    assert.equal(opts.useResume, true);
    assert.equal(opts.codexSid, OCCUPIED_SID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
