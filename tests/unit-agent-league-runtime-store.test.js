'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentLeagueRuntimeStore } = require('../core/agent-league-runtime-store.js');

function withStores(work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-runtime-'));
  const first = new AgentLeagueRuntimeStore({ root, leagueId: 'league-test' });
  const second = new AgentLeagueRuntimeStore({ root, leagueId: 'league-test' });
  try { return work({ root, first, second }); }
  finally {
    first.close();
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('transactional leader election increments epoch and fences a stale owner', () => withStores(({ first, second }) => {
  const acquired = first.claimLeadership({ ownerId: 'hub-a', ownerPid: 101, ownerHub: 'data-a', ownerVersion: '1.7.0' }, { nowMs: 1_000, ttlMs: 100 });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.lease.epoch, 1);
  assert.equal(second.claimLeadership({ ownerId: 'hub-b', ownerPid: 202 }, { nowMs: 1_050, ttlMs: 100 }).ok, false);
  assert.equal(first.renewLeadership(acquired.lease, { nowMs: 1_060, ttlMs: 100 }), true);
  const takeover = second.claimLeadership({ ownerId: 'hub-b', ownerPid: 202, ownerHub: 'data-b', ownerVersion: '1.7.0' }, { nowMs: 1_161, ttlMs: 100 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.lease.epoch, 2);
  assert.equal(first.assertLeadership(acquired.lease, { nowMs: 1_162 }), false);
  assert.equal(second.assertLeadership(takeover.lease, { nowMs: 1_162 }), true);
  assert.equal(first.releaseLeadership(acquired.lease, { nowMs: 1_163 }), false);
  assert.equal(second.releaseLeadership(takeover.lease, { nowMs: 1_164 }), true);
}));

test('run identity is deterministic and refuses the same key with different frozen inputs', () => withStores(({ first }) => {
  const leader = first.claimLeadership({ ownerId: 'hub-a' }, { nowMs: 2_000, ttlMs: 1_000 }).lease;
  const input = {
    runKey: 'decision:2026-09-01',
    phase: 'decision',
    decisionDate: '2026-09-01',
    snapshotId: 'snapshot-a',
    participants: ['trend-rider', 'chuxin-baseline', 'trend-rider'],
    manifest: { strategyHashes: { 'trend-rider': 't1', 'chuxin-baseline': 'b1' } },
  };
  const created = first.ensureRun(input, leader, { nowMs: 2_010 });
  assert.equal(created.created, true);
  assert.deepEqual(created.run.manifest.participants, ['chuxin-baseline', 'trend-rider']);
  assert.equal(first.listTasks(input.runKey).length, 2);
  assert.equal(first.ensureRun(input, leader, { nowMs: 2_020 }).created, false);
  const extended = first.ensureTasks(input.runKey, [{ agentId: 'chuxin-avatar', stage: 'draft' }], leader, { nowMs: 2_025 });
  assert.deepEqual(extended.created, [`${input.runKey}:agent:chuxin-avatar`]);
  assert.deepEqual(extended.run.manifest.participants, ['chuxin-avatar', 'chuxin-baseline', 'trend-rider']);
  assert.equal(first.ensureTasks(input.runKey, ['chuxin-avatar'], leader, { nowMs: 2_026 }).created.length, 0);
  assert.throws(
    () => first.ensureRun({ ...input, snapshotId: 'snapshot-b' }, leader, { nowMs: 2_030 }),
    error => error && error.code === 'run-input-conflict',
  );
}));

test('takeover preserves a committed DRAFT checkpoint and resumes from Hook', () => withStores(({ first, second }) => {
  const leaderA = first.claimLeadership({ ownerId: 'hub-a' }, { nowMs: 3_000, ttlMs: 100 }).lease;
  const runKey = 'decision:2026-09-01';
  first.ensureRun({
    runKey,
    phase: 'decision',
    decisionDate: '2026-09-01',
    snapshotId: 'snapshot-a',
    participants: ['trend-rider'],
  }, leaderA, { nowMs: 3_001 });
  const taskKey = `${runKey}:agent:trend-rider`;
  const draftAttempt = first.claimTask(taskKey, leaderA, { nowMs: 3_002, ttlMs: 100 });
  first.checkpointTask(taskKey, draftAttempt.attempt.attemptId, {
    kind: 'draft',
    draft: { cash_target: 0.5, targets: [] },
    targetContexts: {},
  }, leaderA, { nowMs: 3_010, nextStage: 'hook' });
  const hookAttempt = first.claimTask(taskKey, leaderA, { nowMs: 3_011, ttlMs: 100 });
  assert.equal(hookAttempt.attempt.stage, 'hook');

  const leaderB = second.claimLeadership({ ownerId: 'hub-b' }, { nowMs: 3_101, ttlMs: 100 }).lease;
  const recovered = second.recoverOrphanedTasks(leaderB, { nowMs: 3_102 });
  assert.equal(recovered.length, 1);
  const preserved = second.getTask(taskKey);
  assert.equal(preserved.status, 'pending');
  assert.equal(preserved.stage, 'hook');
  assert.equal(preserved.checkpoint.kind, 'draft');

  assert.throws(
    () => first.checkpointTask(taskKey, hookAttempt.attempt.attemptId, { kind: 'final' }, leaderA, { nowMs: 3_103, terminal: true }),
    error => error && error.code === 'stale-leader-lease',
  );
  const resumedHook = second.claimTask(taskKey, leaderB, { nowMs: 3_104, ttlMs: 100 });
  assert.equal(resumedHook.attempt.stage, 'hook');
  const completed = second.checkpointTask(taskKey, resumedHook.attempt.attemptId, {
    kind: 'final', verdict: 'PASS', decision: { cash_target: 1, targets: [] },
  }, leaderB, { nowMs: 3_105, nextStage: 'complete', terminal: true });
  assert.equal(completed.status, 'completed');
  assert.equal(second.getRun(runKey).status, 'completed');
  assert.deepEqual(
    second.listEvents(runKey).filter(row => row.eventType === 'task-orphan-recovered').map(row => row.payload.preservedStage),
    ['hook'],
  );
}));

test('effects are effectively-once and conflicting reuse of an idempotency key is rejected', () => withStores(({ first }) => {
  const leader = first.claimLeadership({ ownerId: 'hub-a' }, { nowMs: 4_000, ttlMs: 1_000 }).lease;
  const runKey = 'open:2026-09-01';
  first.ensureRun({
    runKey,
    phase: 'open',
    decisionDate: '2026-09-01',
    snapshotId: 'open-a',
    participants: ['trend-rider'],
    initialStage: 'open',
  }, leader, { nowMs: 4_001 });
  const effect = {
    effectKey: '2026-09-01:open:trend-rider:300171.SZ:r1',
    runKey,
    effectType: 'open-trade',
    payload: { symbol: '300171.SZ', quantity: 6500, price: 15.17 },
    result: { tradeId: 'trade-1' },
  };
  const prepared = first.prepareEffect(effect, leader, { nowMs: 4_002 });
  assert.equal(prepared.created, true);
  assert.equal(prepared.effect.status, 'prepared');
  let appliedCount = 0;
  const completed = first.completeEffect(effect.effectKey, {}, leader, {
    nowMs: 4_003,
    beforeCommit: () => { appliedCount += 1; return effect.result; },
  });
  assert.equal(completed.effect.status, 'applied');
  assert.equal(appliedCount, 1);
  assert.equal(first.recordEffect(effect, leader, { nowMs: 4_004 }).created, false);
  assert.equal(appliedCount, 1);
  assert.equal(first.getEffect(effect.effectKey).result.tradeId, 'trade-1');
  assert.throws(
    () => first.recordEffect({ ...effect, payload: { ...effect.payload, price: 15.18 } }, leader, { nowMs: 4_005 }),
    error => error && error.code === 'effect-key-conflict',
  );
}));

test('a crash after an external effect leaves a prepared record that can be reconciled', () => withStores(({ first }) => {
  const leader = first.claimLeadership({ ownerId: 'hub-a' }, { nowMs: 4_100, ttlMs: 1_000 }).lease;
  const runKey = 'open:2026-09-03';
  first.ensureRun({
    runKey,
    phase: 'open',
    decisionDate: '2026-09-03',
    snapshotId: 'open-c',
    participants: ['trend-rider'],
    initialStage: 'open',
  }, leader, { nowMs: 4_101 });
  const effect = {
    effectKey: `${runKey}:agent:trend-rider`,
    runKey,
    effectType: 'open-settlement',
    payload: { agentId: 'trend-rider', snapshotId: 'open-c' },
  };
  first.prepareEffect(effect, leader, { nowMs: 4_102 });
  let externalWrites = 0;
  assert.throws(() => first.completeEffect(effect.effectKey, {}, leader, {
    nowMs: 4_103,
    beforeCommit: () => {
      externalWrites += 1;
      throw new Error('simulated crash after external write');
    },
  }), /simulated crash/);
  assert.equal(first.getEffect(effect.effectKey).status, 'prepared');
  const reconciled = first.completeEffect(effect.effectKey, {}, leader, {
    nowMs: 4_104,
    beforeCommit: () => ({ recovered: true, externalWrites }),
  });
  assert.equal(reconciled.effect.status, 'applied');
  assert.equal(reconciled.effect.result.recovered, true);
  assert.equal(externalWrites, 1);
}));

test('retryable failure keeps the current stage while terminal failure becomes technical forfeit', () => withStores(({ first }) => {
  const leader = first.claimLeadership({ ownerId: 'hub-a' }, { nowMs: 5_000, ttlMs: 1_000 }).lease;
  const runKey = 'decision:2026-09-02';
  first.ensureRun({
    runKey,
    phase: 'decision',
    decisionDate: '2026-09-02',
    snapshotId: 'snapshot-b',
    participants: ['chuxin-baseline'],
  }, leader, { nowMs: 5_001 });
  const taskKey = `${runKey}:agent:chuxin-baseline`;
  const firstAttempt = first.claimTask(taskKey, leader, { nowMs: 5_002 });
  const retryable = first.failTask(taskKey, firstAttempt.attempt.attemptId, new Error('provider timeout'), leader, { nowMs: 5_003 });
  assert.equal(retryable.status, 'pending');
  assert.equal(retryable.stage, 'draft');
  const secondAttempt = first.claimTask(taskKey, leader, { nowMs: 5_004 });
  const terminal = first.failTask(taskKey, secondAttempt.attempt.attemptId, new Error('retry budget exhausted'), leader, { nowMs: 5_005, terminal: true });
  assert.equal(terminal.status, 'technical-forfeit');
  assert.equal(first.getRun(runKey).status, 'failed');
  const reopened = first.reopenTechnicalForfeits(runKey, ['chuxin-baseline'], leader, { nowMs: 5_006 });
  assert.deepEqual(reopened.reopened, ['chuxin-baseline']);
  assert.equal(first.getTask(taskKey).status, 'pending');
  assert.equal(first.stageAttemptCount(taskKey, 'draft'), 0, 'manual retry gets a fresh stage budget without deleting audit attempts');
  assert.equal(first.quickCheck().ok, true);
}));
