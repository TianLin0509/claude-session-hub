'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNTIME_IDLE,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_UNKNOWN,
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
