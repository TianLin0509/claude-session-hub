'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const {
  evaluateAgentLeagueSchedulerSafety,
} = require('../core/agent-league-scheduler-safety.js');
const {
  buildFrozenSnapshot,
  registerAgentLeagueIpc,
  registerAgentLeagueRuntime,
} = require('../main/ipc/agent-league-handlers.js');

function fakeIpc() {
  return { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
}

test('isolated Hub auto scheduler can only drive a contained vault unless explicitly allowed', () => {
  const dataDir = 'C:\\temp\\hub-isolated';
  const contained = evaluateAgentLeagueSchedulerSafety({
    env: { CLAUDE_HUB_DATA_DIR: dataDir },
    leagueRoot: path.join(dataDir, 'agent-league'),
  });
  assert.equal(contained.allowed, true);
  assert.equal(contained.reason, 'isolated-vault-contained');

  const external = evaluateAgentLeagueSchedulerSafety({
    env: { CLAUDE_HUB_DATA_DIR: dataDir },
    leagueRoot: 'C:\\Users\\lintian\\chuxin-research\\vault\\agent-league',
  });
  assert.equal(external.allowed, false);
  assert.equal(external.reason, 'isolated-external-vault-blocked');

  const override = evaluateAgentLeagueSchedulerSafety({
    env: {
      CLAUDE_HUB_DATA_DIR: dataDir,
      CHUXIN_AGENT_LEAGUE_ALLOW_EXTERNAL_SCHEDULER: '1',
    },
    leagueRoot: external.leagueRoot,
  });
  assert.equal(override.allowed, true);
  assert.equal(override.explicitlyAllowed, true);

  const production = evaluateAgentLeagueSchedulerSafety({
    env: {},
    leagueRoot: external.leagueRoot,
  });
  assert.equal(production.allowed, true);
  assert.equal(production.reason, 'production-hub');
});

test('wrapper suppresses automatic scheduling for an isolated Hub aimed at an external vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-safety-wrapper-'));
  try {
    const dataDir = path.join(root, 'isolated', 'hub-data');
    const leagueRoot = path.join(root, 'external-league');
    const store = new AgentLeagueStore({ root: leagueRoot });
    store.saveSchedule({ ...store.getSchedule(), lastRunStatus: 'running' });
    const ipc = fakeIpc();
    const bridge = registerAgentLeagueIpc(ipc, {
      store,
      env: { CLAUDE_HUB_DATA_DIR: dataDir },
      enableVirtualDebug: false,
    });
    const listed = ipc.handlers.get('agent-league:list')(null, {});
    assert.equal(bridge.schedulerSafety.allowed, false);
    assert.equal(listed.schedulerRuntime.started, false);
    assert.equal(listed.schedulerRuntime.safety.reason, 'isolated-external-vault-blocked');
    assert.equal(store.getSchedule().lastRunStatus, 'running', 'suppressed startup must not repair/write the external schedule');
    assert.equal(bridge.startScheduler(), null, 'suppressed runtime cannot be started later by accident');
    bridge.stopScheduler();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('decision snapshot rejects T-2 data before freezing any candidate file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-freshness-'));
  try {
    const store = new AgentLeagueStore({ root });
    const request = async (_method, url) => {
      if (url.includes('/observe/overview')) {
        return { ok: true, body: { compile_id: 'stale', header: { data_asof: '2026-08-25', sources_health: {} } } };
      }
      throw new Error(`candidate endpoint must not be called for stale overview: ${url}`);
    };
    await assert.rejects(
      buildFrozenSnapshot({
        store,
        httpJson: request,
        decisionFor: '2026-08-27',
        expectedAsOf: '2026-08-26',
      }),
      error => error && error.code === 'stale-decision-snapshot'
        && error.expectedAsOf === '2026-08-26'
        && error.actualAsOf === '2026-08-25',
    );
    assert.equal(fs.existsSync(path.join(root, 'snapshots', '2026-08-27-decision.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('open and close phases respect the same cross-Hub lease and always release it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-phase-lease-'));
  try {
    const store = new AgentLeagueStore({ root });
    const ipc = fakeIpc();
    const bridge = registerAgentLeagueRuntime(ipc, {
      store,
      autoStartScheduler: false,
      buildPriceSnapshot: async () => ({
        schemaVersion: 2,
        snapshotId: 'fixture',
        decisionFor: '2026-08-27',
        asOf: '2026-08-27',
        phase: 'close',
        prices: {},
      }),
    });

    const held = store.claimRunLease({ ownerHub: 'other-hub', runId: 'decision-other-hub' });
    assert.equal(held.ok, true);
    const openBusy = await ipc.handlers.get('agent-league:execute-open')(null, {
      force: true, decisionDate: '2026-08-27',
    });
    const closeBusy = await ipc.handlers.get('agent-league:record-close')(null, {
      force: true, decisionDate: '2026-08-27',
    });
    assert.equal(openBusy.error, 'phase-busy-elsewhere');
    assert.equal(closeBusy.error, 'phase-busy-elsewhere');
    assert.equal(openBusy.lease.runId, 'decision-other-hub');
    store.releaseRunLease(held.token);

    const openEmpty = await ipc.handlers.get('agent-league:execute-open')(null, {
      force: true, decisionDate: '2026-08-27',
    });
    assert.equal(openEmpty.ok, true);
    assert.equal(openEmpty.alreadyRun, true);
    assert.equal(store.currentRunLease(), null, 'no-op open still releases the phase lease');

    bridge.stopScheduler();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase lease releases even when market snapshot construction throws', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-phase-error-'));
  try {
    const store = new AgentLeagueStore({ root });
    const ipc = fakeIpc();
    const bridge = registerAgentLeagueRuntime(ipc, {
      store,
      autoStartScheduler: false,
      buildPriceSnapshot: async () => { throw new Error('fixture market unavailable'); },
    });
    const result = await ipc.handlers.get('agent-league:record-close')(null, {
      force: true, decisionDate: '2026-08-27',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /fixture market unavailable/);
    assert.equal(store.currentRunLease(), null);
    bridge.stopScheduler();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
