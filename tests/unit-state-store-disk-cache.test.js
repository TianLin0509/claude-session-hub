'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-state-cache-'));
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  for (const mod of ['../core/state-store.js', '../core/data-dir.js']) delete require.cache[require.resolve(mod)];
  return { dir, stateStore: require('../core/state-store.js') };
}

const stateWith = (...sessions) => ({ version: 1, cleanShutdown: false, sessions, meetings: [], immersiveByMeeting: {} });

test('state.json is written compact, and repeated saves skip re-reading a file only this process wrote', async () => {
  const { dir, stateStore } = freshStore();
  const file = path.join(dir, 'state.json');
  stateStore.save(stateWith({ hubId: 'a', title: 'A', updatedAt: 1 }));
  await stateStore.flushPending();
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('\n'), false, 'no indentation');

  const originalReadFile = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = function (target, ...rest) {
    if (String(target) === file) reads += 1;
    return originalReadFile.call(this, target, ...rest);
  };
  try {
    stateStore.save(stateWith({ hubId: 'a', title: 'A2', updatedAt: 2 }));
    await stateStore.flushPending();
  } finally {
    fs.promises.readFile = originalReadFile;
  }
  assert.equal(reads, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].title, 'A2');
});

test('a file replaced by another Hub is read again and merged, never overwritten from the cache', async () => {
  const { dir, stateStore } = freshStore();
  const file = path.join(dir, 'state.json');
  stateStore.save(stateWith({ hubId: 'mine', title: 'Mine', updatedAt: 10 }));
  await stateStore.flushPending();

  // Another Hub writes a newer copy of the shared file.
  const other = JSON.parse(fs.readFileSync(file, 'utf8'));
  other.sessions.push({ hubId: 'theirs', title: 'Theirs', updatedAt: 20 });
  fs.writeFileSync(file, JSON.stringify(other, null, 2));

  stateStore.save(stateWith({ hubId: 'mine', title: 'Mine 2', updatedAt: 30 }));
  await stateStore.flushPending();
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(merged.sessions.map(s => s.hubId).sort(), ['mine', 'theirs']);
  assert.equal(merged.sessions.find(s => s.hubId === 'mine').title, 'Mine 2');
});

test('a stream of changes is throttled, and each write carries the newest state', async t => {
  const { dir, stateStore } = freshStore();
  const file = path.join(dir, 'state.json');
  const title = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].title; } catch { return null; } };
  // Only for the negative check: a write that must NOT happen yet. Spinning can
  // only make that check pass late, never fail spuriously under load.
  const settle = async expected => {
    for (let i = 0; i < 5000 && title() !== expected; i += 1) await new Promise(resolve => setImmediate(resolve));
    return title();
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  stateStore.save(stateWith({ hubId: 'a', title: 'v1', updatedAt: 1 }));
  t.mock.timers.tick(200);
  stateStore.save(stateWith({ hubId: 'a', title: 'v2', updatedAt: 2 }));
  t.mock.timers.tick(300); // 500 ms after the first change of the burst
  // The timer has fired, so flushPending() only awaits the queued write (it
  // would force a write only while a timer is still pending).
  await stateStore.flushPending();
  assert.equal(title(), 'v2');

  stateStore.save(stateWith({ hubId: 'a', title: 'v3', updatedAt: 3 }));
  t.mock.timers.tick(1000); // still inside the 2 s minimum interval
  assert.equal(await settle('v3'), 'v2');
  t.mock.timers.tick(1000);
  await stateStore.flushPending();
  assert.equal(title(), 'v3');
  t.mock.timers.reset();
});
