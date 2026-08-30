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

test('Codex 0.147 final_answer item emits turn-complete', async () => {
  const tempRoot = path.join(os.tmpdir(), `hub-codex-final-answer-${process.pid}-${Date.now()}`);
  const sessionsRoot = path.join(tempRoot, 'sessions');
  const cwd = path.join(tempRoot, 'workspace');
  const hubSessionId = 'hub-final-answer';
  const codexSid = '019ff492-0e1b-7bf2-ab10-b58b4b7bd6b6';
  const turnId = 'c894ebe0-04c5-444c-9878-9e8df7e241e0';
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 30 });
  const rollout = new FakeCodexRollout({ sessionsRoot, cwd, sid: codexSid, cliVersion: '0.147.0' });
  const completed = [];

  try {
    fs.mkdirSync(cwd, { recursive: true });
    await rollout.start();
    tap.on('turn-complete', event => completed.push(event));
    const bound = new Promise(resolve => tap.once('session-bound', resolve));
    tap.registerSession(hubSessionId, { cwd, transcriptPath: rollout.rolloutPath });
    await bound;

    const at = new Date();
    await rollout.writeRaw({
      timestamp: at.toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId },
    });
    await rollout.writeRaw({
      timestamp: new Date(at.getTime() + 100).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: turnId,
        item: {
          type: 'AgentMessage',
          id: 'commentary-0147',
          content: [{ type: 'text', text: '处理中间结果' }],
          phase: 'commentary',
        },
        started_at_ms: at.getTime() + 50,
        completed_at_ms: at.getTime() + 100,
      },
    });
    await rollout.writeRaw({
      timestamp: new Date(at.getTime() + 500).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: turnId,
        item: {
          type: 'AgentMessage',
          id: 'final-0147',
          content: [{ type: 'text', text: '最终完成' }],
          phase: 'final_answer',
        },
        started_at_ms: at.getTime() + 200,
        completed_at_ms: at.getTime() + 500,
      },
    });

    await waitFor(() => completed.length === 1);
    assert.equal(completed[0].hubSessionId, hubSessionId);
    assert.equal(completed[0].text, '最终完成');
    assert.equal(completed[0].turnId, turnId);
    assert.equal(completed[0].durationMs, 300);
    assert.equal(completed[0].signalSource, 'item_completed_agent_message_final_answer');
  } finally {
    tap.unregisterSession(hubSessionId);
    await rollout.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex task_complete.error emits one live turn-error and skips historical failures on bind', async () => {
  const tempRoot = path.join(os.tmpdir(), `hub-codex-turn-error-${process.pid}-${Date.now()}`);
  const sessionsRoot = path.join(tempRoot, 'sessions');
  const cwd = path.join(tempRoot, 'workspace');
  const hubSessionId = 'hub-turn-error';
  const codexSid = '019ff492-0e1b-7bf2-ab10-b58b4b7bd6b7';
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 30 });
  const rollout = new FakeCodexRollout({ sessionsRoot, cwd, sid: codexSid, cliVersion: '0.147.0' });
  const errors = [];

  try {
    fs.mkdirSync(cwd, { recursive: true });
    await rollout.start();
    const oldAt = new Date(Date.now() - 60_000);
    await rollout.writeRaw({
      timestamp: oldAt.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'old-failure',
        error: { message: 'stream disconnected before completion: ECONNRESET', codex_error_info: 'other' },
      },
    });

    tap.on('turn-error', event => errors.push(event));
    const bound = new Promise(resolve => tap.once('session-bound', resolve));
    tap.registerSession(hubSessionId, { cwd, transcriptPath: rollout.rolloutPath });
    await bound;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(errors.length, 0, 'historical failure in the hydrated suffix must not notify again');

    const failedAt = new Date();
    const turnId = 'live-failure';
    await rollout.writeRaw({
      timestamp: new Date(failedAt.getTime() - 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId },
    });
    await rollout.writeRaw({
      timestamp: failedAt.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        duration_ms: 100,
        error: { message: 'stream disconnected before completion: ECONNRESET', codex_error_info: 'other' },
      },
    });

    await waitFor(() => errors.length === 1);
    assert.deepEqual(errors[0], {
      hubSessionId,
      transcriptPath: rollout.rolloutPath,
      message: 'stream disconnected before completion: ECONNRESET',
      completedAt: failedAt.getTime(),
      durationMs: 100,
      turnId,
      errorInfo: 'other',
      occurrenceId: `${turnId}:${failedAt.getTime()}`,
      signalSource: 'task_complete_error',
    });
  } finally {
    tap.unregisterSession(hubSessionId);
    await rollout.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});
