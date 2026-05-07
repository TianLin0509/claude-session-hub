// tests/meeting-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const { saveMeetingFile, loadMeetingFile, markDirty, flushAll, listMeetingFiles, deleteMeetingFile } = require('../core/meeting-store');

(async () => {
  // T1.1: save + load round-trip
  const data = { id: 'm1', _timeline: [{ idx: 0, sid: 'user', text: 'hi', ts: 1 }], _cursors: { 'a': 0 }, _nextIdx: 1 };
  saveMeetingFile('m1', data);
  const loaded = loadMeetingFile('m1');
  assert.deepStrictEqual(loaded._timeline, data._timeline, 'timeline round-trip');
  assert.deepStrictEqual(loaded._cursors, data._cursors, 'cursors round-trip');
  assert.strictEqual(loaded._nextIdx, 1, 'nextIdx round-trip');
  // 2026-05-07：schemaVersion bumped 1→2 (per-meeting JSON 字段补全成完整备份)
  assert.strictEqual(loaded.schemaVersion, 2, 'schemaVersion bumped to 2');
  console.log('PASS T1.1 save+load round-trip');

  // T1.2: missing file returns null
  assert.strictEqual(loadMeetingFile('nonexistent'), null);
  console.log('PASS T1.2 missing file → null');

  // T1.3: list files
  saveMeetingFile('m2', { id: 'm2', _timeline: [], _cursors: {}, _nextIdx: 0 });
  const ids = listMeetingFiles().sort();
  assert.deepStrictEqual(ids, ['m1', 'm2']);
  console.log('PASS T1.3 list files');

  // T1.4: delete
  deleteMeetingFile('m1');
  assert.strictEqual(loadMeetingFile('m1'), null);
  console.log('PASS T1.4 delete');

  // T1.5: markDirty + flushAll
  markDirty('m2', { id: 'm2', _timeline: [{ idx: 0, sid: 'a', text: 'x', ts: 2 }], _cursors: {}, _nextIdx: 1 });
  await flushAll();
  const after = loadMeetingFile('m2');
  assert.strictEqual(after._timeline.length, 1, 'flushAll wrote pending dirty');
  console.log('PASS T1.5 markDirty + flushAll');

  // T1.6: cancelDirty prevents ghost file resurrection
  saveMeetingFile('m3', { id: 'm3', _timeline: [], _cursors: {}, _nextIdx: 0 });
  markDirty('m3', { id: 'm3', _timeline: [{ idx: 0, sid: 'a', text: 'pending', ts: 99 }], _cursors: {}, _nextIdx: 1 });
  // Simulate close: cancel dirty, then delete file
  const { cancelDirty } = require('../core/meeting-store');
  cancelDirty('m3');
  deleteMeetingFile('m3');
  await flushAll();  // would resurrect file if cancelDirty didn't work
  assert.strictEqual(loadMeetingFile('m3'), null, 'ghost file not resurrected after cancelDirty + delete');
  console.log('PASS T1.6 cancelDirty prevents ghost file');

  console.log('ALL meeting-store tests PASS');
  // cleanup
  fs.rmSync(TEMP, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
