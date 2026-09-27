'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionStatusSummary } = require('../core/session-status-summary.js');

test('a PTY unknown execution state is not displayed as ready', () => {
  const session = { kind: 'codex', agentRuntime: 'pty', status: 'idle',
    runtimeTruth: { state: 'unknown', source: 'expired:codex-rollout_user_message', confidence: 'none', observedAt: Date.now() } };
  const runtime = require('../renderer/session-runtime-status').deriveSessionRuntimeStatus(session);
  const result = require('../core/session-status-summary').buildComposerStatusModel(session, { runtime });
  assert.equal(result.state, 'unknown');
  assert.equal(result.text, '状态未知');
  assert.equal(result.canStop, false);
});

test('Codex card footer mirrors model, effort, fast tier, context left and cwd', () => {
  assert.deepEqual(buildSessionStatusSummary({
    kind: 'codex',
    currentModel: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-SOL' },
    effort: 'max',
    codexSpeedTier: 'fast',
    contextPct: 8,
    cwd: 'C:\\Vibe\\repo',
  }), {
    kind: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'max',
    speed: 'fast',
    contextLeft: 92,
    contextText: 'Context 92% left',
    cwd: 'C:\\Vibe\\repo',
    compact: 'gpt-5.6-sol · max · fast',
    ariaLabel: 'gpt-5.6-sol · max · fast，上下文剩余 92%，C:\\Vibe\\repo',
  });
});

test('Claude default fast and explicit standard are both visible', () => {
  assert.equal(buildSessionStatusSummary({ kind: 'claude', effort: 'high' }).speed, 'fast');
  assert.equal(buildSessionStatusSummary({ kind: 'claude-resume', fastMode: false }).speed, 'standard');
});

test('native Claude stage and group summaries use the same confirmed speed as the composer', () => {
  const {buildStageStatusSummary} = require('../core/session-status-summary');
  for (const confirmed of [false,true]) {
    const session={kind:'claude',runtimeBackend:'claude-stream-json',fastMode:!confirmed,nativeRuntime:{fastMode:confirmed}};
    assert.equal(buildSessionStatusSummary(session).speed,confirmed?'fast':'standard');
    assert.equal(buildStageStatusSummary(session).speed,confirmed?'fast':'standard');
  }
});
