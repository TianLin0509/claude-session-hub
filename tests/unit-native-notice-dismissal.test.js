'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dismissNativeNotice, isNativeNoticeDismissed } = require('../renderer/native-notice-dismissal');
test('ignore only hides this turn notice; state and submission remain unchanged', () => {
  const session = { nativeRuntime: { epoch: 1, turnId: 'a', state: 'unknown', reason: 'not confirmed', requests: [{ id: 'approval' }] }, nativeActionError: 'not confirmed' };
  const before = JSON.stringify(session);
  dismissNativeNotice(session, 'not confirmed');
  assert.equal(isNativeNoticeDismissed(session, 'not confirmed'), true);
  assert.equal(JSON.stringify(session), before);
  assert.equal(isNativeNoticeDismissed(session, 'different failure'), false);
  assert.equal(isNativeNoticeDismissed({ ...session }, 'not confirmed'), false);
  session.nativeRuntime.turnId = 'b';
  assert.equal(isNativeNoticeDismissed(session, 'not confirmed'), false);
  dismissNativeNotice(session, 'not confirmed');
  session.nativeRuntime.epoch++;
  assert.equal(isNativeNoticeDismissed(session, 'not confirmed'), false);
});
