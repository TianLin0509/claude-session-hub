'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodexTap, TranscriptTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  return false;
}

async function writeUserMessage(fr, message) {
  await fr.writeRaw({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message },
  });
}

async function testSameCwdWaitsForPromptMatch() {
  const tmpRoot = path.join(os.tmpdir(), `codex-same-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const cwd = 'C:\\test\\shared-cwd';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const startAt = new Date();
  const frA = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019eaaaa-0000-7000-8000-000000000001', startAt });
  const frB = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019ebbbb-0000-7000-8000-000000000002', startAt });

  try {
    tap.registerSession('hub-A', { cwd });
    tap.registerSession('hub-B', { cwd });
    await frA.start();
    await frB.start();

    await sleep(250);
    assert.strictEqual(tap.getRolloutPath('hub-A'), null, 'shared cwd must not bind before prompt evidence');
    assert.strictEqual(tap.getRolloutPath('hub-B'), null, 'shared cwd must not bind before prompt evidence');

    tap.notePrompt('hub-A', 'prompt for A');
    await writeUserMessage(frA, 'prompt for A');
    assert.ok(await waitFor(() => tap.getRolloutPath('hub-A') === frA.rolloutPath), 'hub-A should bind to rollout whose user_message matches its prompt');
    assert.notStrictEqual(tap.getRolloutPath('hub-B'), frA.rolloutPath, 'hub-B must not steal hub-A rollout');
  } finally {
    tap.unregisterSession('hub-A');
    tap.unregisterSession('hub-B');
    await frA.close();
    await frB.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

function testTranscriptTapExposesNotePrompt() {
  const tap = new TranscriptTap();
  assert.strictEqual(typeof tap.notePrompt, 'function', 'TranscriptTap must expose notePrompt');
}

(async () => {
  const tests = [
    testTranscriptTapExposesNotePrompt,
    testSameCwdWaitsForPromptMatch,
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log('OK', t.name);
    } catch (e) {
      failed++;
      console.error('FAIL', t.name);
      console.error(e.stack || e.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
