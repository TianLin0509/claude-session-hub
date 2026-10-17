'use strict';
// 桌宠移动与动画数学：惯性滑行、贴边、帧序列插值、呼吸与回弹。
const assert = require('node:assert/strict');
const test = require('node:test');
const { releasePlan, releaseVelocity, MAX_SLIDE } = require('../core/hub-pet/motion');
const M = require('../renderer/hub-pet/pet-motion');

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 280, height: 340 };
const inset = { left: 65, right: 65, top: 0, bottom: 6 };

test('松手速度只看最后 180ms', () => {
  const samples = [{ t: 0, x: 0, y: 500 }, { t: 500, x: 0, y: 500 }, { t: 600, x: 50, y: 500 }, { t: 700, x: 100, y: 500 }];
  const v = releaseVelocity(samples);
  assert.equal(Math.round(v.vx), 500);
  assert.equal(v.vy, 0);
});

test('慢放不滑；快甩最多滑 52 DIP，时长 120–210ms', () => {
  const slow = releasePlan({ samples: [{ t: 0, x: 800, y: 400 }, { t: 100, x: 820, y: 400 }], position: { x: 820, y: 400 }, area, size, inset });
  assert.equal(slow.steps.length, 0);
  const fast = releasePlan({ samples: [{ t: 0, x: 800, y: 400 }, { t: 100, x: 1100, y: 400 }], position: { x: 1100, y: 400 }, area, size, inset });
  assert.equal(fast.steps[0].kind, 'slide');
  assert.equal(fast.steps[0].to.x - 1100, MAX_SLIDE);
  assert.ok(fast.steps[0].durationMs >= 120 && fast.steps[0].durationMs <= 210);
});

test('靠近左右边或底边就贴过去，按身体算（窗口透明部分可以伸出屏幕）', () => {
  const nearRight = releasePlan({ samples: [], position: { x: 1920 - 280 + 65 - 20, y: 300 }, area, size, inset });
  assert.equal(nearRight.dock, 'right');
  assert.equal(nearRight.final.x, 1920 - 280 + 65);
  const nearLeft = releasePlan({ samples: [], position: { x: -65 + 10, y: 300 }, area, size, inset });
  assert.equal(nearLeft.dock, 'left');
  assert.equal(nearLeft.final.x, -65);
  const nearBottom = releasePlan({ samples: [], position: { x: 800, y: 1040 - 340 + 6 - 15 }, area, size, inset });
  assert.equal(nearBottom.final.y, 1040 - 340 + 6);
  assert.equal(nearBottom.dock, null);
  const middle = releasePlan({ samples: [], position: { x: 800, y: 300 }, area, size, inset });
  assert.equal(middle.steps.length, 0);
});

test('甩出屏幕会被拉回工作区', () => {
  const plan = releasePlan({ samples: [{ t: 0, x: 1500, y: 400 }, { t: 50, x: 1640, y: 400 }], position: { x: 1640, y: 400 }, area, size, inset });
  assert.ok(plan.final.x <= 1920 - 280 + 65);
});

test('帧序列逐帧硬切（2026-10-17：不再叠两帧淡入，那就是残影）；小动作 5 帧停一下再倒放，跳过被裁切的帧', () => {
  const list = M.gesturePlaylist(5, 5, [], 175, 220);
  assert.deepEqual(list.map(x => x.f), [5, 6, 7, 8, 9, 8, 7, 6, 5]);
  assert.equal(list[4].ms, 175 + 220, '峰值帧多停一会儿');
  assert.equal(M.gesturePlaylist(10, 5, [12]), null, '片段里有被裁切的帧就整段不用');
  const at = M.playlistFrame(175 * 2 + 10, list, false);
  assert.deepEqual(at, { f: 7, index: 2, done: false });
  assert.equal(Object.keys(at).includes('mix'), false, '没有半透明叠帧');
  assert.equal(M.playlistFrame(1e6, list, false).done, true);
  assert.equal(M.playlistFrame(1e6, list, false).f, 5, '倒放回起点');
  const typing = M.pingPong([0, 1, 2, 3, 4], 110);
  assert.deepEqual(typing.map(x => x.f), [0, 1, 2, 3, 4, 3, 2, 1]);
  assert.equal(M.playlistFrame(110 * 8 + 5, typing, true).f, 0, '循环接回第一帧');
  assert.deepEqual(M.frameRange(14, 18, [15]), [14, 16, 17, 18]);
  assert.deepEqual(M.frameRange(7, 3, []), [7, 6, 5, 4, 3]);
  assert.equal(M.sheetPosition(0), '0% 0%');
  assert.equal(M.sheetPosition(24), '100% 100%');
  assert.equal(M.sheetPosition(7), '50% 25%');
});

test('呼吸幅度随兴奋度变化、体积大致守恒；回弹 1.2 秒内收完', () => {
  let phase = 0; let maxCalm = 0; let maxExcited = 0;
  for (let i = 0; i < 400; i++) { const r = M.breathStep(phase, 0.02, 0); phase = r.phase; maxCalm = Math.max(maxCalm, r.sy - 1); }
  phase = 0;
  for (let i = 0; i < 400; i++) { const r = M.breathStep(phase, 0.02, 1); phase = r.phase; maxExcited = Math.max(maxExcited, r.sy - 1); assert.ok(Math.abs((r.sx - 1) + 0.55 * (r.sy - 1)) < 1e-9); }
  assert.ok(Math.abs(maxCalm - 0.011) < 0.001);
  assert.ok(Math.abs(maxExcited - 0.021) < 0.001);
  assert.equal(M.squashAt(1.3, 0.2), 0);
  assert.ok(M.squashAt(0.1, 0.2) < 0, '刚落地是压扁');
  assert.ok(Math.abs(M.squashAt(1.1, 0.2)) < 0.01);
  assert.ok(Math.abs(M.approach(10, 0, 100, 100) - 5) < 1e-9);
});
