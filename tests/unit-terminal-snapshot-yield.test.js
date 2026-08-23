'use strict';

const assert = require('node:assert/strict');
const { _private } = require('../core/terminal-snapshot.js');

(async () => {
  const chunkSize = _private.TERMINAL_REPLAY_CHUNK_CHARS;
  const source = `${'a'.repeat(chunkSize - 1)}😀${'b'.repeat(chunkSize + 17)}`;
  const chunks = [];
  let eventLoopYielded = false;
  setImmediate(() => { eventLoopYielded = true; });

  await _private.writeTerminal({
    write(value, callback) {
      chunks.push(value);
      callback();
    },
  }, source);

  assert.ok(chunks.length >= 3, 'large terminal replay must be split into bounded writes');
  assert.equal(chunks.join(''), source, 'chunking must preserve the exact terminal stream');
  assert.equal(eventLoopYielded, true, 'large replay must yield to Electron/Node between chunks');
  assert.ok(chunks.every(chunk => chunk.length <= chunkSize + 1));
  assert.equal(chunks.some(chunk => /[\uD800-\uDBFF]$/.test(chunk)), false,
    'a chunk must not end with an unpaired high surrogate');

  console.log('unit-terminal-snapshot-yield OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
