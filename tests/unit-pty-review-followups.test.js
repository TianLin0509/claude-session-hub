'use strict';
// 2026-09-26 独立审查对 PTY 深潜修复提出的四个问题的回归。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SessionManager } = require('../core/session-manager');

const SID = '01a0dd92-e239-7101-99bc-a34e5914fe81';
const ended = sid => `To\x1b[1Ccontinue\x1b[1Cthis\x1b[1Csession,\x1b[1Crun\x1b[1Ccodex\x1b[1Cresume\x1b[1C(${sid})\r\n`;

test('fresh output is still found after the ring buffer is full (its length stops growing)', () => {
  const sm = new SessionManager();
  sm.sessions.set('s', { ringBuffer: '', ringBufferLimit: 200, info: {} });
  sm._appendToRingBuffer('s', 'x'.repeat(500));
  assert.equal(sm.sessions.get('s').ringBuffer.length, 200);
  const mark = sm.getSessionOutputMark('s');
  sm._appendToRingBuffer('s', ended(SID));
  const fresh = sm.getSessionOutputSince('s', mark);
  assert.ok(fresh.endsWith(`(${SID})\r\n`) && !fresh.includes('xxx'), 'exactly the output written after the mark');
  sm._appendToRingBuffer('s', 'y'.repeat(1000));
  assert.equal(sm.getSessionOutputSince('s', mark).length, 200, 'if the fresh output was itself truncated, what remains is returned');
});

test('thread-ended evidence is dropped once the session binds a thread again (/resume back to it)', () => {
  const sm = new SessionManager();
  sm.sessions.set('s', { ringBuffer: '', info: {} });
  sm._appendToRingBuffer('s', ended(SID));
  sm.noteCodexThreadEnded('s', SID);
  assert.equal(sm.isCodexThreadEnded('s', SID), true);
  sm.noteCodexThreadBound('s');   // 改绑到新线程，随后又 /resume 回到 SID
  assert.equal(sm.isCodexThreadEnded('s', SID), false, 'a nested codex must not inherit the old /new evidence');
  sm._appendToRingBuffer('s', ended(SID));
  assert.equal(sm.isCodexThreadEnded('s', SID), true, 'a new /new typed after the rebind still counts');
});

test('rejected commands keep notSent; non-PTY sessions carry an explicit agentRuntime:null', () => {
  const submit = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), 'utf8');
  assert.match(submit, /\.\.\.\(result\.notSent \? \{notSent:true\} : \{\}\),/);
  const sm = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(sm, /\.\.\.\(isPtyAgent \? \{ runtimeBackend: null, nativeRuntime: null, agentRuntime: 'pty' \} : \{ agentRuntime: null \}\),/);
  assert.match(sm, /hookIntegrationWarning:info\.hookIntegrationWarning \|\| null\} : \{agentRuntime:null\}\),/);
  const hook = fs.readFileSync(path.join(__dirname, '..', 'main', 'codex-pty-hook.js'), 'utf8');
  assert.match(hook, /if \(incomingSid !== boundSid\) sessionManager\.noteCodexThreadBound\?\.\(hubSessionId\);/);
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  assert.match(watcher, /sessionManager\.getSessionOutputSince\(sid, fromMark\)/);
});
