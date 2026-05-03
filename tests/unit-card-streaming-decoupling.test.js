'use strict';
// 单测 _isPartialUnchanged：partial diff 短路逻辑（T2 / 2026-05-04 道雪）
// 这个纯函数从 renderer/meeting-room.js 暴露成 module.exports 兼容（renderer 既是 IIFE 又能在 Node 测试环境 require）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { _isPartialUnchanged } = require('../renderer/meeting-room.js');

test('null prev / null next：视为相同（避免首次渲染误判变化）', () => {
  assert.equal(_isPartialUnchanged(null, null), true);
});

test('null prev / 有 next：视为变化', () => {
  assert.equal(_isPartialUnchanged(null, { text: 'hi', status: 'streaming' }), false);
});

test('有 prev / null next：视为变化', () => {
  assert.equal(_isPartialUnchanged({ text: 'hi', status: 'streaming' }, null), false);
});

test('text + status + cleanBufLen + sendStatus + tokens.total 全相同：unchanged', () => {
  const prev = { text: 'abc', status: 'streaming', cleanBufLen: 100, sendStatus: undefined, tokens: { total: 50 } };
  const next = { text: 'abc', status: 'streaming', cleanBufLen: 100, sendStatus: undefined, tokens: { total: 50 } };
  assert.equal(_isPartialUnchanged(prev, next), true);
});

test('text 变化 → changed', () => {
  const prev = { text: 'abc', status: 'streaming', cleanBufLen: 100 };
  const next = { text: 'abcd', status: 'streaming', cleanBufLen: 100 };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('status 变化（streaming→completed）→ changed', () => {
  const prev = { text: 'abc', status: 'streaming' };
  const next = { text: 'abc', status: 'completed' };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('cleanBufLen 变化（heartbeat 心跳）→ changed', () => {
  const prev = { text: '', status: 'streaming', cleanBufLen: 100 };
  const next = { text: '', status: 'streaming', cleanBufLen: 200 };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('sendStatus 由 undefined→stuck → changed', () => {
  const prev = { text: 'abc', status: 'streaming' };
  const next = { text: 'abc', status: 'streaming', sendStatus: 'stuck' };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('tokens.total 变化 → changed', () => {
  const prev = { text: 'abc', status: 'streaming', tokens: { total: 50 } };
  const next = { text: 'abc', status: 'streaming', tokens: { total: 60 } };
  assert.equal(_isPartialUnchanged(prev, next), false);
});

test('blocks 数组按 length + 末块 type/text 比对（轻量比对）', () => {
  const prev = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'a' }] };
  const next = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'a' }] };
  assert.equal(_isPartialUnchanged(prev, next), true);
  const next2 = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'ab' }] };
  assert.equal(_isPartialUnchanged(prev, next2), false);
  const next3 = { text: '', status: 'streaming', blocks: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
  assert.equal(_isPartialUnchanged(prev, next3), false);
});

test('sendStatus stuck 心跳：prev 与 next 都已带 stuck 时视为 unchanged（短路生效）', () => {
  const prev = { text: 'abc', status: 'streaming', sendStatus: 'stuck' };
  const next = { text: 'abc', status: 'streaming', sendStatus: 'stuck' };
  assert.equal(_isPartialUnchanged(prev, next), true);
});
