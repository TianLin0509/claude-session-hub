'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { TerminalWriteQueue } = require('../core/terminal-write-queue');

test('thousands of fragmented terminal packets retain order without thousands of timer turns', async () => {
  const writes = [], callbacks = [];
  const queue = new TerminalWriteQueue({ write(data, done) { writes.push(data); callbacks.push(done); } });
  queue.enqueue('first');
  await Promise.resolve();
  const payload = '\x1b[38;2;33;58;43m中文🙂\x1b[0m'.repeat(100);
  for (const char of payload) queue.enqueue(char);
  assert.equal(writes.length, 1);
  callbacks.shift()();
  await Promise.resolve();
  assert.equal(writes.length, 2);
  callbacks.shift()();
  await queue.drain();
  assert.equal(writes.join(''), 'first' + payload);
});

test('real xterm preserves colors, cursor and Unicode after fragmented input', async () => {
  const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  const queue = new TerminalWriteQueue(terminal);
  const bytes = '\x1b[48;2;33;58;43m中文🙂\x1b[0m\r\nImprove documentation in @filename';
  for (const char of bytes) queue.enqueue(char);
  await queue.drain();
  assert.equal(terminal.buffer.active.getLine(0).getCell(0).getBgColor(), 0x213a2b);
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '中文🙂');
  assert.equal(terminal.buffer.active.getLine(1).translateToString(true), 'Improve documentation in @filename');
  queue.dispose(); terminal.dispose();
});

test('parser failures are reported and cannot be mistaken for a current screen', async () => {
  const reports = [], failure = new Error('parser failure');
  const queue = new TerminalWriteQueue({ write() { throw failure; } }, e => reports.push(e));
  queue.enqueue('data');
  await assert.rejects(queue.drain(), failure);
  assert.deepEqual(reports, [failure]);
  queue.enqueue('more');
  await assert.rejects(queue.drain(), failure);
});

test('closing a session releases an outstanding parser wait', async () => {
  const queue = new TerminalWriteQueue({ write() {} });
  queue.enqueue('pending');
  await Promise.resolve();
  const draining = queue.drain();
  queue.dispose();
  await draining;
  assert.equal(queue.pending.length, 0);
});

test('a screen probe has a finite barrier even when the CLI keeps streaming', async () => {
  const callbacks=[];
  const queue=new TerminalWriteQueue({write(_data,done){callbacks.push(done);}});
  queue.enqueue('first frame');await Promise.resolve();
  const firstProbe=queue.drain();
  queue.enqueue('new output');callbacks.shift()();
  await firstProbe;
  assert.equal(queue.completed,1);
  assert.equal(queue.accepted,2);
  callbacks.shift()();await queue.drain();queue.dispose();
});
