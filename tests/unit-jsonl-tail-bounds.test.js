'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JsonlTail } = require('../core/jsonl-tail.js');

function waitFor(predicate, timeoutMs = 2500) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for JSONL tail'));
      }
    }, 20);
  });
}

test('startAtEnd skips historical records and receives future appends', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-end-'));
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({ id: 'old' })}\n`);
  const seen = [];
  const tail = new JsonlTail(filePath, (record) => seen.push(record.id), { startAtEnd: true });
  t.after(() => tail.close());
  await tail.start();
  assert.deepEqual(seen, []);
  fs.appendFileSync(filePath, `${JSON.stringify({ id: 'new' })}\n`);
  await waitFor(() => seen.includes('new'));
  assert.deepEqual(seen, ['new']);
});

test('maxInitialBytes bounds bootstrap and discards a partial first line', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-bound-'));
  const filePath = path.join(dir, 'session.jsonl');
  const rows = Array.from({ length: 80 }, (_, i) => JSON.stringify({ id: i, text: 'x'.repeat(80) }));
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  const seen = [];
  const tail = new JsonlTail(filePath, (record) => seen.push(record.id), { maxInitialBytes: 1024 });
  t.after(() => tail.close());
  await tail.start();
  assert.ok(seen.length > 0 && seen.length < rows.length, `unexpected bootstrap size: ${seen.length}`);
  assert.equal(seen.at(-1), 79);
  assert.ok(seen.every((id) => Number.isInteger(id)));
});

test('large drains are chunked and yield between chunks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-chunk-'));
  const filePath = path.join(dir, 'session.jsonl');
  const rows = Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i, text: 'y'.repeat(120) }));
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  const seen = [];
  let eventLoopTicked = false;
  setImmediate(() => { eventLoopTicked = true; });
  const tail = new JsonlTail(filePath, record => seen.push(record.id), { maxReadBytes: 512 });
  t.after(() => tail.close());
  await tail.start();
  const stats = tail.getStats();
  assert.deepEqual(seen, rows.map((_, i) => i));
  assert.ok(stats.maxObservedReadBytes <= 512, JSON.stringify(stats));
  assert.ok(stats.yieldCount > 0, JSON.stringify(stats));
  assert.equal(eventLoopTicked, true);
});

test('byte scanner preserves UTF-8 characters split across read chunks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-utf8-'));
  const filePath = path.join(dir, 'session.jsonl');
  const expected = '跨分块中文🙂完整保留';
  fs.writeFileSync(filePath, `${JSON.stringify({ id: 'utf8', text: expected })}\n`, 'utf8');
  const seen = [];
  const tail = new JsonlTail(filePath, record => seen.push(record.text), { maxReadBytes: 7 });
  t.after(() => {
    tail.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await tail.start();
  assert.deepEqual(seen, [expected]);
});
