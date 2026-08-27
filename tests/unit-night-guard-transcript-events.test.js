'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexTap, TranscriptTap } = require('../core/transcript-tap.js');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout.js');

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for night guard transcript event');
}

test('CodexTap exposes /goal lifecycle and task_complete network errors with turn identity', async () => {
  const root = path.join(os.tmpdir(), `hub-night-guard-tap-${process.pid}-${Date.now()}`);
  const sessionsRoot = path.join(root, 'sessions');
  const cwd = path.join(root, 'workspace');
  const sid = '11111111-1111-4111-8111-111111111111';
  const hubSessionId = 'hub-night-guard';
  const turnId = 'turn-night-guard';
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 25 });
  const rollout = new FakeCodexRollout({ sessionsRoot, cwd, sid, cliVersion: '0.147.0' });
  const goals = [];
  const prompts = [];
  const failures = [];
  try {
    fs.mkdirSync(cwd, { recursive: true });
    await rollout.start();
    tap.on('goal-updated', event => goals.push(event));
    tap.on('prompt-submitted', event => prompts.push(event));
    tap.on('turn-failed', event => failures.push(event));
    const bound = new Promise(resolve => tap.once('session-bound', resolve));
    tap.registerSession(hubSessionId, { cwd, transcriptPath: rollout.rolloutPath });
    await bound;

    const activeAt = new Date();
    await rollout.writeRaw({
      timestamp: activeAt.toISOString(), type: 'event_msg',
      payload: { type: 'thread_goal_updated', turn_id: turnId, goal: { objective: 'finish overnight', status: 'active' } },
    });
    await rollout.writeRaw({
      timestamp: new Date(activeAt.getTime() + 100).toISOString(), type: 'event_msg',
      payload: {
        type: 'task_complete', turn_id: turnId,
        error: { message: 'stream disconnected before completion: ECONNRESET', codex_error_info: 'other' },
      },
    });
    await waitFor(() => goals.length === 1 && prompts.length === 1 && failures.length === 1);
    assert.equal(goals[0].status, 'active');
    assert.equal(prompts[0].signalSource, 'thread_goal_updated');
    assert.equal(failures[0].turnId, turnId);
    assert.match(failures[0].message, /stream disconnected before completion/i);

    await rollout.writeRaw({
      timestamp: new Date(activeAt.getTime() + 200).toISOString(), type: 'event_msg',
      payload: { type: 'thread_goal_updated', turn_id: turnId, goal: { objective: 'finish overnight', status: 'completed' } },
    });
    await waitFor(() => goals.length === 2);
    assert.equal(goals[1].status, 'completed');
  } finally {
    tap.unregisterSession(hubSessionId);
    await rollout.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('TranscriptTap forwards night guard lifecycle from its Codex backend', () => {
  const tap = new TranscriptTap();
  const goals = [];
  const failures = [];
  tap.on('goal-updated', event => goals.push(event));
  tap.on('turn-failed', event => failures.push(event));
  tap._codex.emit('goal-updated', { hubSessionId: 's1', status: 'completed' });
  tap._codex.emit('turn-failed', { hubSessionId: 's1', message: 'stream disconnected' });
  assert.equal(goals.length, 1);
  assert.equal(failures.length, 1);
  tap.dispose();
});
