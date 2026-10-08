'use strict';
// 2026-10-09 用户反馈：点发送后文字在 CLI 输入框里停半秒才提交，新会话第一条还要先等 1.5 秒。
//   1) 回显信号：写入之后的新输出里出现消息结尾，立即可以按回车；没有回显时照旧等满 settle。
//   2) 就绪判定：CLI 已经安静的时长计入稳定窗口，不再从第一次检查开始重新计 1.5 秒。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitForPasteSettled, echoNeedle, _private } = require('../core/pty-prompt-submit.js');
const detector = require('../core/group-chat-cli-ready-detector.js');

const fakeManager = (buffer = '') => ({ getSessionBuffer: () => buffer });

test('echo needle is the whitespace-free tail of the message', () => {
  assert.equal(echoNeedle('你好，帮我看一下这个函数为什么慢 T1'), '一下这个函数为什么慢T1');
  assert.equal(echoNeedle('第一行\n第二行 end'), '第二行end', 'only the last line: a TUI repaints just the new row');
  assert.equal(echoNeedle('结尾空行之前的内容\n'), null, 'an empty last line is no evidence');
  assert.equal(echoNeedle(' x '), null, 'too short to be evidence');
  assert.equal(echoNeedle('继续'), '继续');
  assert.equal(_private.echoComparable('\x1b[38;5;2m❯\x1b[1C你好\x1b[0m\r\n  世界'), '❯你好世界');
});

test('settle ends as soon as the CLI draws the end of the message', async () => {
  let output = '';
  setTimeout(() => { output = '\x1b[2K\x1b[1G❯ 你好，帮我看一下\x1b[1C这个函数\r\n  为什么慢 T1\x1b[0m'; }, 60);
  const started = Date.now();
  const result = await waitForPasteSettled({ sessionManager: fakeManager(), sid: 's', settleMs: 2000,
    echoNeedle: echoNeedle('你好，帮我看一下这个函数为什么慢 T1'), readOutputSince: () => output });
  assert.equal(result.reason, 'echo');
  assert.ok(Date.now() - started < 300, `waited ${Date.now() - started} ms`);
});

test('without the echo the size-based ceiling still applies', async () => {
  const started = Date.now();
  const result = await waitForPasteSettled({ sessionManager: fakeManager(), sid: 's', settleMs: 250,
    echoNeedle: echoNeedle('完全不同的一段内容 X9'), readOutputSince: () => '❯ 别的文字' });
  assert.equal(result.reason, 'ceiling');
  assert.ok(Date.now() - started >= 240);
});

test('a collapsed paste marker still settles through the marker path', async () => {
  let buffer = '';
  setTimeout(() => { buffer = '[Pasted text #1 +40 lines]'; }, 30);
  const result = await waitForPasteSettled({ sessionManager: { getSessionBuffer: () => buffer }, sid: 's', settleMs: 2000,
    echoNeedle: echoNeedle('x'.repeat(4000) + ' tail'), readOutputSince: () => buffer });
  assert.equal(result.reason, 'marker');
});

const READY_SCREEN = 'Claude Code v2\n' + '·'.repeat(600) + '\n❯ \n? for shortcuts\n';

test('a CLI already silent for 1.5 s is ready on the first check', () => {
  const sid = 'quiet-' + Date.now();
  assert.equal(detector.isReady(sid, 'claude', READY_SCREEN, { lastOutputAt: Date.now() - 4000 }), true);
});

test('a CLI that just printed still needs the full stable window', () => {
  const sid = 'busy-' + Date.now();
  assert.equal(detector.isReady(sid, 'claude', READY_SCREEN, { lastOutputAt: Date.now() - 100 }), false);
  assert.equal(detector.isReady(sid, 'claude', READY_SCREEN, { lastOutputAt: Date.now() - 100 }), false);
  const plain = 'plain-' + Date.now();
  assert.equal(detector.isReady(plain, 'claude', READY_SCREEN), false, 'callers without lastOutputAt keep the old rule');
});

test('quiet time never overrides blockers or a missing input marker', () => {
  assert.equal(detector.isReady('block-' + Date.now(), 'claude', READY_SCREEN + 'Switch to the new model?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel\n', { lastOutputAt: Date.now() - 9000 }), false);
  assert.equal(detector.isReady('nomarker-' + Date.now(), 'claude', '·'.repeat(800), { lastOutputAt: Date.now() - 9000 }), false);
});
