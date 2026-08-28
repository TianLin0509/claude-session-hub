'use strict';

// 2026-08-28 用户反馈：会话异常过一次之后，哪怕早已恢复，侧栏「⚠ 运行异常」里的
// 断连标记一直下不去。根因两条，这里各守一条：
//   (a) 断连是从 PTY 输出认出来的，而 Codex/Claude 的 TUI 会把整屏反复重绘 ——
//       用户点开清掉后，下一帧同一段报错文本又流过来，立刻被重新判成断连。
//   (b) 断连同时把 runtimeTruth 打成 RUNTIME_FAILED（终态），光清 connectionIssue
//       不降级的话，会话照样留在「运行异常」分区。

const assert = require('assert');
const {
  appendStreamDisconnectChunk,
  detectStreamDisconnect,
  hasStreamDisconnectIssue,
  markStreamDisconnectAcknowledged,
  shouldRaiseStreamDisconnect,
} = require('../core/stream-disconnect.js');
const {
  CONFIDENCE_AUTHORITATIVE,
  CONFIDENCE_STRONG,
  RUNTIME_FAILED,
  RUNTIME_IDLE,
  applySessionRuntimeObservation,
  getSessionRuntimeTruth,
} = require('../core/session-runtime-truth.js');

const DISCONNECT_LINE = '\n■ stream disconnected before completion: Transport closed\n';
const issue = detectStreamDisconnect(DISCONNECT_LINE);
assert.ok(issue && issue.type === 'stream-disconnected');

// --- (a) 重绘不得重新升起已确认的提醒 ---
const session = { id: 's1', connectionIssue: null, runStartedAt: 1000 };
assert.strictEqual(shouldRaiseStreamDisconnect(session, issue), true, '第一次必须升起');

session.connectionIssue = { ...issue, observedAt: 2000 };
assert.strictEqual(shouldRaiseStreamDisconnect(session, issue), false, '同一条不重复升起');

// 用户点开 → 确认
markStreamDisconnectAcknowledged(session, 3000);
session.connectionIssue = null;
session._streamDisconnectTail = '';
assert.strictEqual(hasStreamDisconnectIssue(session), false);
// TUI 重绘把同一段报错又推了一遍
assert.strictEqual(
  shouldRaiseStreamDisconnect(session, issue), false,
  '确认之后同一条报错被重绘出来，不得再次升起',
);
// 重绘很多次也一样
for (let i = 0; i < 20; i += 1) {
  const tracked = appendStreamDisconnectChunk(session._streamDisconnectTail, DISCONNECT_LINE);
  session._streamDisconnectTail = tracked.tail;
  assert.strictEqual(shouldRaiseStreamDisconnect(session, tracked.issue), false);
}

// 确认之后真的又跑了一轮 → 同一条报错必须能再次升起
session.runStartedAt = 4000;
assert.strictEqual(
  shouldRaiseStreamDisconnect(session, issue), true,
  '确认后又开了新一轮，再断连要重新提醒',
);

// 换一条不同的报错，随时可以升起
const otherIssue = detectStreamDisconnect('\nAPI Error: Connection refused\n');
assert.ok(otherIssue);
session.runStartedAt = 1000;
assert.strictEqual(shouldRaiseStreamDisconnect(session, otherIssue), true, '不同的报错不受旧确认压制');

// 边界
assert.strictEqual(shouldRaiseStreamDisconnect(null, issue), false);
assert.strictEqual(shouldRaiseStreamDisconnect(session, null), false);
assert.strictEqual(markStreamDisconnectAcknowledged({ connectionIssue: null }), null);

// --- (b) RUNTIME_FAILED 是终态，必须能被「用户已确认」降下来 ---
const failed = { id: 's2', status: 'idle' };
applySessionRuntimeObservation(failed, {
  state: RUNTIME_FAILED,
  source: 'pty-stream-disconnected',
  confidence: CONFIDENCE_STRONG,
  observedAt: 1000,
});
assert.strictEqual(getSessionRuntimeTruth(failed, { now: 2000 }).state, RUNTIME_FAILED);

const result = applySessionRuntimeObservation(failed, {
  state: RUNTIME_IDLE,
  source: 'user-acknowledged-failure',
  confidence: CONFIDENCE_AUTHORITATIVE,
  observedAt: 3000,
});
assert.strictEqual(result.applied, true, '用户确认必须能覆盖 FAILED 终态');
assert.strictEqual(getSessionRuntimeTruth(failed, { now: 3100 }).state, RUNTIME_IDLE);
// legacy status 也要跟着回到 idle，否则 getSessionRuntimeTruth 会从 status='error' 反推回 FAILED
assert.strictEqual(failed.status, 'idle');

console.log('unit-stream-disconnect-ack: OK');
