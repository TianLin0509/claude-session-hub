'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCodexRolloutToTurns } = require('../core/codex-transcript-parser.js');

function line(value) {
  return JSON.stringify(value) + '\n';
}

test('Codex turn ids stay stable across full, moving-tail and partial-to-final parses', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-stable-id-'));
  const rollout = path.join(root, 'rollout.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const turnId = '019fb6d2-f9fc-7241-aeaa-4018501e1d76';
  const timestamp = '2026-07-31T06:18:27.714Z';
  fs.writeFileSync(rollout, [
    line({ type: 'session_meta', payload: { id: 'sid', cwd: root } }),
    // Force the optimized parser down its 8 MB tail-window path. The window
    // starts inside this ignored record, so source line indexes differ from a
    // full parse exactly as they do in a long production rollout.
    line({ type: 'ignored-padding', payload: 'x'.repeat(9 * 1024 * 1024) }),
    line({ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
    line({ timestamp: '2026-07-31T06:18:28.201Z', type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } }),
    line({ timestamp: '2026-07-31T06:18:28.201Z', type: 'event_msg', payload: { type: 'user_message', message: '问题' } }),
    line({ timestamp: '2026-07-31T06:18:37.684Z', type: 'event_msg', payload: { type: 'agent_message', message: '处理中', phase: 'commentary' } }),
  ].join(''), 'utf8');

  const fullPartial = parseCodexRolloutToTurns(rollout);
  const tailPartial = parseCodexRolloutToTurns(rollout, { limit: 2, fromTail: true });
  assert.deepEqual(tailPartial.map(turn => turn.id), fullPartial.slice(-2).map(turn => turn.id));
  assert.equal(new Set(tailPartial.map(turn => turn.id)).size, 2);
  assert.ok(tailPartial[0].id.startsWith('codex-user-2026-07-31T06:18:28.201Z-'));
  assert.ok(tailPartial[1].id.startsWith('codex-assistant-2026-07-31T06:18:37.684Z-'));
  assert.equal(tailPartial[1].stopReason, 'partial_commentary');

  fs.appendFileSync(rollout, [
    line({ timestamp: '2026-07-31T06:19:00.000Z', type: 'ignored-growth', payload: 'y'.repeat(512 * 1024) }),
    line({ timestamp: '2026-07-31T06:23:53.251Z', type: 'event_msg', payload: {
      type: 'task_complete', turn_id: turnId, last_agent_message: '最终答案', duration_ms: 325537,
    } }),
  ].join(''), 'utf8');

  const fullFinal = parseCodexRolloutToTurns(rollout);
  const tailFinal = parseCodexRolloutToTurns(rollout, { limit: 2, fromTail: true });
  assert.deepEqual(tailFinal.map(turn => turn.id), fullFinal.slice(-2).map(turn => turn.id));
  assert.equal(tailFinal[1].id, tailPartial[1].id);
  assert.equal(tailFinal[1].text, '最终答案');
  assert.equal(tailFinal[1].stopReason, 'task_complete');
});

test('legacy Codex records without native ids use content-stable ids, never slice line numbers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-legacy-id-'));
  const rollout = path.join(root, 'rollout.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(rollout, [
    line({ type: 'ignored-padding', payload: 'z'.repeat(9 * 1024 * 1024) }),
    line({ timestamp: '2026-01-01T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: '旧问题' } }),
    line({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '旧答案' } }),
  ].join(''), 'utf8');
  const full = parseCodexRolloutToTurns(rollout);
  const tail = parseCodexRolloutToTurns(rollout, { limit: 2, fromTail: true });
  assert.deepEqual(tail.map(turn => turn.id), full.map(turn => turn.id));
  assert.ok(tail.every(turn => !/-\d+$/.test(turn.id)), 'id must not end in a slice-relative line index');
});
