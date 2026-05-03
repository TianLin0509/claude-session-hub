'use strict';
// 测 core/roundtable-free.js dispatch 推导

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const meeting = {
  subSessions: ['sid_pikachu', 'sid_charmander', 'sid_squirtle'],
  participants: [0, 1, 2],
};

function testDeriveTargetSids_FanoutAllThree() {
  const sids = free.deriveTargetSids(meeting, 'fanout', null);
  assert.deepStrictEqual(sids, ['sid_pikachu', 'sid_charmander', 'sid_squirtle']);
}

function testDeriveTargetSids_FanoutOneSlot() {
  const m = { ...meeting, participants: [1] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, ['sid_charmander']);
}

function testDeriveTargetSids_FanoutTwoSlots() {
  const m = { ...meeting, participants: [0, 2] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, ['sid_pikachu', 'sid_squirtle']);
}

function testDeriveTargetSids_DebateSameAsFanout() {
  const m = { ...meeting, participants: [0, 1] };
  const sids = free.deriveTargetSids(m, 'debate', null);
  assert.deepStrictEqual(sids, ['sid_pikachu', 'sid_charmander']);
}

function testDeriveTargetSids_SummaryIgnoresParticipants() {
  // Q8=A：summary 模式 summarizer 独说，不受 participants 影响
  const m = { ...meeting, participants: [0] };  // 仅勾选 pikachu
  const sids = free.deriveTargetSids(m, 'summary', 'squirtle');  // 但选 squirtle 总结
  assert.deepStrictEqual(sids, ['sid_squirtle'], 'summary 不受 participants 限制');
}

function testDeriveTargetSids_EmptyParticipants() {
  // Q11=A：空 participants → 空 targets（UI 已防发送，这里仅返回空数组）
  const m = { ...meeting, participants: [] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, []);
}

function testDeriveTargetSids_NullParticipants() {
  // 首次进 free 模式（participants 仍是 null）→ 调用方应初始化为 [0,1,2]
  // 但若调用方未初始化就调 derive → 空数组（防御性）
  const m = { ...meeting, participants: null };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, []);
}

function testDerivePilotCompat_Three() {
  assert.strictEqual(free.derivePilotCompatDispatchMode([0, 1, 2]), 'all');
}

function testDerivePilotCompat_One() {
  assert.strictEqual(free.derivePilotCompatDispatchMode([1]), 'pilot');
}

function testDerivePilotCompat_Two() {
  assert.strictEqual(free.derivePilotCompatDispatchMode([0, 2]), 'observer');
}

function testDerivePilotCompat_Edge() {
  // 0 人 / >3 人（防御性）→ 'all'
  assert.strictEqual(free.derivePilotCompatDispatchMode([]), 'all');
  assert.strictEqual(free.derivePilotCompatDispatchMode([0,1,2,3]), 'all');
  assert.strictEqual(free.derivePilotCompatDispatchMode(null), 'all');
}

console.log('--- roundtable-free dispatch ---');
run('testDeriveTargetSids_FanoutAllThree', testDeriveTargetSids_FanoutAllThree);
run('testDeriveTargetSids_FanoutOneSlot', testDeriveTargetSids_FanoutOneSlot);
run('testDeriveTargetSids_FanoutTwoSlots', testDeriveTargetSids_FanoutTwoSlots);
run('testDeriveTargetSids_DebateSameAsFanout', testDeriveTargetSids_DebateSameAsFanout);
run('testDeriveTargetSids_SummaryIgnoresParticipants', testDeriveTargetSids_SummaryIgnoresParticipants);
run('testDeriveTargetSids_EmptyParticipants', testDeriveTargetSids_EmptyParticipants);
run('testDeriveTargetSids_NullParticipants', testDeriveTargetSids_NullParticipants);
run('testDerivePilotCompat_Three', testDerivePilotCompat_Three);
run('testDerivePilotCompat_One', testDerivePilotCompat_One);
run('testDerivePilotCompat_Two', testDerivePilotCompat_Two);
run('testDerivePilotCompat_Edge', testDerivePilotCompat_Edge);

process.exit(failed > 0 ? 1 : 0);
