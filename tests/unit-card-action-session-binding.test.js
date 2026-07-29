'use strict';
// 卡片操作的会话绑定（2026-07-28 串台事故）。
//
// 现场：用户在群聊 A 里单独打开 Kimi 的卡片视图，对一张历史卡片重发提问，
// 消息却发到了群聊 B 的 Claude —— 那条提问（PPT Doctor / τ 搜索）因此完全
// 没有进 A 的群聊记录，B 群里的 Codex 和 Kimi 也全程不知情。
//
// 根因：renderer.js 里三处卡片操作（prompt-inspect / resend / regen /
// edit-resend）都直接取全局 activeSessionId，而不是这张卡片所属的会话。
// 只要上一次交互把焦点落在别的会话上，卡片操作就打到错误的 CLI，
// 两边界面都看不出异常。
//
// turn-card-renderer 早就把 sessionId 写进了 cardEl.dataset.sessionId，
// 这些操作本来就该用它。本文件锁住这个契约。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const CARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'turn-card-renderer.js'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error && error.message)); }
}

console.log('Running card action session binding tests...');

test('卡片渲染时把 sessionId 写进 dataset（下游操作的唯一依据）', () => {
  assert.ok(CARD_SRC.includes('cardEl.dataset.sessionId'),
    'turn-card-renderer 必须把 sessionId stash 到卡片 DOM 上');
});

test('存在 getCardSessionId helper，且优先读卡片自己的 sessionId', () => {
  assert.ok(RENDERER_SRC.includes('function getCardSessionId('), '缺少 getCardSessionId helper');
  const fnStart = RENDERER_SRC.indexOf('function getCardSessionId(');
  const body = RENDERER_SRC.slice(fnStart, fnStart + 500);
  assert.ok(body.includes('dataset.sessionId'), 'helper 必须先读 cardEl.dataset.sessionId');
  const dsIdx = body.indexOf('dataset.sessionId');
  const globalIdx = body.indexOf('activeSessionId');
  assert.ok(dsIdx >= 0 && (globalIdx === -1 || dsIdx < globalIdx),
    '必须先取卡片自身的 sessionId，全局值只能作为兜底');
});

test('resend / regen 通过 getCardSessionId 取目标会话', () => {
  const start = RENDERER_SRC.indexOf("if (action === 'resend' || action === 'regen')");
  assert.ok(start > 0, '找不到 resend/regen 分支');
  const block = RENDERER_SRC.slice(start, RENDERER_SRC.indexOf("if (action === 'edit-resend')", start));
  assert.ok(block.includes('getCardSessionId(card)'),
    'resend/regen 必须用 getCardSessionId(card)');
  assert.ok(!/const sid = \(typeof activeSessionId/.test(block),
    'resend/regen 不允许再直接取全局 activeSessionId —— 这正是串台的根因');
});

test('prompt-inspect 也绑定卡片自己的会话', () => {
  const start = RENDERER_SRC.indexOf("if (action === 'prompt-inspect')");
  assert.ok(start > 0, '找不到 prompt-inspect 分支');
  const block = RENDERER_SRC.slice(start, start + 400);
  assert.ok(block.includes('getCardSessionId(card)'),
    'prompt-inspect 必须用卡片自己的 sessionId，否则会去查错会话的 prompt');
  assert.ok(!/const sid = \(typeof activeSessionId/.test(block),
    'prompt-inspect 不允许直接取全局 activeSessionId');
});

test('edit-resend 在卡片不属于当前会话时拒绝填入', () => {
  const start = RENDERER_SRC.indexOf("if (action === 'edit-resend')");
  assert.ok(start > 0, '找不到 edit-resend 分支');
  const block = RENDERER_SRC.slice(start, start + 1600);
  assert.ok(block.includes('getCardSessionId(card)'), 'edit-resend 需要知道卡片属于谁');
  assert.ok(/String\(cardSid\) !== String\(liveSid\)/.test(block),
    'edit-resend 必须比对卡片会话与当前激活会话');
  const guardIdx = block.indexOf('cardSid');
  const queryIdx = block.indexOf("document.querySelector('.floating-input-box')");
  assert.ok(guardIdx >= 0 && queryIdx >= 0 && guardIdx < queryIdx,
    '守卫必须在 querySelector 之前 —— 否则文本已经填进别的会话的输入框了');
});

test('全文再无「卡片操作直接读全局 sid」的旧写法', () => {
  // 旧写法特征：在卡片 click handler 里出现 `const sid = (typeof activeSessionId`
  const legacy = RENDERER_SRC.match(/const sid = \(typeof activeSessionId !== 'undefined'/g) || [];
  assert.strictEqual(legacy.length, 0,
    `还有 ${legacy.length} 处卡片操作在直接取全局 activeSessionId`);
});

if (failed > 0) {
  console.error(`card action session binding: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('All card action session binding tests passed.');
}
