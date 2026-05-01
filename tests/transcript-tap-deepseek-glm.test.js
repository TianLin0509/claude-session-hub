'use strict';
// Task 1（meeting-create-modal, 2026-05-01）: TranscriptTap _backendFor must route
// deepseek/glm to ClaudeTap so圆桌 timeline + streaming preview 自动复用 (spec §5.4).
//
// Spike (tests/_spike-deepseek-stop-hook-result.md) confirmed DeepSeek/GLM transcripts
// share Claude shape — schema-compatible with ClaudeTap.JsonlTail / notifyStop / streamingBuf.

const assert = require('assert');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running TranscriptTap _backendFor deepseek/glm tests...');

const { TranscriptTap } = require('../core/transcript-tap');

test('_backendFor routes deepseek to ClaudeTap backend', () => {
  const tap = new TranscriptTap();
  const backend = tap._backendFor('deepseek');
  assert.ok(backend, '_backendFor("deepseek") must not be null');
  assert.strictEqual(backend, tap._claude, 'deepseek routes to this._claude');
});

test('_backendFor routes glm to ClaudeTap backend', () => {
  const tap = new TranscriptTap();
  const backend = tap._backendFor('glm');
  assert.ok(backend, '_backendFor("glm") must not be null');
  assert.strictEqual(backend, tap._claude, 'glm routes to this._claude');
});

test('_backendFor still routes claude/claude-resume to ClaudeTap', () => {
  const tap = new TranscriptTap();
  assert.strictEqual(tap._backendFor('claude'), tap._claude);
  assert.strictEqual(tap._backendFor('claude-resume'), tap._claude);
});

test('_backendFor still routes codex to CodexTap and gemini to GeminiTap', () => {
  const tap = new TranscriptTap();
  assert.strictEqual(tap._backendFor('codex'), tap._codex);
  assert.strictEqual(tap._backendFor('gemini'), tap._gemini);
});

test('_backendFor returns null for unknown kind', () => {
  const tap = new TranscriptTap();
  assert.strictEqual(tap._backendFor('unknown-kind'), null);
  assert.strictEqual(tap._backendFor(''), null);
  assert.strictEqual(tap._backendFor(null), null);
});

console.log('All passed.');
