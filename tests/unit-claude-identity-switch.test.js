'use strict';
// 返工 R2：PTY Claude 在 /clear、/resume、退出重启后跟随新身份，嵌套进程和子代理照旧拒收。
// 事件顺序取自真机探针 tests/probe-claude-session-hooks.js（2026-09-25）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeIdentitySwitch } = require('../core/claude-identity-switch');

function clock() { let t = 1_000_000; return { now: () => t, advance: ms => { t += ms; } }; }

test('/clear: SessionEnd(bound, clear) then SessionStart(new, clear) rebinds', () => {
  const c = clock(), sw = createClaudeIdentitySwitch({ now: c.now });
  assert.equal(sw.observe('hub', { event: 'session-end', boundId: 'old', incomingId: 'old', reason: 'clear' }).action, 'record-end');
  c.advance(600);
  assert.equal(sw.observe('hub', { event: 'session-start', boundId: 'old', incomingId: 'new', source: 'clear' }).action, 'rebind');
  // 用过一次就作废：同一条结束记录不能再放行第二个身份。
  assert.equal(sw.observe('hub', { event: 'session-start', boundId: 'old', incomingId: 'other', source: 'clear' }).action, 'ignore');
});

test('nested `claude -p` inherits the Hub env: its SessionStart is rejected while the bound session runs', () => {
  const sw = createClaudeIdentitySwitch();
  for (const source of ['startup', 'resume', 'clear']) {
    const verdict = sw.observe('hub', { event: 'session-start', boundId: 'top', incomingId: 'nested', source });
    assert.equal(verdict.action, 'ignore', source);
    assert.equal(verdict.why, 'bound-session-still-running');
  }
  // 嵌套进程自己的 SessionEnd 不能替顶层会话宣布结束。
  assert.equal(sw.observe('hub', { event: 'session-end', boundId: 'top', incomingId: 'nested', reason: 'other' }).action, 'ignore');
  assert.equal(sw.observe('hub', { event: 'session-start', boundId: 'top', incomingId: 'nested2', source: 'startup' }).action, 'ignore');
});

test('subagent events never switch identity', () => {
  const sw = createClaudeIdentitySwitch();
  sw.observe('hub', { event: 'session-end', boundId: 'top', incomingId: 'top', reason: 'clear' });
  assert.equal(sw.observe('hub', { event: 'session-start', boundId: 'top', incomingId: 'sub', source: 'clear', agentId: 'agent-1' }).why, 'subagent');
});

test('clear/resume must follow the end promptly; a stale end does not open a window forever', () => {
  const c = clock(), sw = createClaudeIdentitySwitch({ now: c.now, windowMs: 30_000 });
  sw.observe('hub', { event: 'session-end', boundId: 'old', incomingId: 'old', reason: 'clear' });
  c.advance(31_000);
  assert.equal(sw.observe('hub', { event: 'session-start', boundId: 'old', incomingId: 'new', source: 'clear' }).action, 'ignore');
});

test('restart in the same shell: exit then startup rebinds; clear-end does not authorise a startup', () => {
  const c = clock(), sw = createClaudeIdentitySwitch({ now: c.now });
  sw.observe('hub', { event: 'session-end', boundId: 'old', incomingId: 'old', reason: 'prompt_input_exit' });
  c.advance(10 * 60_000); // 用户隔了很久才重新输入 claude
  assert.equal(sw.observe('hub', { event: 'session-start', boundId: 'old', incomingId: 'new', source: 'startup' }).action, 'rebind');

  const other = createClaudeIdentitySwitch({ now: c.now });
  other.observe('hub', { event: 'session-end', boundId: 'old', incomingId: 'old', reason: 'clear' });
  assert.equal(other.observe('hub', { event: 'session-start', boundId: 'old', incomingId: 'nested', source: 'startup' }).action, 'ignore');
});

test('same id (startup / compact) is a no-op, and sessions do not share end records', () => {
  const sw = createClaudeIdentitySwitch();
  assert.equal(sw.observe('a', { event: 'session-start', boundId: 'x', incomingId: 'x', source: 'compact' }).action, 'same');
  sw.observe('a', { event: 'session-end', boundId: 'x', incomingId: 'x', reason: 'clear' });
  assert.equal(sw.observe('b', { event: 'session-start', boundId: 'x', incomingId: 'y', source: 'clear' }).action, 'ignore');
});

test('/clear submission is acknowledged by the identity switch, not by a turn start', async () => {
  const { EventEmitter } = require('node:events');
  const { observeClaudeClearCommand } = require('../core/claude-identity-switch');
  const manager = new EventEmitter();
  const observer = observeClaudeClearCommand(manager, 'hub');
  setTimeout(() => manager.emit('claude-identity-switched', { sessionId: 'other' }), 10);
  setTimeout(() => manager.emit('claude-identity-switched', { sessionId: 'hub', to: 'new' }), 30);
  assert.deepEqual(await observer.wait(2000), { ok: true });
  observer.dispose();
  assert.equal(manager.listenerCount('claude-identity-switched'), 0);
  const silent = observeClaudeClearCommand(manager, 'hub');
  const miss = await silent.wait(100);
  assert.equal(miss.ok, false);
  silent.dispose();
});

test('/compact is acknowledged by the compaction signal; only clear/compact are treated as local commands', async () => {
  const { EventEmitter } = require('node:events');
  const { observeClaudeLocalCommand, claudeLocalCommand } = require('../core/claude-identity-switch');
  assert.equal(claudeLocalCommand('/compact'), 'compact');
  assert.equal(claudeLocalCommand('  /clear  '), 'clear');
  assert.equal(claudeLocalCommand('/compact 保留测试结论'), 'compact');
  assert.equal(claudeLocalCommand('/clearly not a command'), null);
  assert.equal(claudeLocalCommand('/model haiku'), null);
  assert.equal(claudeLocalCommand('请 /compact'), null);
  const manager = new EventEmitter();
  const observer = observeClaudeLocalCommand(manager, 'hub', 'compact');
  setTimeout(() => manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'other' }), 10);
  setTimeout(() => manager.emit('claude-local-command-ack', { sessionId: 'hub', command: 'compact' }), 30);
  assert.deepEqual(await observer.wait(2000), { ok: true });
  observer.dispose();
  assert.equal(manager.listenerCount('claude-local-command-ack'), 0);
});
