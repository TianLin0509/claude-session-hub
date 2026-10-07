'use strict';
// 2026-10-07：Claude 答完后后台还有 Shell / Monitor 在跑，会话保持活跃；
// 引擎注入的 <task-notification> 续跑不是用户发言，不能确认未读。
// 真实界面行为见 tests/e2e-claude-background-active-cdp.js。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyPromptSubmitted, applyReplyCompleted, sessionHasCompletedUnread } = require('../core/session-attention-state');
const { isTaskNotificationText } = require('../core/claude-transcript-parser');

// 主目录按 core.autocrlf 检出为 CRLF，worktree 里可能是 LF：先统一换行再比对源码。
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');

test('task-notification text is recognised, user text is not', () => {
  assert.equal(isTaskNotificationText('<task-notification>\n<task-id>b1</task-id>\n</task-notification>'), true);
  assert.equal(isTaskNotificationText('  \n<task-notification>x'), true);
  assert.equal(isTaskNotificationText('请看一下 <task-notification> 这个标签'), false);
  assert.equal(isTaskNotificationText(null), false);
});

test('an injected continuation keeps the unread reply; a real prompt acknowledges it', () => {
  const s = { status: 'idle', unreadCount: 0 };
  applyPromptSubmitted(s, { submittedAt: 1000 });
  applyReplyCompleted(s, { completedAt: 2000, text: 'watching', keepRunning: true });
  assert.equal(s.unreadCount, 1);
  assert.equal(s.status, 'running');

  const injected = applyPromptSubmitted(s, { submittedAt: 3000, acknowledgesReply: false });
  assert.equal(injected.applied, true);
  assert.equal(s.unreadCount, 1);
  assert.equal(sessionHasCompletedUnread(s), true);

  applyReplyCompleted(s, { completedAt: 4000, text: 'tick 1', keepRunning: true });
  assert.equal(s.unreadCount, 2);

  applyPromptSubmitted(s, { submittedAt: 5000 });
  assert.equal(s.unreadCount, 0);
  assert.equal(sessionHasCompletedUnread(s), false);
});

test('PTY Claude transcript completion defers to live background tasks reported by Stop', () => {
  const src = read('renderer/renderer.js');
  const fn = src.slice(src.indexOf('function onReplyCompleteFromTranscriptEvent('));
  const ptyBranch = fn.slice(fn.indexOf("session.runtimeBackend !== 'claude-stream-json'"), fn.indexOf("source: 'claude-transcript-complete'"));
  assert.match(ptyBranch, /activeClaudeBackgroundTasks\(session\._claudeBackgroundTasks\)\.length > 0/);

  const stop = src.slice(src.indexOf('function onReplyCompleteFromHook('), src.indexOf('function onClaudeNeedsInput('));
  const bg = stop.slice(stop.indexOf("source: 'claude-background-tasks'"));
  assert.match(bg.slice(0, 400), /observedAt: Math\.max\(transition\.at, Date\.now\(\)\)/,
    'the Stop background observation must not lose to a transcript completion processed just before it');

  const prompt = src.slice(src.indexOf('function onPromptSubmittedFromHook('));
  assert.match(prompt.slice(0, 1600), /acknowledgesReply: !injected/);
  assert.match(prompt.slice(0, 1600), /if \(!injected\) session\._claudeBackgroundTasks = \[\];/);
});

test('main marks injected continuations and never uses them as the user preview', () => {
  const main = read('main.js');
  assert.match(main, /const injectedContinuation = event === 'prompt' && isTaskNotificationText\(parsed\.prompt\);/);
  assert.match(main, /if \(!injectedContinuation && typeof parsed\.prompt === 'string'/);
  assert.match(main, /injectedContinuation,\n/);
  const reader = main.slice(main.indexOf('async function readLastUserMessage('));
  assert.match(reader.slice(0, 3000), /isTaskNotificationText\(text\)\) continue;/);
});
