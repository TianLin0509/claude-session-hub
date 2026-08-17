const assert = require('assert');
const {
  codexTextFromContent,
  codexTextFromPayload,
  codexUserMessageEventFromRecord,
  timestampToMs,
} = require('../core/transcript-payload-utils.js');

assert.strictEqual(codexTextFromContent('hello'), 'hello');
assert.strictEqual(
  codexTextFromContent(['a', { text: 'b' }, { content: 'c' }, null, { nope: 'x' }]),
  'a\nb\nc',
);
assert.strictEqual(codexTextFromContent({ text: 'object text' }), 'object text');
assert.strictEqual(codexTextFromContent({ content: [{ text: 'nested' }] }), 'nested');
assert.strictEqual(codexTextFromContent({ nope: true }), '');

assert.strictEqual(codexTextFromPayload({ message: 'm', text: 't' }), 'm');
assert.strictEqual(codexTextFromPayload({ text: 't' }), 't');
assert.strictEqual(codexTextFromPayload({ content: [{ text: 'c' }] }), 'c');
assert.strictEqual(codexTextFromPayload(null), '');

assert.strictEqual(timestampToMs(null), null);
assert.strictEqual(timestampToMs('not a date'), null);
assert.strictEqual(timestampToMs('2026-05-22T00:00:00.000Z'), Date.UTC(2026, 4, 22));

assert.deepStrictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T08:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: ' legacy prompt ' },
  }),
  {
    text: 'legacy prompt',
    submittedAt: Date.UTC(2026, 7, 16, 8),
    turnId: null,
    signalSource: 'user_message',
  },
);

assert.deepStrictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T09:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-0147',
      item: {
        type: 'UserMessage',
        id: 'user-item-1',
        content: [{ type: 'text', text: ' 0.147 prompt ', text_elements: [] }],
      },
    },
  }),
  {
    text: '0.147 prompt',
    submittedAt: Date.UTC(2026, 7, 16, 9),
    turnId: 'turn-0147',
    signalSource: 'item_completed_user_message',
  },
);

assert.strictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T09:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected context' }] },
  }),
  null,
  'response_item user records also contain injected context and are not authoritative submit events',
);

assert.strictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T09:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'answer' }] } },
  }),
  null,
);

console.log('transcript-payload-utils.test.js OK');
