'use strict';

const assert = require('node:assert');
const {
  attemptEventMatches,
  classifyProviderFailure,
  createAttemptId,
  createRunId,
  isAuthoritativeFinalSignal,
  promptFingerprint,
} = require('../core/groupchat-attempt-protocol.js');
const { createGroupChatProviderAdapter } = require('../core/groupchat-provider-adapter.js');

const runId = createRunId('meeting-A', 7);
const attemptId = createAttemptId(runId, 'm1');
assert.match(runId, /^gcr-meeting-A-7-/);
assert.match(attemptId, /^gca-m1-/);
assert.strictEqual(promptFingerprint('a\r\nb'), promptFingerprint('a\nb'));

const attempt = {
  attemptId,
  runId,
  sid: 'sid-1',
  kind: 'codex',
  dispatchAt: 1000,
  startedAt: 1200,
  providerTurnId: 'turn-2',
};
assert.strictEqual(attemptEventMatches(attempt, {
  hubSessionId: 'sid-1', turnId: 'turn-1', completedAt: 1400,
}).reason, 'provider_turn_mismatch');
assert.strictEqual(attemptEventMatches(attempt, {
  hubSessionId: 'sid-1', turnId: 'turn-2', completedAt: 900,
}).reason, 'before_attempt_boundary');
assert.strictEqual(attemptEventMatches(attempt, {
  hubSessionId: 'sid-1', turnId: 'turn-2', completedAt: 1400,
}).ok, true);

assert.strictEqual(isAuthoritativeFinalSignal('claude', 'stop_reason_terminal'), true);
assert.strictEqual(isAuthoritativeFinalSignal('claude', 'idle_timer_5s'), false);
assert.strictEqual(isAuthoritativeFinalSignal('codex', 'task_complete'), true);
assert.strictEqual(isAuthoritativeFinalSignal('codex', 'agent_message'), false);

const quota = classifyProviderFailure({ text: "You've hit your session limit · resets 6am", fromAssistantText: true });
assert.strictEqual(quota.code, 'quota_exceeded');
assert.strictEqual(quota.autoRetry, false);
const network = classifyProviderFailure({ message: 'stream disconnected before completion: ECONNRESET', force: true });
assert.strictEqual(network.code, 'network_interrupted');
assert.strictEqual(network.retryable, true);
assert.strictEqual(classifyProviderFailure({ reason: 'auth_required', force: true }).code, 'auth_required');
assert.strictEqual(classifyProviderFailure({
  text: '下面分析 API rate limit 的设计。'.repeat(80), fromAssistantText: true,
}), null, '长技术回答里提到 rate limit 不能误判成额度失败');
assert.strictEqual(classifyProviderFailure({
  text: 'Rate limit 是服务端用来保护容量的一种机制。', fromAssistantText: true,
}), null, '短技术解释也不能被宽泛关键词误判成额度失败');

const adapter = createGroupChatProviderAdapter('codex');
assert.strictEqual(adapter.completion(attempt, {
  hubSessionId: 'sid-1', turnId: 'turn-2', completedAt: 1500,
  signalSource: 'agent_message', text: '中间解释',
}).reason, 'non_final_signal');
assert.strictEqual(adapter.completion(attempt, {
  hubSessionId: 'sid-1', turnId: 'turn-2', completedAt: 1500,
  signalSource: 'task_complete', text: '最终答案',
}).status, 'completed');
assert.strictEqual(adapter.completion(attempt, {
  hubSessionId: 'sid-1', turnId: 'turn-2', completedAt: 1500,
  signalSource: 'task_complete', text: 'Quota exceeded',
}).failure.code, 'quota_exceeded');

console.log('groupchat attempt protocol: ok');
