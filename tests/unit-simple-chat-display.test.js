'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { displayChatTurns } = require('../renderer/simple-chat-display');
const { nativeTranscriptTurns } = require('../core/codex-native-transcript');
const { parseClaudeTranscriptText } = require('../core/claude-transcript-parser');
const { chatAvatarSrc, USER_AVATAR_SRC, ASSISTANT_AVATAR_SRC } = require('../renderer/chat-avatar');
const { ALL_AI_KINDS } = require('../core/ai-kinds');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('one reply keeps a stable anchor from activity through progress and final; source stays immutable', () => {
  const tool = { id: 'tool', name: 'exec_command', status: 'failed', result: 'Full evidence', exitCode: 1 };
  const project = messages => displayChatTurns(freeze([{ id: 'logical', role: 'assistant', kind: 'codex',
    text: 'Final source', toolCalls: [tool], nativeOutcome: 'completed', displayMessages: messages }]));
  const early = project([]), live = project([{ id: 'p1', phase: 'commentary', text: 'Investigating' }]);
  const full = 'Final body\n\n' + 'Long answer\n\n'.repeat(100);
  const done = project([{ id: 'p1', phase: 'commentary', text: 'Investigating' },
    { id: 'p2', phase: 'commentary', text: 'Checking' }, { id: 'f', phase: 'final_answer', text: full }]);
  assert.equal(early.length, 1); assert.equal(live.length, 1); assert.equal(done.length, 1);
  assert.equal(early[0].id, live[0].id); assert.equal(done[0].id, live[0].id);
  assert.equal(done[0].text, full);
  assert.deepEqual(done[0].chatProcessMessages.map(m => m.text), ['Investigating', 'Checking']);
  assert.equal(done[0].toolCalls[0].result, 'Full evidence');
  assert.equal(done[0].toolCalls[0].status, 'failed');
  assert.equal(done[0].deliveryContext.id, 'logical');
});

test('steering user messages remain boundaries and both sides retain their stable reply anchors', () => {
  const p1 = { id: 'p1', type: 'agentMessage', phase: 'commentary', text: 'First progress' };
  const u1 = { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'First input' }] };
  const u2 = { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Steer' }] };
  const p2 = { id: 'p2', type: 'agentMessage', phase: 'commentary', text: 'Second progress' };
  const f = { id: 'f', type: 'agentMessage', phase: 'final_answer', text: 'Final after steer' };
  const read = items => displayChatTurns(nativeTranscriptTurns('thread', [{ id: 'turn', status: 'inProgress', items }]));
  const early = read([u1, p1]), late = read([u1, p1, u2, p2, f]);
  assert.deepEqual(late.map(t => t.text), ['First input', 'First progress', 'Steer', 'Final after steer']);
  assert.equal(late[1].id, early[1].id); assert.notEqual(late[1].id, late[3].id);
  assert.deepEqual(late[3].chatProcessMessages.map(t => t.text), ['Second progress']);
});

test('multiple final provider items make one complete reply; legacy replies are never guessed into groups', () => {
  const source = [{ id: 't', role: 'assistant', displayMessages: [
    { id: 'f1', text: 'Part one', phase: 'final_answer' }, { id: 'f2', text: 'Part two', phase: 'final_answer' }] },
  { id: 'legacy', role: 'assistant', text: 'Older message' }, { id: 'legacy2', role: 'assistant', text: 'Older second' }];
  assert.deepEqual(displayChatTurns(source).map(t => t.text), ['Part one\n\nPart two', 'Older message', 'Older second']);
});

test('Claude logical response folds its process while keeping the final native message', () => {
  const records = [{ type: 'assistant', uuid: 'p', timestamp: '2026-10-01T10:00:00Z',
    message: { content: [{ type: 'text', text: 'Looking' }], stop_reason: 'tool_use' } },
  { type: 'assistant', uuid: 'f', timestamp: '2026-10-01T10:00:01Z',
    message: { content: [{ type: 'text', text: 'Result\n\nDetails' }], stop_reason: 'end_turn' } }];
  const result = displayChatTurns(parseClaudeTranscriptText(records.map(JSON.stringify).join('\n')));
  assert.equal(result.length, 1); assert.equal(result[0].text, 'Result\n\nDetails');
  assert.equal(result[0].chatProcessMessages[0].text, 'Looking');
});

test('all supported AI runtimes and resume aliases use existing original artwork; penguin is assistant-only', () => {
  for (const kind of ALL_AI_KINDS) for (const alias of [kind, `${kind}-resume`]) {
    const src = chatAvatarSrc(alias); assert(src, alias);
    assert(fs.existsSync(path.resolve(__dirname, '../renderer', src)), alias);
    assert.equal(chatAvatarSrc(alias, { assistant: true }), ASSISTANT_AVATAR_SRC);
  }
  assert.equal(chatAvatarSrc('deepseek-acp'), chatAvatarSrc('deepseek-legacy-resume'));
  assert.equal(chatAvatarSrc('codex'), chatAvatarSrc('gpt'));
  assert.equal(chatAvatarSrc('../../claude'), null);
  assert.equal(chatAvatarSrc('constructor'), null);
  assert.equal(chatAvatarSrc('__proto__'), null);
  assert(fs.existsSync(path.resolve(__dirname, '../renderer', USER_AVATAR_SRC)));
  const dir = path.resolve(__dirname, '../renderer/assets/ai-avatars/v1');
  for (const asset of JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json'), 'utf8'))) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, asset.file))).digest('hex'), asset.sha256);
  }
});
