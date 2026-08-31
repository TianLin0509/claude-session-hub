'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentLeagueRuntimeStore } = require('../core/agent-league-runtime-store.js');

const workerPath = path.join(__dirname, 'fixtures', 'agent-league-runtime-worker.js');

function startWorker(root, ownerId) {
  const child = fork(workerPath, [root, ownerId], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); });
  let nextId = 0;
  const pending = new Map();
  child.on('message', (message = {}) => {
    if (message.ready) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ownerId} ready timeout`)), 5000);
    child.on('message', (message = {}) => {
      if (!message.ready) return;
      clearTimeout(timer);
      resolve(message);
    });
    child.once('exit', code => reject(new Error(`${ownerId} exited before ready: ${code}\n${stderr}`)));
  });
  const call = (command, args = {}) => new Promise((resolve, reject) => {
    const id = `${ownerId}-${++nextId}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${ownerId}:${command} timeout`));
    }, 5000);
    pending.set(id, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
    });
    child.send({ id, command, args });
  });
  return { child, ready, call, stderr: () => stderr };
}

test('real processes elect one writer, adopt the orphan, and fence the resurrected owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-multiprocess-'));
  const first = startWorker(root, 'hub-a');
  const second = startWorker(root, 'hub-b');
  try {
    await Promise.all([first.ready, second.ready]);
    const firstClaim = await first.call('claim', { ttlMs: 180 });
    assert.equal(firstClaim.ok, true);
    assert.equal(firstClaim.value.ok, true);
    assert.equal(firstClaim.value.lease.epoch, 1);
    const losingClaim = await second.call('claim', { ttlMs: 1000 });
    assert.equal(losingClaim.value.ok, false);
    assert.equal(losingClaim.value.reason, 'busy');

    const runKey = 'live:decision:2026-09-04';
    const started = await first.call('start-task', { runKey, decisionDate: '2026-09-04', taskTtlMs: 180 });
    assert.equal(started.value.ok, true);
    const staleAttemptId = started.value.attempt.attemptId;
    await new Promise(resolve => setTimeout(resolve, 230));

    const takeover = await second.call('claim', { ttlMs: 1000 });
    assert.equal(takeover.value.ok, true);
    assert.equal(takeover.value.lease.epoch, 2);
    const recovered = await second.call('recover');
    assert.equal(recovered.value.length, 1);
    assert.equal(recovered.value[0].stage, 'draft');

    const staleWrite = await first.call('checkpoint', {
      taskKey: `${runKey}:agent:agent-a`,
      attemptId: staleAttemptId,
      checkpoint: { kind: 'draft', source: 'stale-owner' },
      nextStage: 'hook',
    });
    assert.equal(staleWrite.ok, false);
    assert.equal(staleWrite.code, 'stale-leader-lease');

    const adopted = await second.call('claim-task', { taskKey: `${runKey}:agent:agent-a`, taskTtlMs: 1000 });
    assert.equal(adopted.value.ok, true);
    const completed = await second.call('checkpoint', {
      taskKey: `${runKey}:agent:agent-a`,
      attemptId: adopted.value.attempt.attemptId,
      checkpoint: { kind: 'final', source: 'successor' },
      nextStage: 'complete',
      terminal: true,
    });
    assert.equal(completed.value.status, 'completed');

    await Promise.all([first.call('close'), second.call('close')]);
    const audit = new AgentLeagueRuntimeStore({ root, leagueId: 'multiprocess-test' });
    assert.equal(audit.getRun(runKey).status, 'completed');
    assert.equal(audit.getTask(`${runKey}:agent:agent-a`).checkpoint.source, 'successor');
    assert.equal(audit.listEvents(runKey).filter((row) => row.eventType === 'task-orphan-recovered').length, 1);
    audit.close();
  } finally {
    for (const worker of [first, second]) {
      if (worker.child.exitCode == null) worker.child.kill();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
