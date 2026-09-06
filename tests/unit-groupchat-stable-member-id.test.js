'use strict';

const assert = require('node:assert');
const { ensureStableSlotSpecs } = require('../core/meeting-room.js');
const { nextMeetingMemberId } = require('../main/ipc/meeting-create-handlers.js');
const { reindexSerialWorkflowAfterRemoval } = require('../main/ipc/meeting-handlers.js');

assert.deepStrictEqual(
  ensureStableSlotSpecs([{ kind: 'claude' }, { kind: 'codex' }], ['s1', 's2']).map(slot => slot.memberId),
  ['m1', 'm2'],
);
assert.deepStrictEqual(
  ensureStableSlotSpecs([{ memberId: 'm1' }, { memberId: 'm3' }, {}], ['s1', 's3', 's4']).map(slot => slot.memberId),
  ['m1', 'm3', 'm4'],
  'migration/addition must never recycle a removed historical id',
);
assert.strictEqual(nextMeetingMemberId([{ memberId: 'm1' }, { memberId: 'm3' }]), 'm4');

const workflow = {
  enabled: true,
  schemaVersion: 2,
  steps: [['m1'], ['m3']],
  stepConfigs: [{ name: 'first' }, { name: 'third' }],
};
const stable = reindexSerialWorkflowAfterRemoval(workflow, 0, 'm1');
assert.deepStrictEqual(stable.steps, [['m3']], 'removing m1 must not rename stable m3 to m2');
assert.strictEqual(stable.stepConfigs[0].name, 'third');

const legacy = reindexSerialWorkflowAfterRemoval(workflow, 0);
assert.deepStrictEqual(legacy.steps, [['m2']], 'old meetings without stable ids keep the legacy migration path');

console.log('groupchat stable member id: ok');
