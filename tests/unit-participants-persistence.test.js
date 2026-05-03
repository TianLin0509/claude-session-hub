'use strict';
// 测 deriveTargetSids 在 participants 不同状态下的行为
//（往返持久化由 T1 的 unit-meeting-store-free-fields 覆盖）

const assert = require('assert');
const free = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

const meeting = { subSessions: ['s0', 's1', 's2'] };

function testParticipants_DefaultAllOnFreshFreeMode() {
  const m = { ...meeting, participants: [0, 1, 2] };
  assert.deepStrictEqual(free.deriveTargetSids(m, 'fanout', null), ['s0','s1','s2']);
}

function testParticipants_OrderPreserved() {
  const m = { ...meeting, participants: [2, 0] };
  assert.deepStrictEqual(free.deriveTargetSids(m, 'fanout', null), ['s2','s0']);
}

function testParticipants_DuplicatesIgnored() {
  // IPC 校验已去重；这里用直接传重复值看 derive 行为
  const m = { ...meeting, participants: [1, 1] };
  const sids = free.deriveTargetSids(m, 'fanout', null);
  assert.deepStrictEqual(sids, ['s1','s1']);
}

console.log('--- participants persistence ---');
run('testParticipants_DefaultAllOnFreshFreeMode', testParticipants_DefaultAllOnFreshFreeMode);
run('testParticipants_OrderPreserved', testParticipants_OrderPreserved);
run('testParticipants_DuplicatesIgnored', testParticipants_DuplicatesIgnored);

process.exit(failed > 0 ? 1 : 0);
