const assert = require('assert');
const {
  codexTextFromContent,
  codexTextFromPayload,
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

console.log('transcript-payload-utils.test.js OK');
