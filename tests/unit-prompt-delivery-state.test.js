'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { beginPromptDelivery, applyPromptReceipt } = require('../renderer/prompt-delivery-state');

test('confirmation arriving before an old timeout or error stays confirmed', () => {
  const state = beginPromptDelivery('a');
  applyPromptReceipt(state, { clientSubmissionId: 'a', status: 'confirmed' });
  assert.equal(applyPromptReceipt(state, { clientSubmissionId: 'a', status: 'unconfirmed' }), false);
  assert.equal(applyPromptReceipt(state, { clientSubmissionId: 'a', status: 'failed' }), false);
  assert.equal(state.status, 'confirmed');
});

test('old send result and previous-turn receipt cannot mutate newer delivery', () => {
  const state = beginPromptDelivery('b');
  for (const status of ['confirmed', 'failed', 'unconfirmed']) {
    assert.equal(applyPromptReceipt(state, { clientSubmissionId: 'a', status }), false);
  }
  assert.equal(state.status, 'pending');
  applyPromptReceipt(state, { clientSubmissionId: 'b', status: 'unconfirmed' });
  assert.equal(state.status, 'unconfirmed');
  applyPromptReceipt(state, { clientSubmissionId: 'b', status: 'confirmed' });
  assert.equal(state.status, 'confirmed');
});

test('dismissal survives repeated status delivery, next send has its own warning', () => {
  const state = beginPromptDelivery('a');
  state.dismissed = true;
  applyPromptReceipt(state, { clientSubmissionId: 'a', status: 'unconfirmed' });
  assert.equal(state.dismissed, true);
  assert.equal(beginPromptDelivery('b').dismissed, false);
});

test('integrity warning cannot be hidden by old timeout, failure or ordinary success', () => {
  const state = beginPromptDelivery('a');
  applyPromptReceipt(state, { clientSubmissionId: 'a', status: 'content-mismatch' });
  for (const status of ['unconfirmed', 'failed', 'confirmed']) {
    assert.equal(applyPromptReceipt(state, { clientSubmissionId: 'a', status }), false);
  }
  assert.equal(state.status, 'content-mismatch');
});
