'use strict';
// 2026-09-26 PTY 深潜：停止按钮与空会话分支。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendPtyAgentInterrupt } = require('../renderer/pty-interrupt');

test('PTY stop sends one Esc while working and ignores idle states and rapid repeats', () => {
  const sent = [];
  const send = data => sent.push(data);
  const session = {};
  assert.equal(sendPtyAgentInterrupt(session, { state: 'idle', send, now: 1000 }), false, 'idle: Esc Esc would open message backtrack');
  assert.equal(sendPtyAgentInterrupt(session, { state: 'running', send, now: 1000 }), true);
  assert.equal(sendPtyAgentInterrupt(session, { state: 'running', send, now: 1200 }), false, 'double click within the window');
  assert.equal(sendPtyAgentInterrupt(session, { state: 'waiting', send, now: 3000 }), true, 'a permission prompt is cancelled by Esc');
  assert.deepEqual(sent, ['\x1b', '\x1b'], 'never Ctrl+C: a second Ctrl+C makes Codex shut down');
});

test('composer and group-member stops route PTY Claude/Codex through the shared Esc helper', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const stopAt = renderer.indexOf("stopBtn.className = 'floating-input-stop'");
  const block = renderer.slice(stopAt, renderer.indexOf("const sendBtn = document.createElement('button')", stopAt));
  assert.ok(block.indexOf("require('./pty-interrupt').sendPtyAgentInterrupt") < block.indexOf("data: '\\x03'"),
    'PTY agents return before the Ctrl+C fallback used by plain shells');
  const room = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  assert.match(room, /const memberRuntimeState = session => session\?\.agentRuntime === 'pty'\s*\? require\('\.\.\/core\/session-runtime-truth\.js'\)\.getSessionRuntimeTruth\(session\)\.state/);
  assert.match(room, /running: session => \['running','waiting'\]\.includes\(memberRuntimeState\(session\)\)/);
  assert.match(room, /if \(session\?\.agentRuntime === 'pty'\) \{\s*require\('\.\/pty-interrupt'\)\.sendPtyAgentInterrupt/);
});

test('forking a Claude session that never chatted starts fresh instead of a dead --fork-session', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-empty-fork-'));
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(root, 'hub');
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; fs.rmSync(root, { recursive: true, force: true }); });
  const { buildClaudePtyLaunch } = require('../core/session-manager')._private;
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  const src = '11111111-2222-4333-8444-555555555555';
  const empty = buildClaudePtyLaunch('hub-f', 'claude', { model: 'm', forkCCSessionId: src }, cwd, env, { CLAUDE_BACKEND: 'subscription' });
  assert.doesNotMatch(empty.cmd, /--fork-session/, 'no conversation to fork: the CLI would print "No conversation found" and exit');
  assert.match(empty.cmd, new RegExp(`--session-id ${empty.sessionId}`));
  assert.notEqual(empty.sessionId, src);
  // 源会话在别的目录桶里也算有历史（按 id 全局查找）。
  const other = path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'C--elsewhere'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, src + '.jsonl'), '{}\n');
  const real = buildClaudePtyLaunch('hub-g', 'claude', { model: 'm', forkCCSessionId: src }, cwd, env, { CLAUDE_BACKEND: 'subscription' });
  assert.match(real.cmd, new RegExp(`--resume ${src} --fork-session --session-id ${real.sessionId}`));
});
