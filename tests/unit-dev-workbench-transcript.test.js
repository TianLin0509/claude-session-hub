'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TranscriptTap, CodexTap } = require('../core/transcript-tap');
const groupchat = require('../core/group-chat-orchestrator');
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
  assert.equal(updates[0].tag, 'UPDATE');
  assert.equal(updates[0].hubSessionId, 'claude-fixture');
  assert.equal(completed.length, 0, 'Informational updates do not supply completion');
  append(file, record('```\nUPDATE: 代码示例\n```\n> UPDATE: 引用'));
  append(file, record('PROGRESS: 最终交接\nVERIFIED: 已验证'));
  await wait(400);
  assert.equal(updates.length, 1, 'Quoted text and final handoff are not live UPDATE');
});

// 2026-09-06 合并位 FAIL 的复现：实时入口只认 UPDATE，agent 开工前写的 PLAN 和
// 中途写的 ASK 一条都进不了群聊状态，工作台自然显示不出方案和待拍板的问题。
test('Claude real JSONL tail forwards PLAN and ASK, in the order they were written', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-claude-plan-'));
  const file = path.join(dir, 'fixture.jsonl'); fs.writeFileSync(file, '');
  const tap = new TranscriptTap(), updates = [];
  t.after(() => tap.unregisterSession('claude-plan'));
  tap.on('progress-update', event => updates.push(event));
  tap.registerSession('claude-plan', 'claude', { cwd: dir });
  await tap.notifyClaudeStop('claude-plan', file);
  const record = text => ({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] } });

  // 开工前的方案：多行正文要整段带过来，不是只留标签那一行
  append(file, record('PLAN: 打算分两步\n先把解析器改成能吃多行，再让工作台把纪事排开。'));
  await until(() => updates.length === 1);
  assert.equal(updates[0].tag, 'PLAN');
  assert.equal(updates[0].text, '打算分两步\n先把解析器改成能吃多行，再让工作台把纪事排开。');

  // 同一条消息里既有进展又有提问：各自成一条，按原文顺序
  append(file, record('UPDATE: 解析器改完了\nASK: 手机推送要不要现在做？\n做的话多半天。'));
  await until(() => updates.length === 3);
  assert.deepEqual(updates.slice(1).map(event => event.tag), ['UPDATE', 'ASK']);
  assert.equal(updates[2].text, '手机推送要不要现在做？\n做的话多半天。');

  // 最终交接整条跳过：它走 completeTurn 落盘，实时再收一遍会让纪事出现重复记录
  append(file, record('ASK: 顺带一问\nPROGRESS: 做完了\nVERIFIED: 全过'));
  await wait(400);
  assert.equal(updates.length, 3, '最终交接那条消息不许同时进实时通道');
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
  assert.deepEqual(updates.map(event => event.tag), ['UPDATE', 'UPDATE']);
  assert.equal(completed.length, 0);

  // 双端回归（2026-09-06 合并位 FAIL）：Codex 这一侧同样必须把 PLAN / ASK 送出来
  append(file, { type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'agent_message', message: 'PLAN: 先读合同再动手\n改动集中在解析器。' } });
  await until(() => updates.length === 3);
  assert.equal(updates[2].tag, 'PLAN');
  assert.equal(updates[2].text, '先读合同再动手\n改动集中在解析器。');
  append(file, { type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', text: 'ASK: 这条要不要一起改？' } } });
  await until(() => updates.length === 4);
  assert.equal(updates[3].tag, 'ASK');
  append(file, { type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'agent_message', message: 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 全过\nNEXT: 无' } });
  await wait(300);
  assert.equal(updates.length, 4, '合并位裁决走 completeTurn 落盘，不许再进实时通道');
});

// 2026-09-06 合并位复现的回归：落盘层按「正文相同」去重，把 A→B→A 的第三条真进展
// 也当成重放拒了 —— agent 明明报了新进展，工作台还停在上一句。
// 这条用例把 tap 的事件按 main.js 的接法喂进真 orchestrator，双端各走一遍。
function feed(orch, sid) {
  return event => orch.recordProgressUpdate(sid, event.text, event.at, 'Agent', event);
}
function armTurn(dir, id, sid) {
  const orch = groupchat.getOrchestrator(dir, id);
  const { turnNum, runId } = orch.beginTurn('跑一轮');
  orch.recordTurnPrompt(turnNum, sid, '任务全文', { runId, memberId: 'm1', kind: 'claude' });
  return orch;
}
const liveTexts = orch => orch.state.messages
  .filter(m => m.status === 'progress_update').map(m => m.content);

test('Claude real JSONL: 同一句再说一遍要落盘，同一条记录重放不落盘', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-claude-repeat-'));
  const file = path.join(dir, 'fixture.jsonl'); fs.writeFileSync(file, '');
  const tap = new TranscriptTap();
  t.after(() => tap.unregisterSession('s-claude-repeat'));
  const orch = armTurn(dir, 'gc-claude-repeat', 's-claude-repeat');
  tap.on('progress-update', feed(orch, 's-claude-repeat'));
  tap.registerSession('s-claude-repeat', 'claude', { cwd: dir });
  await tap.notifyClaudeStop('s-claude-repeat', file);

  // 时间戳显式递增：三行若挤在同一毫秒，第三条会与第一条无法区分
  const base = Date.now();
  const record = (text, step) => ({ type: 'assistant', timestamp: new Date(base + step).toISOString(),
    message: { content: [{ type: 'text', text }] } });
  const three = [record('UPDATE: 开始跑单测', 1), record('UPDATE: 有一条红，正在修', 2), record('UPDATE: 开始跑单测', 3)];
  for (const line of three) append(file, line);
  await until(() => liveTexts(orch).length === 3);
  assert.deepEqual(liveTexts(orch),
    ['UPDATE: 开始跑单测', 'UPDATE: 有一条红，正在修', 'UPDATE: 开始跑单测'],
    'A→B→A 的第三条是真进展，不许当成重放丢掉');

  // 同样三行原样再喂一遍 = 尾随重连时的事件重放，一条都不该多出来
  for (const line of three) append(file, line);
  await wait(400);
  assert.equal(liveTexts(orch).length, 3, '重放不该新增记录');
});

test('Codex real JSONL: 同一句再说一遍要落盘，同一条记录重放不落盘', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-codex-repeat-'));
  const uuid = '019fbbbb-0000-7000-8000-00000000000a';
  const file = path.join(dir, `rollout-2026-09-06T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, '');
  append(file, { type: 'session_meta', timestamp: new Date(Date.now() - 60000).toISOString(),
    payload: { id: uuid, cwd: dir, source: 'cli' } });
  const tap = new CodexTap({ sessionsRoot: dir, pollIntervalMs: 60000 });
  t.after(() => tap.unregisterSession('s-codex-repeat'));
  const orch = armTurn(dir, 'gc-codex-repeat', 's-codex-repeat');
  tap.on('progress-update', feed(orch, 's-codex-repeat'));
  tap.registerSession('s-codex-repeat', { cwd: dir });
  assert.equal(await tap._bindRolloutToHubSession('s-codex-repeat', file, uuid), true);

  const base = Date.now();
  const msg = (text, step) => ({ type: 'event_msg', timestamp: new Date(base + step).toISOString(),
    payload: { type: 'agent_message', message: text } });
  const three = [msg('UPDATE: 开始跑单测', 1), msg('UPDATE: 有一条红，正在修', 2), msg('UPDATE: 开始跑单测', 3)];
  for (const line of three) append(file, line);
  await until(() => liveTexts(orch).length === 3);
  assert.deepEqual(liveTexts(orch),
    ['UPDATE: 开始跑单测', 'UPDATE: 有一条红，正在修', 'UPDATE: 开始跑单测']);

  for (const line of three) append(file, line);
  await wait(400);
  assert.equal(liveTexts(orch).length, 3, '重放不该新增记录');
});
