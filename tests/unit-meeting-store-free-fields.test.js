'use strict';
// 测 meeting-store.js 新增 mode/participants 字段往返持久化 + 兜底

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 测试用临时数据目录
const TEST_DIR = path.join(os.tmpdir(), `hub-test-meeting-store-${Date.now()}`);
process.env.CLAUDE_HUB_DATA_DIR = TEST_DIR;

// data-dir 缓存解决，必须在 process.env 设置后 require
const store = require('../core/meeting-store');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

function testFreshSaveAndLoad() {
  store.saveMeetingFile('m1', { mode: 'free', participants: [0, 2] });
  const loaded = store.loadMeetingFile('m1');
  assert.strictEqual(loaded.mode, 'free');
  assert.deepStrictEqual(loaded.participants, [0, 2]);
}

// 2026-05-07：默认 mode 从 'pilot' 改成 'free'（与 meeting-room.js 2026-05-05
//   废弃主驾入口的迁移一致），测试名保留以保留 git history，断言已更新。
function testLegacyMeetingDefaultsToFree() {
  // 模拟老 meeting：手工写一个无 mode/participants 字段的 JSON
  const dir = path.join(TEST_DIR, 'meetings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'm-legacy.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'm-legacy',
    _timeline: [],
    _cursors: {},
    _nextIdx: 0,
    pilotSlot: null,
    dispatchMode: 'all',
    savedAt: Date.now(),
  }));
  // 用 saveMeetingFile 重写一次（loadMeetingFile 不做兜底，兜底在 main.js 读取后做）
  // 我们的契约：saveMeetingFile 写时 mode 缺失则默认 'free'，participants 缺失则 null
  store.saveMeetingFile('m-legacy-resaved', {});
  const re = store.loadMeetingFile('m-legacy-resaved');
  assert.strictEqual(re.mode, 'free', 'mode default free');
  assert.strictEqual(re.participants, null, 'participants default null');
}

function testInvalidModeFallsBackToFree() {
  store.saveMeetingFile('m-bad', { mode: 'invalid', participants: [0] });
  const re = store.loadMeetingFile('m-bad');
  assert.strictEqual(re.mode, 'free', 'invalid mode → free');
}

function testInvalidParticipantsFallsBackToNull() {
  store.saveMeetingFile('m-bad2', { mode: 'free', participants: 'not-array' });
  const re = store.loadMeetingFile('m-bad2');
  assert.strictEqual(re.participants, null, 'non-array → null');
}

function testEmptyArrayParticipantsAllowed() {
  // Q11=A：用户故意清空也持久化
  store.saveMeetingFile('m-empty', { mode: 'free', participants: [] });
  const re = store.loadMeetingFile('m-empty');
  assert.deepStrictEqual(re.participants, [], 'empty array preserved');
}

function testLegacyJsonOnDiskLoadFallback() {
  // 直接写无 mode/participants 字段的老 JSON 到磁盘，验证 loadMeetingFile 兜底
  const dir = path.join(TEST_DIR, 'meetings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'm-on-disk.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'm-on-disk',
    _timeline: [],
    _cursors: {},
    _nextIdx: 0,
    pilotSlot: null,
    dispatchMode: 'all',
    savedAt: Date.now(),
  }));
  const re = store.loadMeetingFile('m-on-disk');
  assert.strictEqual(re.mode, 'free', 'load tolerates missing mode');
  assert.strictEqual(re.participants, null, 'load tolerates missing participants');
}

console.log('--- meeting-store free fields ---');
run('testFreshSaveAndLoad', testFreshSaveAndLoad);
run('testLegacyMeetingDefaultsToFree', testLegacyMeetingDefaultsToFree);
run('testInvalidModeFallsBackToFree', testInvalidModeFallsBackToFree);
run('testInvalidParticipantsFallsBackToNull', testInvalidParticipantsFallsBackToNull);
run('testEmptyArrayParticipantsAllowed', testEmptyArrayParticipantsAllowed);
run('testLegacyJsonOnDiskLoadFallback', testLegacyJsonOnDiskLoadFallback);

// cleanup
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
