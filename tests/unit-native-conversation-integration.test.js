'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureClaudeMessage, claudeTranscriptTurns, claudeDisplayMessages } = require('../core/claude-native-transcript');
const { createGroupConversationCollector } = require('../core/group-conversation-history');
const assistant = (id, text) => ({ type: 'assistant', uuid: 'frame-' + id,
  message: { id, content: [{ type: 'text', text }] } });

test('partial native Claude identity survives completion; progress is preserved separately', () => {
  const record = { submissionId: 'attempt-B', userMessageId: 'input-B', text: 'prompt', status: 'accepted', createdAt: 100 };
  captureClaudeMessage(record, assistant('first', 'same text'));
  captureClaudeMessage(record, { type: 'stream_event', event: { type: 'message_start', message: { id: 'second' } } });
  captureClaudeMessage(record, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'same' } } });
  const live = claudeDisplayMessages(record);
  captureClaudeMessage(record, assistant('second', 'same text'));
  record.status = 'completed'; record.finalText = 'same text';
  const done = claudeDisplayMessages(record);
  assert.deepEqual(done.map(m => m.id), live.map(m => m.id));
  assert.deepEqual(done.map(m => m.text), ['same text', 'same text']);
  assert.deepEqual(done.map(m => m.phase), ['commentary', 'final_answer']);
  assert.ok(done.every(m => m.clientSubmissionId === 'attempt-B' && m.userMessageId === 'input-B'));
  assert.equal(claudeTranscriptTurns([record]).find(m => m.role === 'assistant').text, 'same text');
});

test('Claude result-only final and post-handoff item collection retain exact input identity', () => {
  const record = { submissionId: 'B', userMessageId: 'uuid-B', status: 'completed', finalText: 'final' };
  captureClaudeMessage(record, assistant('progress', 'progress'));
  const writes = [];
  const orch = { state: { attempts: { B: { sid: 's', userMessageId: 'uuid-B', status: 'handed_off' } } },
    recordDisplayMessages: (id, messages) => { writes.push([id, messages]); return true; } };
  const claude = { records: new Map([['B', record]]) };
  const collect = createGroupConversationCollector();
  assert.equal(collect({ claude, orch, sid: 's', event: { userMessageId: 'old-A' } }), false);
  assert.equal(collect({ claude, orch, sid: 'other', event: { clientSubmissionId: 'B' } }), false);
  assert.equal(collect({ claude, orch, sid: 's', event: { userMessageId: 'uuid-B' } }), true);
  assert.deepEqual(writes[0][1].map(m => m.text), ['progress', 'final']);
  assert.equal(orch.state.attempts.B.status, 'handed_off');
  orch.state.attempts.B.userMessageId = 'foreign';
  assert.equal(collect({ claude, orch, sid: 's', event: { clientSubmissionId: 'B' } }), false);
});
