'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');
const {
  acceptGroupChatEvent,
  getGroupChatRevision,
  resetGroupChatRevision,
} = require('../renderer/groupchat-event-revision.js');

function rng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function shuffled(items, random) {
  const out = items.slice();
  for (let index = out.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [out[index], out[target]] = [out[target], out[index]];
  }
  return out;
}

async function watcherChaos() {
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = rng(seed);
    const tap = new EventEmitter();
    const now = Date.now();
    const rejected = [];
    const watcher = createTurnCompletionWatcher({
      transcriptTap: tap,
      hubSessionId: 'sid-current',
      label: 'Codex',
      kind: 'codex',
      attempt: {
        attemptId: `attempt-${seed}`,
        runId: `run-${seed}`,
        sid: 'sid-current',
        kind: 'codex',
        dispatchAt: now - 100,
        startedAt: now - 50,
        providerTurnId: 'turn-current',
      },
      onEventRejected: event => rejected.push(event.reason),
      softAlertT1Ms: 60_000,
      softAlertT2Ms: 120_000,
    });
    const resultPromise = watcher.wait();
    const events = shuffled([
      { hubSessionId: 'sid-other', turnId: 'turn-current', signalSource: 'task_complete', text: 'wrong sid', completedAt: now },
      { hubSessionId: 'sid-current', turnId: 'turn-old', signalSource: 'task_complete', text: 'old answer', completedAt: now },
      { hubSessionId: 'sid-current', turnId: 'turn-current', signalSource: 'agent_message', text: 'progress only', completedAt: now },
      { hubSessionId: 'sid-current', turnId: 'turn-current', signalSource: 'task_complete', text: 'THE FINAL', completedAt: now },
      { hubSessionId: 'sid-current', turnId: 'turn-current', signalSource: 'task_complete', text: 'THE FINAL', completedAt: now },
    ], random);
    // Ensure at least one invalid event is observed before the first valid
    // completion; otherwise the watcher legitimately cleans up immediately.
    const invalidIndex = events.findIndex(event => event.hubSessionId === 'sid-current'
      && !(event.turnId === 'turn-current' && event.signalSource === 'task_complete'));
    [events[0], events[invalidIndex]] = [events[invalidIndex], events[0]];
    for (const event of events) tap.emit('turn-complete', event);
    const result = await resultPromise;
    assert.strictEqual(result.text, 'THE FINAL', `seed ${seed}: only current provider final may settle`);
    assert.strictEqual(result.attemptId, `attempt-${seed}`);
    assert.ok(rejected.length >= 1, `seed ${seed}: invalid event should be rejected before settlement`);
    watcher.cancelPatch();
  }
}

function revisionChaos() {
  for (let seed = 1; seed <= 250; seed += 1) {
    const meetingId = `meeting-${seed}`;
    resetGroupChatRevision(meetingId);
    const revisions = shuffled(Array.from({ length: 40 }, (_, index) => index + 1), rng(seed));
    let acceptedMax = 0;
    for (const revision of revisions) {
      const decision = acceptGroupChatEvent({
        meetingId, turnNum: 3, runId: 'run', revision,
      }, { consumer: 'chaos' });
      if (decision.accepted) acceptedMax = revision;
      else assert.ok(revision <= acceptedMax, `seed ${seed}: only stale revisions may be rejected`);
    }
    assert.strictEqual(getGroupChatRevision(meetingId, 'chaos').revision, Math.max(...revisions));
  }
}

(async () => {
  await watcherChaos();
  revisionChaos();
  console.log('groupchat deterministic chaos: 250 watcher permutations + 250 revision permutations ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
