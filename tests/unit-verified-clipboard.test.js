'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVerifiedClipboardWriter } = require('../core/verified-clipboard');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('main writer retries busy and silently dropped writes before acknowledging', async () => {
  let stored = 'old'; let writes = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: {
      writeText(text) { if (++writes === 1) throw new Error('busy'); if (writes === 3) stored = text; },
      readText: () => stored,
    }, wait: async () => {},
  });
  const result = await write('中文\r\n🙂');
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(stored, '中文\r\n🙂');
});

test('all callers share latest-copy priority, including during readback', async () => {
  let stored = ''; const pending = [];
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { stored = text; }, readText: () => stored },
    wait: () => new Promise(resolve => pending.push(resolve)),
  });
  const first = write('older window');
  const last = write('latest window');
  pending.shift()();
  assert.equal((await first).reason, 'superseded');
  pending.shift()();
  assert.equal((await last).ok, true);
  assert.equal(stored, 'latest window');
});

test('a late retry cannot overwrite a newer copy from another caller', async () => {
  let stored = 'before'; let resume; let oldWrites = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { if (text !== 'old' || ++oldWrites > 1) stored = text; }, readText: () => stored },
    wait: ms => ms ? new Promise(resolve => { resume = resolve; }) : Promise.resolve(),
    retryDelaysMs: [0, 1],
  });
  const first = write('old'); await tick();
  assert.equal((await write('new')).ok, true);
  resume();
  assert.equal((await first).reason, 'superseded');
  assert.equal(stored, 'new');
  assert.equal(oldWrites, 1);
});

test('permanent failure and missing readback never claim success', async () => {
  for (const clipboard of [{ writeText() {} }, { writeText() {}, readText: () => 'wrong' }]) {
    const write = createVerifiedClipboardWriter({ clipboard, wait: async () => {} });
    assert.equal((await write('wanted')).ok, false);
  }
});

test('native copy preserves HTML alongside the verified plain text', async () => {
  let payload;
  const write = createVerifiedClipboardWriter({ clipboard: {
    writeText() { assert.fail('rich copy must preserve both formats'); },
    write(value) { payload = value; }, readText: () => payload.text,
  }, wait: async () => {} });
  assert.equal((await write('bold', { html: '<strong>bold</strong>' })).ok, true);
  assert.deepEqual(payload, { text: 'bold', html: '<strong>bold</strong>' });
});
