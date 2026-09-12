'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureClaudeMessage: capture, claudeTranscriptTurns: cards } = require('../core/claude-native-transcript');

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
  assert.deepEqual(assistant.usage, { input_tokens: 100, output_tokens: 5 });
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
