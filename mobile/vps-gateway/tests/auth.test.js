'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PinRateLimiter,
  DeviceTokenCache,
  verifyBearer,
  constantTimeEq,
} = require('../lib/auth');

test('constantTimeEq matches identical strings', () => {
  assert.equal(constantTimeEq('abc', 'abc'), true);
});
test('constantTimeEq rejects different strings', () => {
  assert.equal(constantTimeEq('abc', 'abd'), false);
});
test('constantTimeEq rejects different lengths (no exception)', () => {
  assert.equal(constantTimeEq('abc', 'abcd'), false);
  assert.equal(constantTimeEq('', 'x'), false);
});

test('verifyBearer rejects empty / null', () => {
  assert.equal(verifyBearer(null, 'X'), false);
  assert.equal(verifyBearer('X', null), false);
  assert.equal(verifyBearer('', 'X'), false);
});
test('verifyBearer accepts correct token', () => {
  assert.equal(verifyBearer('SECRET123', 'SECRET123'), true);
});

test('PinRateLimiter not locked initially', () => {
  const r = new PinRateLimiter();
  assert.equal(r.isLocked('1.1.1.1'), false);
});
test('PinRateLimiter locks after 3 fails', () => {
  const r = new PinRateLimiter();
  r.recordFail('1.1.1.1');
  r.recordFail('1.1.1.1');
  assert.equal(r.isLocked('1.1.1.1'), false);
  r.recordFail('1.1.1.1');
  assert.equal(r.isLocked('1.1.1.1'), true);
});
test('PinRateLimiter reset clears fails', () => {
  const r = new PinRateLimiter();
  r.recordFail('1.1.1.1');
  r.recordFail('1.1.1.1');
  r.recordFail('1.1.1.1');
  r.reset('1.1.1.1');
  assert.equal(r.isLocked('1.1.1.1'), false);
});
test('PinRateLimiter isolates IPs', () => {
  const r = new PinRateLimiter();
  r.recordFail('A'); r.recordFail('A'); r.recordFail('A');
  assert.equal(r.isLocked('A'), true);
  assert.equal(r.isLocked('B'), false);
});

test('DeviceTokenCache miss before remember', () => {
  const c = new DeviceTokenCache();
  assert.equal(c.isVerified('TOKEN'), false);
});
test('DeviceTokenCache hit after remember', () => {
  const c = new DeviceTokenCache();
  c.remember('TOKEN');
  assert.equal(c.isVerified('TOKEN'), true);
});
test('DeviceTokenCache forget evicts', () => {
  const c = new DeviceTokenCache();
  c.remember('TOKEN');
  c.forget('TOKEN');
  assert.equal(c.isVerified('TOKEN'), false);
});
test('DeviceTokenCache ignores empty token in remember', () => {
  const c = new DeviceTokenCache();
  c.remember('');
  c.remember(null);
  assert.equal(c.isVerified(''), false);
  assert.equal(c.isVerified(null), false);
});
