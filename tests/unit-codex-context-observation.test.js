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
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('timed out waiting for context-window observation');
}

test('CodexTap reports model_context_window separately and deduplicates unchanged values', async () => {
  const tempRoot = path.join(os.tmpdir(), `hub-codex-context-${process.pid}-${Date.now()}`);
  const sessionsRoot = path.join(tempRoot, 'sessions');
  const cwd = path.join(tempRoot, 'workspace');
  const hubSessionId = 'hub-context-observation';
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 30 });
  const rollout = new FakeCodexRollout({
    sessionsRoot,
    cwd,
    sid: '01a02fc6-7af0-7db1-922a-52472e1b817d',
  });
  const observations = [];

  try {
    fs.mkdirSync(cwd, { recursive: true });
    await rollout.start();
    tap.on('context-window-observed', event => observations.push(event));
    const bound = new Promise(resolve => tap.once('session-bound', resolve));
    tap.registerSession(hubSessionId, { cwd, transcriptPath: rollout.rolloutPath });
    await bound;

    const observedAt = new Date('2026-08-23T18:00:00.000Z');
    const tokenCount = max => rollout.writeRaw({
      timestamp: observedAt.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: max,
          last_token_usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    });
    await tokenCount(828_400);
    await waitFor(() => observations.length === 1);
    await tokenCount(828_400);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(observations.length, 1, 'unchanged runtime window should not spam persistence');
    assert.deepEqual(observations[0], {
      hubSessionId,
      transcriptPath: rollout.rolloutPath,
      contextEffectiveMax: 828_400,
      observedAt: observedAt.getTime(),
      signalSource: 'token_count.model_context_window',
    });
  } finally {
    tap.unregisterSession(hubSessionId);
    await rollout.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('TranscriptTap forwards Codex lifecycle and context events to main listeners', () => {
  const tap = new TranscriptTap();
  const received = [];
  for (const eventName of ['turn-started', 'turn-aborted', 'context-window-observed']) {
    tap.on(eventName, payload => received.push([eventName, payload]));
    tap._codex.emit(eventName, { hubSessionId: 'forwarded', marker: eventName });
  }
  assert.deepEqual(received, [
    ['turn-started', { hubSessionId: 'forwarded', marker: 'turn-started' }],
    ['turn-aborted', { hubSessionId: 'forwarded', marker: 'turn-aborted' }],
    ['context-window-observed', { hubSessionId: 'forwarded', marker: 'context-window-observed' }],
  ]);
  tap.dispose();
});
