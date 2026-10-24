'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeClipboardWrites } = require('../renderer/clipboard-routing');

test('direct clipboard writes from any copy button go through the verified copy path', async () => {
  const calls = []; const raw = [];
  const clipboard = { writeText: (value, type) => raw.push([value, type]) };
  const navigator = { clipboard: { writeText: async () => raw.push(['nav']) } };
  routeClipboardWrites({ clipboard, navigator, copyText: async (text, options) => { calls.push([text, options.silent]); return { ok: true }; } });
  await clipboard.writeText('按钮复制');
  await navigator.clipboard.writeText('网页 API 复制');
  assert.deepEqual(calls, [['按钮复制', true], ['网页 API 复制', true]]);
  clipboard.writeText('选区', 'selection');
  assert.deepEqual(raw, [['选区', 'selection']], 'non-system clipboard types pass through untouched');
});

test('failures reach callers that await, and never become unhandled rejections for those that do not', async () => {
  const clipboard = { writeText() {} };
  const navigator = { clipboard: {} };
  routeClipboardWrites({ clipboard, navigator, copyText: async () => ({ ok: false, reason: 'busy' }) });
  await assert.rejects(clipboard.writeText('x'), /busy/);
  await assert.rejects(navigator.clipboard.writeText('x'), /busy/);
  clipboard.writeText('fire and forget');
  await new Promise(resolve => setImmediate(resolve));
  routeClipboardWrites({ clipboard: { writeText() {} }, navigator: {}, copyText: async () => ({ ok: false, reason: 'superseded' }) });
});

test('a later copy elsewhere is not an error', async () => {
  const clipboard = { writeText() {} };
  routeClipboardWrites({ clipboard, navigator: {}, copyText: async () => ({ ok: false, reason: 'superseded', external: true }) });
  await clipboard.writeText('x');
});
