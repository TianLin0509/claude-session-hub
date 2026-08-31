'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNTIME_IDLE,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_UNKNOWN,
  RUNNING_ANIMATION_CONFIRM_MAX_MS,
  advanceRunningAnimationCandidate,
  classifyTerminalRuntime,
} = require('../core/terminal-runtime-state.js');

test('Codex 0.147 running frame wins even though the input placeholder and context footer remain visible', () => {
  const result = classifyTerminalRuntime('codex', [
    '› Run PowerShell Start-Sleep -Seconds 4, then reply with exactly PTY_STATE_DONE.',
    '• Working (6s • esc to interrupt)',
    '› Improve documentation in @filename',
    '  gpt-5.6-sol max fast · Context 100% left · ~\\claude-session-hub',
  ]);
  assert.equal(result.state, RUNTIME_RUNNING);
  assert.equal(result.reason, 'codex-interrupt-footer');
});

test('Codex input-ready frame settles after esc-to-interrupt disappears', () => {
  const result = classifyTerminalRuntime('codex', [
    '• Ran Start-Sleep -Seconds 4',
    '• PTY_STATE_DONE',
    '› Improve documentation in @filename',
    '  gpt-5.6-sol max fast · Context 95% left · ~\\claude-session-hub',
  ]);
  assert.equal(result.state, RUNTIME_IDLE);
  assert.equal(result.reason, 'codex-input-ready');
});

test('Codex running evidence must be a structured current status row, not quoted prose', () => {
  const quoted = classifyTerminalRuntime('codex', [
    'The documentation says esc to interrupt while the command is working.',
    '› Improve documentation in @filename',
    'gpt-5.6-sol max fast · Context 95% left · C:\\repo',
  ]);
  assert.equal(quoted.state, RUNTIME_IDLE);

  const bare = classifyTerminalRuntime('codex', [
    'Working through the remaining review items.',
  ]);
  assert.equal(bare.state, RUNTIME_UNKNOWN);
});

test('a bottom confirmation outranks an older Working row in the same live screen', () => {
  const result = classifyTerminalRuntime('codex', [
    '• Working (25s • esc to interrupt)',
    '› Use /skills to list available skills',
    'gpt-5.6-sol max fast · Context 92% left · C:\\repo',
    'Allow this command to run? [y/N]',
  ]);
  assert.equal(result.state, RUNTIME_WAITING);
  assert.equal(result.reason, 'interactive-confirmation');
});

test('a structured Working row outside the live status tail cannot resurrect a session', () => {
  const result = classifyTerminalRuntime('codex', [
    '• Working (99s • esc to interrupt)',
    ...Array.from({ length: 12 }, (_, index) => `completed output ${index}`),
    '› Improve documentation in @filename',
    'gpt-5.6-sol max fast · Context 95% left · C:\\repo',
  ]);
  assert.equal(result.state, RUNTIME_IDLE);
});

test('animation confirmation requires a changed strong frame inside a short window', () => {
  const firstRuntime = classifyTerminalRuntime('codex', [
    '• Working (25s • esc to interrupt)',
  ]);
  const changedRuntime = classifyTerminalRuntime('codex', [
    '• Working (26s • esc to interrupt)',
  ]);
  const first = advanceRunningAnimationCandidate(null, firstRuntime, 1000);
  assert.equal(first.confirmed, false);
  assert.ok(first.candidate);

  const staticRepeat = advanceRunningAnimationCandidate(first.candidate, firstRuntime, 1400);
  assert.equal(staticRepeat.confirmed, false, 'a static leftover row is not animation');

  const changed = advanceRunningAnimationCandidate(staticRepeat.candidate, changedRuntime, 1600);
  assert.equal(changed.confirmed, true);
  assert.equal(changed.candidate, null);

  const expired = advanceRunningAnimationCandidate(first.candidate, changedRuntime,
    1000 + RUNNING_ANIMATION_CONFIRM_MAX_MS + 1);
  assert.equal(expired.confirmed, false, 'widely separated frames are not continuous animation');
  assert.ok(expired.candidate);
});

test('a long static Working repaint storm never becomes confirmed animation', () => {
  const runtime = classifyTerminalRuntime('codex', [
    '• Working (25s • esc to interrupt)',
    '› Ask Codex to do anything',
    '  gpt-5.6-sol max fast · Context 91% left · C:\\Vibe\\repo',
  ]);
  let candidate = null;
  let observedAt = 1_000;
  for (let index = 0; index < 10_000; index += 1) {
    const advanced = advanceRunningAnimationCandidate(candidate, runtime, observedAt);
    assert.equal(advanced.confirmed, false, `static frame confirmed at iteration ${index}`);
    candidate = advanced.candidate;
    observedAt += 250;
  }
});

test('Claude animated status row is running while the same persistent footer stays on screen', () => {
  const result = classifyTerminalRuntime('claude', [
    '> Read package.json, then reply with exactly PTY_STATE_DONE.',
    '✻ Cultivating… (4s · ↓ 48 tokens)',
    '>',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #3',
  ]);
  assert.equal(result.state, RUNTIME_RUNNING);
  assert.equal(result.reason, 'claude-active-status');
});

test('Claude completed duration row is idle because it has no active ellipsis', () => {
  const result = classifyTerminalRuntime('claude', [
    '> Read package.json, then reply with exactly PTY_STATE_DONE.',
    '● PTY_STATE_DONE',
    '✻ Crunched for 7s',
    '>',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #3',
  ]);
  assert.equal(result.state, RUNTIME_IDLE);
  assert.equal(result.reason, 'claude-input-ready');
});

test('Claude no-suggestion placeholder is an input-ready completed frame', () => {
  const result = classifyTerminalRuntime('claude', [
    '● CLAUDE_PTY_RUNTIME_DONE',
    '✻ Cogitated for 9s · done 22:33',
    '❯ <no suggestion>',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · low · /effort',
  ]);
  assert.equal(result.state, RUNTIME_IDLE);
  assert.equal(result.reason, 'claude-input-ready');
});

test('Claude stop-hook progress remains running until the input-ready frame is stable', () => {
  const result = classifyTerminalRuntime('claude', [
    '● PTY_STATE_DONE',
    '✢ Cultivating… (running stop hooks… 1/2 · 7s · ↓ 81 tokens)',
    '>',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ]);
  assert.equal(result.state, RUNTIME_RUNNING);
});

test('interactive confirmation is waiting, while ambiguous historical text stays unknown', () => {
  assert.equal(classifyTerminalRuntime('claude', [
    'Quick safety check: Is this a project you trust?',
    '> 1. Yes, I trust this folder',
    'Enter to confirm · Esc to cancel',
  ]).state, RUNTIME_WAITING);
  assert.equal(classifyTerminalRuntime('codex', ['old answer only']).state, RUNTIME_UNKNOWN);
});

test('an old trust confirmation row above a completed Claude frame cannot leak into current state', () => {
  const result = classifyTerminalRuntime('claude', [
    'Enter to confirm · Esc to cancel',
    '● PTY_STATE_DONE',
    '✻ Crunched for 7s',
    '>',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ]);
  assert.equal(result.state, RUNTIME_IDLE);
});
