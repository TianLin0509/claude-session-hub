'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeTranscriptText } = require('../core/claude-transcript-parser');
const user = id => ({ type: 'user', uuid: id, message: { role: 'user', content: id } });
const answer = (id, text) => ({ type: 'assistant', uuid: id,
  message: { id: 'api-' + id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });

test('exact live identities never discard an unjournaled provider answer after a crash', () => {
  const raw = [user('old'), answer('old-answer', 'earlier'), user('live'), answer('unjournaled', 'answer before crash')]
    .map(JSON.stringify).join('\n');
  const turns = parseClaudeTranscriptText(raw, { excludeEntryIds: ['live'] });
  assert.deepEqual(turns.map(turn => turn.id), ['old', 'old-answer', 'unjournaled']);
  assert.equal(turns.at(-1).text, 'answer before crash');
});

test('known streamed messages deduplicate by provider identity and retain unrelated later activity', () => {
  const raw = [user('live'), answer('known', 'live answer'), answer('extra', 'later background')].map(JSON.stringify).join('\n');
  const turns = parseClaudeTranscriptText(raw, { excludeEntryIds: ['live'], excludeMessageIds: ['api-known'] });
  assert.deepEqual(turns.map(turn => turn.text), ['later background']);
});
