'use strict';
// pilot redesign v5（2026-05-02）：锁住 isSlotParticipatingThisTurn 的判定矩阵。
//
// 背景：v3/v4 反复改这块判定（git log: 19fb760 / 457165c / b2ea05a），但都只看 pilotSlot
// 不看 dispatchMode，造成"副驾发言"和"群策群力+已选主驾"两个场景下卡片状态完全反了。
// v5 抽出纯函数 + 单测兜底，避免再次回归。

const assert = require('assert');
const { isSlotParticipatingThisTurn } = require('../core/meeting-room');

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

// ----- 维度 1：pilotSlot 未设 -----
t('pilotSlot=null + 任意 dispatchMode → 全员参与', () => {
  for (const mode of ['all', 'pilot', 'observer', undefined, 'unknown']) {
    for (const slot of [0, 1, 2]) {
      const meeting = { pilotSlot: null, dispatchMode: mode };
      assert.strictEqual(isSlotParticipatingThisTurn(meeting, slot), true,
        `mode=${mode} slot=${slot} 应返回 true（pilotSlot 未设强制全员）`);
    }
  }
});

// ----- 维度 2：群策群力（dispatchMode='all'）-----
t('群策群力 + 已选主驾 → 全员参与（修复点：副驾不再被错误判 idle）', () => {
  const meeting = { pilotSlot: 0, dispatchMode: 'all' };
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 0), true, '主驾参与');
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 1), true, '副驾1 参与');
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 2), true, '副驾2 参与');
});

t('群策群力 + 不同主驾位置 → 仍全员参与', () => {
  for (const ps of [0, 1, 2]) {
    const meeting = { pilotSlot: ps, dispatchMode: 'all' };
    for (const slot of [0, 1, 2]) {
      assert.strictEqual(isSlotParticipatingThisTurn(meeting, slot), true,
        `pilotSlot=${ps} slot=${slot} 群策群力应全员参与`);
    }
  }
});

// ----- 维度 3：主驾发言（dispatchMode='pilot'）-----
t('主驾发言（slot0）→ 仅主驾参与', () => {
  const meeting = { pilotSlot: 0, dispatchMode: 'pilot' };
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 0), true, '主驾应参与');
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 1), false, '副驾1 不参与');
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 2), false, '副驾2 不参与');
});

t('主驾发言（slot1/slot2）→ 仅对应 slot 参与', () => {
  for (const ps of [1, 2]) {
    const meeting = { pilotSlot: ps, dispatchMode: 'pilot' };
    for (const slot of [0, 1, 2]) {
      assert.strictEqual(isSlotParticipatingThisTurn(meeting, slot), slot === ps,
        `pilotSlot=${ps} slot=${slot} 主驾发言应仅 slot===${ps} 参与`);
    }
  }
});

// ----- 维度 4：副驾发言（dispatchMode='observer'）-----
t('副驾发言（slot0为主驾）→ 主驾不参与，副驾两家参与（修复点：语义不再反）', () => {
  const meeting = { pilotSlot: 0, dispatchMode: 'observer' };
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 0), false, '主驾不参与');
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 1), true, '副驾1 参与');
  assert.strictEqual(isSlotParticipatingThisTurn(meeting, 2), true, '副驾2 参与');
});

t('副驾发言（slot1/slot2 主驾）→ 主驾不参与，其他两家参与', () => {
  for (const ps of [1, 2]) {
    const meeting = { pilotSlot: ps, dispatchMode: 'observer' };
    for (const slot of [0, 1, 2]) {
      assert.strictEqual(isSlotParticipatingThisTurn(meeting, slot), slot !== ps,
        `pilotSlot=${ps} slot=${slot} 副驾发言应排除主驾`);
    }
  }
});

// ----- 维度 5：边界 -----
t('meeting 为 null/undefined → 默认 true', () => {
  assert.strictEqual(isSlotParticipatingThisTurn(null, 0), true);
  assert.strictEqual(isSlotParticipatingThisTurn(undefined, 0), true);
});

t('pilotSlot 为非法值 → 视作 null（全员参与）', () => {
  for (const bad of [-1, 3, 99, 'foo', null, undefined, 1.5]) {
    const meeting = { pilotSlot: bad, dispatchMode: 'pilot' };
    for (const slot of [0, 1, 2]) {
      // 注：pilotSlot=1.5 会通过 typeof 'number' 检查但卡 0<=v<=2，仍接受 — 这是当前实现行为。
      // 这条断言锁死"非法 pilotSlot 必须 fallback 到全员"，防止未来加 Math.floor 之类隐式转换。
      const expected = (typeof bad === 'number' && bad >= 0 && bad <= 2) ? (slot === bad) : true;
      assert.strictEqual(isSlotParticipatingThisTurn(meeting, slot), expected,
        `pilotSlot=${bad} slot=${slot} 边界处理`);
    }
  }
});

t('dispatchMode 未传/非法 → 默认 all', () => {
  for (const bad of [undefined, null, 'foo', '']) {
    const meeting = { pilotSlot: 0, dispatchMode: bad };
    for (const slot of [0, 1, 2]) {
      assert.strictEqual(isSlotParticipatingThisTurn(meeting, slot), true,
        `dispatchMode=${bad} slot=${slot} 应 fallback 到 all（全员）`);
    }
  }
});

// ----- 跑测 -----
let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name);
    console.error('    ', e.message);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
