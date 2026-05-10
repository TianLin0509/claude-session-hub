'use strict';
// 单测 transformHtmlBlock + decideHtmlBlockHeight 纯函数（Phase 7 / 2026-05-10）
// 这两个纯函数从 renderer/html-block-renderer.js 模块导出，用于 meeting-room.js 内 DOM 包装层调用。

const test = require('node:test');
const assert = require('node:assert/strict');

const { transformHtmlBlock, decideHtmlBlockHeight } = require('../renderer/html-block-renderer.js');

// ===== transformHtmlBlock =====

test('transformHtmlBlock：小块返回 iframe 描述对象', () => {
  const r = transformHtmlBlock('<table><tr><td>hi</td></tr></table>');
  assert.equal(r.kind, 'iframe');
  assert.equal(r.sandbox, 'allow-scripts');
  assert.equal(r.className, 'rt-html-block');
  assert.match(r.srcdoc, /ResizeObserver/, 'srcdoc 应含桥脚本');
  assert.match(r.srcdoc, /rt-html-resize/, 'srcdoc 含消息 type');
  assert.ok(r.srcdoc.endsWith('<table><tr><td>hi</td></tr></table>'), 'srcdoc 末尾是原始 HTML');
});

test('transformHtmlBlock：恰 64KB 仍走 iframe（边界）', () => {
  const html = 'x'.repeat(65536);
  const r = transformHtmlBlock(html);
  assert.equal(r.kind, 'iframe');
});

test('transformHtmlBlock：超 64KB 返回 oversize 描述', () => {
  const r = transformHtmlBlock('x'.repeat(70000));
  assert.equal(r.kind, 'oversize');
  assert.match(r.message, /过大/);
  assert.match(r.message, /68\.4KB/);
  assert.match(r.message, /64KB/);
});

test('transformHtmlBlock：自定义 maxBytes', () => {
  const r = transformHtmlBlock('x'.repeat(2000), { maxBytes: 1000 });
  assert.equal(r.kind, 'oversize');
  assert.match(r.message, /1\.0KB/);
});

test('transformHtmlBlock：空字符串返回 iframe（kind 不变，srcdoc 为桥脚本）', () => {
  const r = transformHtmlBlock('');
  assert.equal(r.kind, 'iframe');
  assert.match(r.srcdoc, /ResizeObserver/);
});

test('transformHtmlBlock：含 script 标签时 srcdoc 原样保留（sandbox 隔离由调用方保证）', () => {
  const r = transformHtmlBlock('<script>alert(1)</script><b>x</b>');
  assert.equal(r.kind, 'iframe');
  assert.match(r.srcdoc, /<script>alert\(1\)<\/script><b>x<\/b>/);
});

// ===== decideHtmlBlockHeight =====

test('decideHtmlBlockHeight：合法 height 返回数字', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'rt-html-resize', height: 350 }), 350);
});

test('decideHtmlBlockHeight：错 type 返回 null', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'other', height: 350 }), null);
});

test('decideHtmlBlockHeight：负数返回 null', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'rt-html-resize', height: -50 }), null);
});

test('decideHtmlBlockHeight：0 返回 null', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'rt-html-resize', height: 0 }), null);
});

test('decideHtmlBlockHeight：超 8000 返回 null', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'rt-html-resize', height: 99999 }), null);
});

test('decideHtmlBlockHeight：恰 8000 返回 null（上界排除）', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'rt-html-resize', height: 8000 }), null);
});

test('decideHtmlBlockHeight：null/undefined/{} 返回 null', () => {
  assert.equal(decideHtmlBlockHeight(null), null);
  assert.equal(decideHtmlBlockHeight(undefined), null);
  assert.equal(decideHtmlBlockHeight({}), null);
});

test('decideHtmlBlockHeight：字符串 height 也接受（postMessage 数据可能 stringify）', () => {
  assert.equal(decideHtmlBlockHeight({ type: 'rt-html-resize', height: '500' }), 500);
});
