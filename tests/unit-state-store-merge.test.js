// tests/unit-state-store-merge.test.js
//
// 2026-05-07 道雪 — 验证 stateStore.mergeState 在多 Hub 并发场景下的 LWW + removed 语义。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'state-merge-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const { mergeState } = require('../core/state-store');

function defState() {
  return { version: 1, cleanShutdown: false, sessions: [], meetings: [], immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {} };
}

(function run() {
  // M1: disk-only session 保留
  {
    const disk = { ...defState(), sessions: [{ hubId: 'a', kind: 'claude', title: 'A', updatedAt: 100 }] };
    const mem = { ...defState() };
    const out = mergeState(disk, mem);
    assert.strictEqual(out.sessions.length, 1, 'M1: disk-only session preserved');
    assert.strictEqual(out.sessions[0].hubId, 'a');
    console.log('PASS M1 disk-only session preserved');
  }

  // M2: mem-only session 进入
  {
    const disk = { ...defState() };
    const mem = { ...defState(), sessions: [{ hubId: 'b', kind: 'claude', title: 'B', updatedAt: 200 }] };
    const out = mergeState(disk, mem);
    assert.strictEqual(out.sessions.length, 1, 'M2: mem-only session merged in');
    assert.strictEqual(out.sessions[0].hubId, 'b');
    console.log('PASS M2 mem-only session merged in');
  }

  // M3: 双方都有 — LWW (mem updatedAt 更新 → mem 胜出)
  {
    const disk = { ...defState(), sessions: [{ hubId: 'c', title: 'old', updatedAt: 100 }] };
    const mem = { ...defState(), sessions: [{ hubId: 'c', title: 'new', updatedAt: 200 }] };
    const out = mergeState(disk, mem);
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].title, 'new', 'M3: newer mem wins');
    console.log('PASS M3 mem newer wins');
  }

  // M4: 双方都有 — disk updatedAt 更新 → disk 胜出
  {
    const disk = { ...defState(), sessions: [{ hubId: 'd', title: 'disk', updatedAt: 500 }] };
    const mem = { ...defState(), sessions: [{ hubId: 'd', title: 'mem', updatedAt: 100 }] };
    const out = mergeState(disk, mem);
    assert.strictEqual(out.sessions[0].title, 'disk', 'M4: newer disk wins');
    console.log('PASS M4 disk newer wins');
  }

  // M5: removed sessions 显式删除
  {
    const disk = { ...defState(), sessions: [{ hubId: 'e', updatedAt: 100 }, { hubId: 'f', updatedAt: 100 }] };
    const mem = { ...defState() };
    const out = mergeState(disk, mem, { sessions: ['e'], meetings: [] });
    assert.strictEqual(out.sessions.length, 1, 'M5: removed session dropped');
    assert.strictEqual(out.sessions[0].hubId, 'f');
    console.log('PASS M5 removed session dropped');
  }

  // M6: 关键多 Hub 场景重现 — Hub A 写 [a,b,c,e]，盘上是 Hub B 刚写的 [a,b,c,d]
  //   预期：merge 后是 [a,b,c,d,e]（Hub A 不会覆盖 Hub B 的 d）
  {
    const disk = { ...defState(), sessions: [
      { hubId: 'a', updatedAt: 100 }, { hubId: 'b', updatedAt: 100 },
      { hubId: 'c', updatedAt: 100 }, { hubId: 'd', updatedAt: 200 },  // Hub B 加的
    ]};
    const mem = { ...defState(), sessions: [
      { hubId: 'a', updatedAt: 100 }, { hubId: 'b', updatedAt: 100 },
      { hubId: 'c', updatedAt: 100 }, { hubId: 'e', updatedAt: 200 },  // Hub A 加的
    ]};
    const out = mergeState(disk, mem);
    const ids = out.sessions.map(s => s.hubId).sort();
    assert.deepStrictEqual(ids, ['a', 'b', 'c', 'd', 'e'], 'M6: multi-hub additive merge');
    console.log('PASS M6 multi-hub additive merge — d 没被 Hub A 覆盖');
  }

  // M7: meetings 同样 LWW + removed
  {
    const disk = { ...defState(), meetings: [
      { id: 'm1', title: 'old', updatedAt: 100 },
      { id: 'm2', title: 'B-meeting', updatedAt: 200 },  // Hub B 加的
    ]};
    const mem = { ...defState(), meetings: [
      { id: 'm1', title: 'new', updatedAt: 200 },  // Hub A 改了
      { id: 'm3', title: 'A-meeting', updatedAt: 200 },  // Hub A 加的
    ]};
    const out = mergeState(disk, mem);
    const titles = Object.fromEntries(out.meetings.map(m => [m.id, m.title]));
    assert.strictEqual(titles.m1, 'new', 'M7: m1 LWW mem wins');
    assert.strictEqual(titles.m2, 'B-meeting', 'M7: m2 disk-only preserved');
    assert.strictEqual(titles.m3, 'A-meeting', 'M7: m3 mem-only merged');
    console.log('PASS M7 meeting multi-hub merge');
  }

  // M8: dict union — immersiveByMeeting / pilotSlotByMeeting / dispatchModeByMeeting
  {
    const disk = { ...defState(), immersiveByMeeting: { x: true }, pilotSlotByMeeting: { x: 0 }, dispatchModeByMeeting: { x: 'pilot' } };
    const mem = { ...defState(), immersiveByMeeting: { y: true }, pilotSlotByMeeting: { y: 1 }, dispatchModeByMeeting: { y: 'observer' } };
    const out = mergeState(disk, mem);
    assert.deepStrictEqual(out.immersiveByMeeting, { x: true, y: true }, 'M8: dict union');
    assert.deepStrictEqual(out.pilotSlotByMeeting, { x: 0, y: 1 });
    assert.deepStrictEqual(out.dispatchModeByMeeting, { x: 'pilot', y: 'observer' });
    console.log('PASS M8 by-meeting dicts union');
  }

  // M9: missing updatedAt → 0 baseline
  {
    const disk = { ...defState(), sessions: [{ hubId: 'g', title: 'old' /* no updatedAt */ }] };
    const mem = { ...defState(), sessions: [{ hubId: 'g', title: 'new', updatedAt: 1 }] };
    const out = mergeState(disk, mem);
    assert.strictEqual(out.sessions[0].title, 'new', 'M9: any updatedAt beats missing');
    console.log('PASS M9 missing updatedAt acts as 0');
  }

  console.log('\n[ALL state-store merge tests PASSED]');
})();
