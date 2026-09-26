'use strict';
// 2026-09-26 真机：「重启 Hub 并继续」对 PTY 默认下的 Claude / Codex 失效。
//   Codex：计划 before=working，重启后报「此提供方缺少执行状态」（续作只放行 kimi/gemini/deepseek）；
//   Claude：它的开工来自 UserPromptSubmit hook，追踪器不认，重启计划一律记成空闲；
//   续作即便发出，PTY 的 hook 确认来源也不在接受名单里，结果报「未得到原生提交确认」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRestartLegacyTracker } = require('../core/hub-restart-legacy');

test('a PTY Claude/Codex turn started after the tracker exists is recorded as working, then settles', () => {
  const tap = new EventEmitter(), sm = new EventEmitter();
  const sessions = {
    pty: { id: 'pty', kind: 'claude', agentRuntime: 'pty', ccSessionId: '11111111-2222-4333-8444-555555555555' },
    native: { id: 'native', kind: 'claude', runtimeBackend: 'claude-stream-json', nativeRuntime: { state: 'running' }, ccSessionId: '11111111-2222-4333-8444-666666666666' },
  };
  sm.getSession = id => sessions[id];
  const tracker = createRestartLegacyTracker(tap, sm, 100);
  sm.emit('agent-turn-started', { sessionId: 'pty', observedAt: 99, signalSource: 'claude-user-prompt-submit' });
  assert.equal(tracker.state(sessions.pty), null, 'history before this Hub started is not new work');
  sm.emit('agent-turn-started', { sessionId: 'pty', observedAt: 101, signalSource: 'claude-user-prompt-submit' });
  assert.equal(tracker.state(sessions.pty), 'working');
  sm.emit('agent-turn-started', { sessionId: 'native', observedAt: 101 });
  assert.equal(tracker.state(sessions.native), null, 'native sessions classify from their own snapshot');
  tap.emit('turn-complete', { hubSessionId: 'pty', completedAt: 150 });
  assert.equal(tracker.state(sessions.pty), 'idle');
});

test('PTY Claude/Codex continuations are prepared and accepted on semantic hook/rollout confirmation only', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'hub-restart-handlers.js'), 'utf8');
  assert.match(handlers, /const ptyAgent=session\?\.agentRuntime === 'pty' && \['claude','codex'\]\.includes\(base\);/);
  assert.match(handlers, /if \(!ptyAgent && !\['kimi','gemini','deepseek'\]\.includes\(base\)\) throw/);
  const restart = fs.readFileSync(path.join(__dirname, '..', 'core', 'hub-restart.js'), 'utf8');
  const block = restart.slice(restart.indexOf('const accepted ='), restart.indexOf("续作未得到原生提交确认"));
  for (const source of ['claude-user-prompt-submit', 'codex-user-prompt-submit', 'task_started']) assert.ok(block.includes(`'${source}'`), source);
  assert.doesNotMatch(block, /'pty-/, 'a repaint-only guess is still reported for review, never auto-resent');
  assert.match(block, /\['ok','auto_recovered'\]\.includes\(result\?\.sendStatus\)/);
});
