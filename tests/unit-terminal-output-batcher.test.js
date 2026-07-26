'use strict';

const assert = require('node:assert');
const test = require('node:test');
const { TerminalOutputBatcher } = require('../main/terminal-output-batcher.js');

test('terminal output batcher preserves byte order and highest sequence', async () => {
  const emitted = [];
  const batcher = new TerminalOutputBatcher({
    delayMs: 5,
    emit: payload => emitted.push(payload),
  });
  for (let i = 1; i <= 100; i += 1) batcher.push('s1', `[${i}]`, i);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].sessionId, 's1');
  assert.strictEqual(emitted[0].data, Array.from({ length: 100 }, (_, i) => `[${i + 1}]`).join(''));
  assert.strictEqual(emitted[0].seq, 100);
  assert.deepStrictEqual(batcher.snapshotStats(), {
    pushedChunks: 100,
    emittedBatches: 1,
    inputBytes: emitted[0].data.length,
    outputBytes: emitted[0].data.length,
    maxBatchChunks: 100,
    pendingSessions: 0,
  });
});

test('terminal output batcher isolates sessions and flushes at its byte cap', () => {
  const emitted = [];
  const batcher = new TerminalOutputBatcher({
    delayMs: 1000,
    maxBytes: 1024,
    emit: payload => emitted.push(payload),
  });
  batcher.push('a', 'a'.repeat(600), 1);
  batcher.push('b', 'b', 2);
  batcher.push('a', 'a'.repeat(600), 3);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].sessionId, 'a');
  assert.strictEqual(emitted[0].data.length, 1200);
  assert.strictEqual(emitted[0].seq, 3);
  batcher.flushAll();
  assert.deepStrictEqual(emitted.map(item => item.sessionId), ['a', 'b']);
});

test('terminal output batcher can discard pending output on disposal', () => {
  const emitted = [];
  const batcher = new TerminalOutputBatcher({ delayMs: 1000, emit: value => emitted.push(value) });
  batcher.push('s1', 'pending', 1);
  batcher.dispose({ flush: false });
  assert.deepStrictEqual(emitted, []);
  assert.strictEqual(batcher.pending.size, 0);
});
