const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ATTENTION_REPLY_READY,
  applyReplyCompleted,
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

assert.ok(
  /function\s+onReplyCompleteFromTranscriptEvent\s*\(/.test(rendererSrc),
  'renderer must expose a transcript-turn completion handler for non-hook CLIs',
);

// 2026-07-27：该处理器从"只认 Codex"泛化为 isTranscriptCliKind（codex + kimi），
// 因为 Kimi 同样是 transcript 驱动、没有 Stop hook。断言盯泛化后的真实边界。
assert.ok(
  /if\s*\(\s*!isTranscriptCliKind\(kind\)\s*\)\s*return/.test(rendererSrc),
  'transcript completion handler must be scoped to transcript-backed CLI variants',
);
assert.ok(
  /function isTranscriptCliKind\(kind\)\s*\{\s*return isCodexKind\(kind\) \|\| isKimiCliKind\(kind\);/
    .test(rendererSrc),
  'isTranscriptCliKind must cover exactly the hook-less transcript CLIs (codex + kimi)',
);

// 普通完成和真正的 CLI 提问必须分开：完成未读进入 reply-ready，不能伪装成
// isWaiting，否则侧栏会把“结果已到”误报成“需要用户输入”。
const completed = { id: 'codex-finished', status: 'running', unreadCount: 0 };
const transition = applyReplyCompleted(completed, {
  completedAt: Date.now(),
  text: '任务已完成',
  seenByUser: false,
});
assert.strictEqual(transition.applied, true);
assert.strictEqual(completed.attentionState, ATTENTION_REPLY_READY);
assert.strictEqual(sessionHasCompletedUnread(completed), true);
assert.strictEqual(sessionNeedsUserInput(completed), false);
assert.strictEqual(completed.isWaiting, false);

assert.ok(
  /onReplyCompleteFromTranscriptEvent\s*\(\s*payload\s*\)[\s\S]{0,220}if\s*\(\s*meetingId\s*\)\s*return/.test(rendererSrc),
  'turn-complete-event must update waiting state before active-session card-view guards',
);

assert.ok(
  /function\s+clearSessionWaitingState\s*\(/.test(rendererSrc) &&
  /clearSessionWaitingState\s*\(\s*sessionId\s*\)/.test(rendererSrc),
  'user input path must clear stale waiting state when the user continues a Codex session',
);

console.log('codex waiting badge contract ok');
