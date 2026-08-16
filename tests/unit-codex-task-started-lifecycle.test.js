'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CodexTap } = require('../core/transcript-tap.js');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout.js');

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('timed out waiting for Codex lifecycle event');
}

test('Codex task_started emits a running lifecycle event without user_message', async () => {
  const tempRoot = path.join(os.tmpdir(), `hub-codex-task-started-${process.pid}-${Date.now()}`);
  const sessionsRoot = path.join(tempRoot, 'sessions');
  const cwd = path.join(tempRoot, 'workspace');
  const hubSessionId = 'hub-goal-continuation';
  const codexSid = '019ff492-0e1b-7bf2-ab10-b58b4b7bd6b5';
  const turnId = 'c894ebe0-04c5-444c-9878-9e8df7e241d9';
  const startedAt = new Date('2026-08-12T06:07:10.127Z');
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 30 });
  const rollout = new FakeCodexRollout({ sessionsRoot, cwd, sid: codexSid });
  const started = [];
  const aborted = [];
  const prompts = [];

  try {
    fs.mkdirSync(cwd, { recursive: true });
    await rollout.start();
    tap.on('turn-started', event => started.push(event));
    tap.on('turn-aborted', event => aborted.push(event));
    tap.on('prompt-submitted', event => prompts.push(event));

    const bound = new Promise(resolve => tap.once('session-bound', resolve));
    tap.registerSession(hubSessionId, {
      cwd,
      transcriptPath: rollout.rolloutPath,
    });
    await bound;
    await rollout.writeRaw({
      timestamp: startedAt.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        started_at: Math.floor(startedAt.getTime() / 1000),
      },
    });

    await waitFor(() => started.length === 1);
    assert.equal(prompts.length, 0, 'automatic goal continuation must not fabricate a user prompt');
    assert.deepEqual(started[0], {
      hubSessionId,
      transcriptPath: rollout.rolloutPath,
      startedAt: startedAt.getTime(),
      turnId,
      signalSource: 'task_started',
    });

    const abortedAt = new Date(startedAt.getTime() + 2500);
    await rollout.writeRaw({
      timestamp: abortedAt.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'turn_aborted',
        turn_id: turnId,
        completed_at: Math.floor(abortedAt.getTime() / 1000),
      },
    });
    await waitFor(() => aborted.length === 1);
    assert.deepEqual(aborted[0], {
      hubSessionId,
      transcriptPath: rollout.rolloutPath,
      abortedAt: abortedAt.getTime(),
      turnId,
      signalSource: 'turn_aborted',
    });
  } finally {
    tap.unregisterSession(hubSessionId);
    await rollout.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});
