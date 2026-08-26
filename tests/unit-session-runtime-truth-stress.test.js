'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applySessionRuntimeObservation,
  getSessionRuntimeTruth,
} = require('../core/session-runtime-truth.js');

test('500 sessions survive ordered, duplicated and stale multi-source observations', () => {
  const sessions = Array.from({ length: 500 }, (_, index) => ({ id: `stress-${index}`, status: 'idle' }));
  const base = 1_800_000_000_000;
  for (const session of sessions) {
    for (let turn = 0; turn < 12; turn += 1) {
      const at = base + turn * 10_000;
      const turnId = `${session.id}-turn-${turn}`;
      applySessionRuntimeObservation(session, {
        state: 'starting', source: 'user-prompt', confidence: 'semantic',
        observedAt: at, startedAt: at, turnId,
      });
      applySessionRuntimeObservation(session, {
        state: 'running', source: 'native-turn-started', confidence: 'authoritative',
        observedAt: at + 100, startedAt: at, turnId,
      });
      applySessionRuntimeObservation(session, {
        state: 'running', source: 'pty-working-frame', confidence: 'strong',
        observedAt: at + 100, startedAt: at, turnId, evidence: 'esc to interrupt',
      });
      // A delayed prior-turn completion must never terminate the new turn.
      const stale = applySessionRuntimeObservation(session, {
        state: 'completed', source: 'stale-complete', confidence: 'authoritative',
        observedAt: at - 1, completedAt: at - 1, turnId: `${session.id}-turn-${Math.max(0, turn - 1)}`,
      });
      assert.equal(stale.applied, false);
      applySessionRuntimeObservation(session, {
        state: 'completed', source: 'native-turn-complete', confidence: 'authoritative',
        observedAt: at + 5000, completedAt: at + 5000, startedAt: at, turnId,
      });
    }
  }

  for (const session of sessions) {
    const truth = getSessionRuntimeTruth(session, { now: base + 120_000 });
    assert.equal(truth.state, 'completed');
    assert.equal(truth.source, 'native-turn-complete');
    assert.ok((truth.corroborations || []).length <= 4);
    assert.equal(session.status, 'idle');
  }
});
