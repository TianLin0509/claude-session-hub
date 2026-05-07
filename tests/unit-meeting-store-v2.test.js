// tests/unit-meeting-store-v2.test.js
//
// 验证 meeting-store schemaVersion 1→2 升级后：
//   - 写出的 JSON 是 v2，含 title/scene/createdAt/subSessions/...
//   - loadMeetingFile 兼容 v1 老文件
//   - listMeetingFilesWithData 用于 boot 自我修复
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-v2-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const meetingStore = require('../core/meeting-store');

(async function run() {
  // V1: v2 round-trip with full fields
  {
    meetingStore.saveMeetingFile('m1', {
      id: 'm1',
      _timeline: [{ idx: 0, sid: 'user', text: 'hi', ts: 1 }], _cursors: { sub1: 0 }, _nextIdx: 1,
      slotSpecs: [{ index: 0, kind: 'claude', model: 'opus' }],
      pilotSlot: 0, dispatchMode: 'pilot', mode: 'free', participants: [0, 1, 2],
      title: '通用 #1', scene: 'general', createdAt: 1234567890,
      subSessions: ['sub1', 'sub2'], layout: 'focus', focusedSub: 'sub1',
      syncContext: false, sendTarget: 'all', pinned: true,
      lastScene: 'free_discussion', lastMessageTime: 999,
      covenantText: '约定文本', immersive: false, updatedAt: 5000,
    });
    const loaded = meetingStore.loadMeetingFile('m1');
    assert.ok(loaded);
    assert.strictEqual(loaded.schemaVersion, 2);
    assert.strictEqual(loaded.title, '通用 #1');
    assert.strictEqual(loaded.scene, 'general');
    assert.strictEqual(loaded.createdAt, 1234567890);
    assert.deepStrictEqual(loaded.subSessions, ['sub1', 'sub2']);
    assert.strictEqual(loaded.covenantText, '约定文本');
    assert.strictEqual(loaded.pinned, true);
    assert.strictEqual(loaded._timeline.length, 1);
    assert.strictEqual(loaded.updatedAt, 5000);
    console.log('PASS V1 v2 round-trip 完整字段');
  }

  // V2: v1 老文件兼容读
  {
    const v1Path = path.join(TEMP, 'meetings', 'm-old.json');
    fs.writeFileSync(v1Path, JSON.stringify({
      schemaVersion: 1, id: 'm-old',
      _timeline: [], _cursors: {}, _nextIdx: 0,
      slotSpecs: null, pilotSlot: null, dispatchMode: 'all', mode: 'pilot', participants: null,
      savedAt: 1000,
    }));
    const loaded = meetingStore.loadMeetingFile('m-old');
    assert.ok(loaded);
    assert.strictEqual(loaded.schemaVersion, 1, 'v1 显式标记为 1');
    assert.strictEqual(loaded.title, undefined, 'v1 不带 title 字段，调用方应从 state.json 兜底');
    console.log('PASS V2 v1 兼容读');
  }

  // V3: listMeetingFilesWithData 包含完整数据
  {
    meetingStore.saveMeetingFile('m2', {
      id: 'm2', _timeline: [], _cursors: {}, _nextIdx: 0,
      title: '投研 #1', scene: 'research', createdAt: 999,
      subSessions: [], updatedAt: 999,
    });
    const all = meetingStore.listMeetingFilesWithData();
    const m2 = all.find(d => d.id === 'm2');
    assert.ok(m2, 'listMeetingFilesWithData 应返回 m2');
    assert.strictEqual(m2.title, '投研 #1');
    assert.strictEqual(m2.scene, 'research');
    console.log('PASS V3 listMeetingFilesWithData');
  }

  // V4: 损坏 JSON 不影响其他文件加载
  {
    const corruptPath = path.join(TEMP, 'meetings', 'broken.json');
    fs.writeFileSync(corruptPath, '{not json');
    const all = meetingStore.listMeetingFilesWithData();
    const ids = all.map(d => d.id).sort();
    assert.ok(ids.includes('m1'));
    assert.ok(ids.includes('m2'));
    assert.ok(!ids.includes('broken'), '损坏 JSON 被跳过');
    console.log('PASS V4 corrupt JSON skipped');
  }

  // V5: missing optional fields → 使用 schema 兜底（mode 默认 free）
  {
    meetingStore.saveMeetingFile('m3', { id: 'm3', _timeline: [], _cursors: {}, _nextIdx: 0 });
    const loaded = meetingStore.loadMeetingFile('m3');
    assert.strictEqual(loaded.mode, 'free', 'mode 默认 free');
    assert.strictEqual(loaded.dispatchMode, 'all', 'dispatchMode 默认 all');
    assert.strictEqual(loaded.participants, null, 'participants 默认 null');
    console.log('PASS V5 schema defaults');
  }

  console.log('\n[ALL meeting-store-v2 tests PASSED]');
})();
