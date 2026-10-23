'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureClaudeMessage: capture, claudeTranscriptTurns: cards } = require('../core/claude-native-transcript');
const { displayChatTurns } = require('../renderer/simple-chat-display');

test('later work keeps every delivered native reply visible in the same compact message', () => {
  const record = { userMessageId: 'u', text: 'question', status: 'completed',
    createdAt: 1, completedAt: 10, finalText: 'Additional answer' };
  for (const [id, text, reason] of [['p1', 'Inspecting', 'tool_use'],
    ['f1', 'Initial answer', 'end_turn'], ['p2', 'Continuing work', 'tool_use'],
    ['f2', 'Additional answer', 'end_turn']]) {
    capture(record, { type: 'assistant', uuid: id,
      message: { id, stop_reason: reason, content: [{ type: 'text', text }] } });
  }
  const turns = cards([record]), displayed = displayChatTurns(turns);
  assert.equal(turns[1].text, 'Additional answer', 'authoritative latest-result extraction remains separate');
  assert.deepEqual(turns[1].displayMessages.map(m => m.phase),
    ['commentary', 'final_answer', 'commentary', 'final_answer']);
  assert.equal(displayed.length, 2, 'one user message and one AI message');
  assert.equal(displayed[1].text, 'Initial answer\n\nAdditional answer');
  assert.deepEqual(displayed[1].chatProcessMessages.map(m => m.text), ['Inspecting', 'Continuing work']);
});

test('Claude thinking summaries become timed progress rows in order, without a duplicate thinking blob', () => {
  const record = { userMessageId: 'u', text: 'go', status: 'completed', createdAt: 1, completedAt: 9, finalText: 'Done' };
  const frame = (uuid, id, at, content, reason = 'tool_use') => capture(record, { type: 'assistant', uuid,
    timestamp: new Date(at).toISOString(), message: { id, stop_reason: reason, content } });
  frame('a0', 'm1', 1000, [{ type: 'thinking', thinking: '' }]);
  frame('a1', 'm1', 2000, [{ type: 'thinking', thinking: '先核对配置，再改识别逻辑。' }]);
  frame('a2', 'm1', 2000, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
  frame('a3', 'm2', 3000, [{ type: 'text', text: '单测在跑。' }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }]);
  frame('a4', 'm3', 4000, [{ type: 'thinking', thinking: '44 个单测全部通过。' }]);
  frame('a5', 'm3', 5000, [{ type: 'text', text: 'Done' }], 'end_turn');
  const shown = displayChatTurns(cards([record]))[1];
  assert.equal(shown.text, 'Done');
  assert.deepEqual(shown.chatProcessMessages.map(m => [m.text, m.ts]),
    [['先核对配置，再改识别逻辑。', 2000], ['单测在跑。', 3000], ['44 个单测全部通过。', 4000]]);
  assert.equal(shown.thinking, null, 'the closed thinking drawer would repeat the rows');
  assert.equal(require('../core/claude-native-transcript').claudeDisplayMessages(record)
    .some(m => m.text?.includes('先核对配置')), false, 'group-chat replies stay free of thinking');
  const split = require('../core/conversation-display').displayTurns(cards([record]));
  assert.equal(split.filter(m => m.thinking).length, 0, 'split view does not repeat the rows as a thinking drawer');
});

test('a turn interrupted after thinking keeps its outcome notice; the note stays in 过程, never the answer', () => {
  const record = { userMessageId: 'u', text: 'go', status: 'accepted', createdAt: 1 };
  capture(record, { type: 'assistant', uuid: 'a1', timestamp: new Date(2000).toISOString(),
    message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '先看日志。' }] } });
  const running = displayChatTurns(cards([record]))[1];
  assert.equal(running.text, '', 'thinking stays separate from the answer while running');
  assert.deepEqual(running.chatProcessMessages.map(m=>m.text), ['先看日志。']);
  record.status = 'interrupted'; record.finalText = ''; record.completedAt = 3000;
  const stopped = displayChatTurns(cards([record]))[1];
  assert.equal(stopped.text, '');
  assert.equal(stopped.nativeOutcome, 'interrupted');
  assert.deepEqual(stopped.chatProcessMessages.map(m => m.text), ['先看日志。']);
});

test('stream and final message replace the same card without duplicate text', () => {
  const record = { submissionId: 'submission', userMessageId: 'user', text: 'question', status: 'accepted', createdAt: 1 };
  const stream = event => capture(record, { type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'assistant', role: 'assistant' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '中文 🧪' } });
  const before = cards([record]);
  assert.equal(before[1].text, '中文 🧪');
  capture(record, { type: 'assistant', uuid: 'a', message: { id: 'assistant', content: [{ type: 'text', text: '中文 🧪' }] } });
  const after = cards([record]);
  assert.equal(after[1].id, before[1].id);
  assert.equal(after[1].text, '中文 🧪');
  assert.equal(after.length, 2);
});

test('tool results link by call ID and empty completion still has an outcome card', () => {
  const record = { submissionId: 's', userMessageId: 'u', text: 'read', status: 'accepted' };
  capture(record, { type: 'assistant', uuid: 'a', message: { id: 'a', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'p' } }] } });
  capture(record, { type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'denied', is_error: true }] } });
  record.status = 'failed'; record.finalText = '';
  const result = cards([record]);
  assert.equal(result.length, 2);
  assert.equal(result[1].nativeOutcome, 'failed');
  assert.equal(result[1].toolCalls[0].status, 'failed');
  assert.equal(result[1].toolCalls[0].output, 'denied');
  assert.equal(record.status, 'failed');
});

test('cards carry the clock, tool duration, model and tokens the Codex cards show', () => {
  const record = { submissionId: 's', userMessageId: 'u', text: 'go', status: 'accepted', createdAt: 1000,
    model: 'claude-opus-5[1m]', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } };
  capture(record, { type: 'assistant', uuid: 'a1', timestamp: '2026-09-12T10:00:00.000Z',
    message: { id: 'a1', model: 'claude-opus-5[1m]', content: [{ type: 'text', text: '先说方案' }] } });
  capture(record, { type: 'assistant', uuid: 'a2', timestamp: '2026-09-12T10:00:20.000Z',
    message: { id: 'a2', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  capture(record, { type: 'user', uuid: 'r1', timestamp: '2026-09-12T10:00:23.500Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  record.status = 'completed'; record.finalText = '先说方案'; record.completedAt = 2000;
  const [, assistant] = cards([record]);
  // Each row has its own clock instead of every row repeating the turn start.
  assert.equal(assistant.displayMessages[0].ts, Date.parse('2026-09-12T10:00:00.000Z'));
  assert.equal(assistant.toolCalls[0].durationMs, 3500);
  assert.equal(assistant.toolCalls[0].startedAt, Date.parse('2026-09-12T10:00:20.000Z'));
  assert.equal(assistant.model, 'claude-opus-5[1m]');
  // Cached reads are real context tokens; the pill would understate without them.
  assert.deepEqual(assistant.usage, { input_tokens: 100, output_tokens: 5, context_tokens: null });
});

test('an unstamped frame is timed on arrival, never left without a clock', () => {
  const record = { submissionId: 's', userMessageId: 'u', text: 'go', status: 'accepted', createdAt: 1000 };
  const before = Date.now();
  capture(record, { type: 'assistant', uuid: 'a', message: { id: 'a', content: [{ type: 'text', text: 'hi' }] } });
  const [, assistant] = cards([record]);
  assert.ok(assistant.displayMessages[0].ts >= before, 'row time must be a real observation');
});

test('a message row carries no duration of its own, so only the turn shows one', () => {
  const record = { submissionId: 's', userMessageId: 'u', text: 'go', status: 'completed',
    createdAt: 1000, completedAt: 20000, finalText: 'done' };
  capture(record, { type: 'assistant', uuid: 'a', timestamp: '2026-09-12T10:00:05.000Z',
    message: { id: 'a', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  const [, assistant] = cards([record]);
  const row = assistant.displayMessages.at(-1);
  assert.equal(row.ts, row.tsEnd, 'a row must not inherit the turn end and invent a duration');
  // The turn itself still measures real elapsed time.
  assert.equal(assistant.ts, 1000);
  assert.equal(assistant.tsEnd, 20000);
});
