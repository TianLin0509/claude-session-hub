'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNightGuardState,
  sanitizeNightGuardState,
} = require('../core/night-guard-state.js');

test('night guard state is bounded and persistence-safe', () => {
  const state = sanitizeNightGuardState({
    enabled: true,
    mode: 'goal',
    status: 'waiting-network',
    healthyRounds: 99,
    recoveryAttempts: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    lastError: 'x'.repeat(900),
  });
  assert.equal(state.enabled, true);
  assert.equal(state.mode, 'goal');
  assert.equal(state.healthyRounds, 9);
  assert.equal(state.recoveryAttempts.length, 8);
  assert.equal(state.lastError.length, 500);
});

test('new manual protection is armed and auto-closing', () => {
  const state = createNightGuardState({ enabled: true, mode: 'manual', now: 1234 });
  assert.equal(state.status, 'armed');
  assert.equal(state.armedAt, 1234);
  assert.equal(state.autoCloseOnSuccess, true);
});
