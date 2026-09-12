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
