'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TranscriptTap, CodexTap } = require('../core/transcript-tap');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await wait(40); }
  assert.ok(predicate(), 'Transcript update arrived within 3.2 seconds');
}
const append = (file, record) => fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');

test('Claude real JSONL tail forwards UPDATE without completing the turn', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-claude-tail-'));
  const file = path.join(dir, 'fixture.jsonl'); fs.writeFileSync(file, '');
  const tap = new TranscriptTap(), updates = [], completed = [];
  t.after(() => tap.unregisterSession('claude-fixture'));
  tap.on('progress-update', event => updates.push(event));
  tap.on('turn-complete', event => completed.push(event));
  tap.registerSession('claude-fixture', 'claude', { cwd: dir });
  await tap.notifyClaudeStop('claude-fixture', file);
  completed.length = 0;
  const record = text => ({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] } });
  append(file, record('UPDATE: 正在验证窗口布局'));
  await until(() => updates.length === 1);
  assert.equal(updates[0].text, '正在验证窗口布局');
  assert.equal(updates[0].hubSessionId, 'claude-fixture');
  assert.equal(completed.length, 0, 'Informational updates do not supply completion');
  append(file, record('```\nUPDATE: 代码示例\n```\n> UPDATE: 引用'));
  append(file, record('PROGRESS: 最终交接\nVERIFIED: 已验证'));
  await wait(400);
  assert.equal(updates.length, 1, 'Quoted text and final handoff are not live UPDATE');
});

test('Codex real JSONL tail fences historical updates and supports both event layouts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-codex-tail-'));
  const uuid = '019fbbbb-0000-7000-8000-000000000009';
  const file = path.join(dir, `rollout-2026-09-05T00-00-00-${uuid}.jsonl`);
  const old = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(file, '');
  append(file, { type: 'session_meta', timestamp: old, payload: { id: uuid, cwd: dir, source: 'cli' } });
  append(file, { type: 'event_msg', timestamp: old, payload: { type: 'agent_message', message: 'UPDATE: 历史进展' } });
  const tap = new CodexTap({ sessionsRoot: dir, pollIntervalMs: 60000 }), updates = [], completed = [];
  t.after(() => tap.unregisterSession('codex-fixture'));
  tap.on('progress-update', event => updates.push(event));
  tap.on('turn-complete', event => completed.push(event));
  tap.registerSession('codex-fixture', { cwd: dir });
  assert.equal(await tap._bindRolloutToHubSession('codex-fixture', file, uuid), true);
  await wait(60); assert.equal(updates.length, 0);
  append(file, { type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'agent_message', message: 'UPDATE: 正在检查配置兼容性' } });
  await until(() => updates.length === 1);
  append(file, { type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', text: 'UPDATE: 正在运行压力测试' } } });
  await until(() => updates.length === 2);
  assert.deepEqual(updates.map(event => event.text), ['正在检查配置兼容性', '正在运行压力测试']);
  assert.equal(completed.length, 0);
});
