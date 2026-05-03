'use strict';
// 测 main.js 提取的 _validateMode + _validateParticipants 校验函数

const assert = require('assert');
const { _validateMode, _validateParticipants } = require('../core/roundtable-free');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ':', e.message); failed++; }
}

function testValidateMode_Pilot() {
  assert.strictEqual(_validateMode('pilot'), 'pilot');
}
function testValidateMode_Free() {
  assert.strictEqual(_validateMode('free'), 'free');
}
function testValidateMode_RejectsInvalid() {
  assert.throws(() => _validateMode('banana'), /Invalid mode/);
  assert.throws(() => _validateMode(null), /Invalid mode/);
  assert.throws(() => _validateMode(undefined), /Invalid mode/);
}

function testValidateParticipants_Empty() {
  // Q11=A：空允许
  assert.deepStrictEqual(_validateParticipants([]), []);
}
function testValidateParticipants_All() {
  assert.deepStrictEqual(_validateParticipants([0, 1, 2]), [0, 1, 2]);
}
function testValidateParticipants_Dedupe() {
  assert.deepStrictEqual(_validateParticipants([1, 1, 0]), [0, 1]);
}
function testValidateParticipants_RejectOutOfRange() {
  assert.throws(() => _validateParticipants([0, 3]), /Invalid participant slot/);
  assert.throws(() => _validateParticipants([-1]), /Invalid participant slot/);
}
function testValidateParticipants_RejectNonArray() {
  assert.throws(() => _validateParticipants('all'), /participants must be array/);
  assert.throws(() => _validateParticipants(null), /participants must be array/);
}

console.log('--- meeting-mode-toggle validators ---');
run('testValidateMode_Pilot', testValidateMode_Pilot);
run('testValidateMode_Free', testValidateMode_Free);
run('testValidateMode_RejectsInvalid', testValidateMode_RejectsInvalid);
run('testValidateParticipants_Empty', testValidateParticipants_Empty);
run('testValidateParticipants_All', testValidateParticipants_All);
run('testValidateParticipants_Dedupe', testValidateParticipants_Dedupe);
run('testValidateParticipants_RejectOutOfRange', testValidateParticipants_RejectOutOfRange);
run('testValidateParticipants_RejectNonArray', testValidateParticipants_RejectNonArray);

process.exit(failed > 0 ? 1 : 0);
