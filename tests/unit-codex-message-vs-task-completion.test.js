'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');
const { parseCodexRolloutToTurns } = require('../core/codex-transcript-parser');
const { applyPromptSubmitted, applyReplyCompleted, clearSessionCompletedUnread } = require('../core/session-attention-state');
const { applySessionRuntimeObservation, sessionRuntimeIsActive } = require('../core/session-runtime-truth');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(20); }
  assert.fail('Codex lifecycle event did not arrive');
}

// Real incident: 0.159.3 emitted a final_answer question at 02:59:03,
// then kept working in the same turn past 03:16 without task_complete.
test('a final_answer message remains active and readable until the task receipt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-message-task-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const tap = new CodexTap({ sessionsRoot: path.join(root, 'sessions'), pollIntervalMs: 30 });
  const rollout = new FakeCodexRollout({ sessionsRoot: path.join(root, 'sessions'), cwd, cliVersion: '0.159.3' });
  const session = { id: 'hub', kind: 'codex', agentRuntime: 'pty', status: 'idle', unreadCount: 0 };
  const completions = [], aborts = [];
  tap.on('turn-aborted', ev => aborts.push(ev));
  t.after(async () => { tap.unregisterSession('hub'); await rollout.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await rollout.start();
  tap.on('turn-started', ev => {
    applyPromptSubmitted(session, { submittedAt: ev.startedAt, turnId: ev.turnId });
    applySessionRuntimeObservation(session, { state: 'running', confidence: 'authoritative', observedAt: ev.startedAt, turnId: ev.turnId });
  });
  tap.on('turn-complete', ev => {
    completions.push(ev);
    applyReplyCompleted(session, ev);
    applySessionRuntimeObservation(session, { state: 'completed', confidence: 'authoritative', observedAt: ev.completedAt, turnId: ev.turnId });
  });
  tap.registerSession('hub', { cwd });
  assert.equal(await tap.bindFromHook('hub', { codexSid: rollout.sid, transcriptPath: rollout.rolloutPath }), true);
  const write = payload => rollout.writeRaw({ type: 'event_msg', timestamp: new Date().toISOString(), payload });
  const message = (phase, text) => write({ type: 'item_completed', turn_id: 'turn', item: { type: 'AgentMessage', phase, content: [{ type: 'Text', text }] } });
  await write({ type: 'task_started', turn_id: 'turn' });
  await until(() => sessionRuntimeIsActive(session));
  await message('final_answer', '请补充手机型号，我会继续研究');
  await rollout.writeRaw({ type: 'response_item', timestamp: new Date().toISOString(), payload: {
    type: 'custom_tool_call', id: 'still-running-tool', call_id: 'still-running-tool', name: 'exec', input: 'continue working',
  } });
  await delay(1200);
  assert.equal(completions.length, 0, 'message completion must not close the task');
  clearSessionCompletedUnread(session);
  assert.equal(sessionRuntimeIsActive(session), true, 'reading the message must retain active status');
  let card = parseCodexRolloutToTurns(rollout.rolloutPath).at(-1);
  assert.match(card.text, /手机型号/, 'message is still readable');
  assert.equal(card.nativeOutcome, null, 'card cannot claim completion');
  assert.equal(card.stopReason, 'partial_commentary', 'auto extraction cannot consume an unfinished answer');
  assert.equal(card.toolCalls.at(-1).status, 'running', 'a final message must not settle unfinished tools');
  await message('commentary', '正在继续检索');
  await delay(650);
  assert.equal(completions.length, 0);
  await message('final_answer', '完整方案');
  await delay(650);
  assert.equal(completions.length, 0);
  await write({ type: 'task_complete', turn_id: 'turn', last_agent_message: null });
  await until(() => completions.length === 1);
  assert.equal(completions[0].text, '完整方案', 'empty receipt retains the latest answer for the same turn');
  assert.equal(sessionRuntimeIsActive(session), false);
  assert.equal(session.unreadCount, 1);
  card = parseCodexRolloutToTurns(rollout.rolloutPath).at(-1);
  assert.equal(card.nativeOutcome, 'completed');
  assert.equal(card.stopReason, 'task_complete');
  assert.equal(card.text, '完整方案');
  clearSessionCompletedUnread(session);
  await write({ type: 'task_complete', turn_id: 'turn', last_agent_message: '完整方案' });
  await delay(650);
  assert.equal(session.unreadCount, 0, 'duplicate receipt cannot restore unread after reading');
  assert.equal(completions.length, 1);
  await write({ type: 'task_started', turn_id: 'compact' });
  await write({ type: 'task_complete', turn_id: 'compact', last_agent_message: null });
  await until(() => aborts.length === 1);
  assert.equal(completions.length, 1, 'an empty new turn must not reuse the previous answer');
  assert.equal(aborts[0].signalSource, 'task_complete_without_answer');
});
