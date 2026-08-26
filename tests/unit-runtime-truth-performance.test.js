'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const { classifyTerminalRuntime } = require('../core/terminal-runtime-state.js');
const {
  applySessionRuntimeObservation,
  getSessionRuntimeTruth,
} = require('../core/session-runtime-truth.js');

test('RuntimeTruth plus an 80-row PTY classification stays lightweight', () => {
  const lines = Array.from({ length: 77 }, (_, index) => `log line ${index}`).concat([
    '• Working (12m 01s • esc to interrupt)',
    '› Improve documentation in @filename',
    'gpt-5.6-sol max fast · Context 90% left · C:\\repo',
  ]);
  const session = { id: 'perf', kind: 'codex', status: 'idle' };
  applySessionRuntimeObservation(session, {
    state: 'running', source: 'perf-start', confidence: 'semantic', observedAt: Date.now(),
  });

  const iterations = 20_000;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const runtime = classifyTerminalRuntime('codex', lines);
    const truth = getSessionRuntimeTruth(session, { now: Date.now() });
    if (runtime.state !== 'running' || truth.state !== 'running') throw new Error('unexpected runtime state');
  }
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 1500, `20k classifications took ${elapsedMs.toFixed(1)}ms`);
});
