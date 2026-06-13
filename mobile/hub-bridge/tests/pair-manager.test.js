'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PairManager } = require('../pair-manager');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-test-'));
  return d;
}

test('generates 6-digit PIN', () => {
  const m = new PairManager({ dataDir: tmpDir(), logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  assert.match(pin, /^\d{6}$/);
});

test('PIN is one-shot: consumed on successful verify', () => {
  const m = new PairManager({ dataDir: tmpDir(), logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  const r1 = m.verifyPin(pin, 'Test');
  assert.equal(r1.ok, true);
  assert.match(r1.deviceToken, /^[0-9a-f]{32}$/);
  const r2 = m.verifyPin(pin, 'Test');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'pin_expired');
});

test('wrong PIN fails but does not consume', () => {
  const m = new PairManager({ dataDir: tmpDir(), logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  const wrong = (parseInt(pin, 10) + 1) % 1000000;
  const wrongStr = String(wrong).padStart(6, '0');
  const r1 = m.verifyPin(wrongStr, 'Test');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'invalid_pin');
  // 真正的 PIN 还能成功
  const r2 = m.verifyPin(pin, 'Test');
  assert.equal(r2.ok, true);
});

test('verify without generated PIN returns pin_expired', () => {
  const m = new PairManager({ dataDir: tmpDir(), logger: { log: () => {}, warn: () => {} } });
  const r = m.verifyPin('123456', 'Test');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pin_expired');
});

test('successful pair persists device to mobile-devices.json', () => {
  const dir = tmpDir();
  const m = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  m.verifyPin(pin, 'Mate X6');
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'mobile-devices.json'), 'utf8'));
  assert.equal(persisted.devices.length, 1);
  assert.equal(persisted.devices[0].name, 'Mate X6');
  assert.match(persisted.devices[0].token, /^[0-9a-f]{32}$/);
});

test('device list survives PairManager re-instantiation', () => {
  const dir = tmpDir();
  const m1 = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const { pin } = m1.generatePin();
  m1.verifyPin(pin, 'Device A');
  const m2 = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const list = m2.listDevices();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Device A');
});

test('device cache reloads when another PairManager writes mobile-devices.json', () => {
  const dir = tmpDir();
  const logger = { log: () => {}, warn: () => {} };
  const reader = new PairManager({ dataDir: dir, logger });
  assert.equal(reader.isValidToken('deadbeef'.repeat(4)), false);

  const writer = new PairManager({ dataDir: dir, logger, fixedPin: '063551' });
  const { deviceToken } = writer.verifyPin('063551', 'Device B');

  assert.equal(reader.isValidToken(deviceToken), true);
});

test('isValidToken returns true for paired, false for random', () => {
  const dir = tmpDir();
  const m = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  const { deviceToken } = m.verifyPin(pin, 'Test');
  assert.equal(m.isValidToken(deviceToken), true);
  assert.equal(m.isValidToken('deadbeef'.repeat(4)), false);
});

test('revokeDevice removes token, isValidToken returns false after', () => {
  const dir = tmpDir();
  const m = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  const { deviceToken } = m.verifyPin(pin, 'Test');
  assert.equal(m.revokeDevice(deviceToken), true);
  assert.equal(m.isValidToken(deviceToken), false);
  assert.equal(m.revokeDevice(deviceToken), false); // 二次 revoke 返回 false
});

test('deviceName is truncated to 32 chars', () => {
  const dir = tmpDir();
  const m = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const { pin } = m.generatePin();
  const longName = 'x'.repeat(100);
  m.verifyPin(pin, longName);
  const list = m.listDevices();
  assert.equal(list[0].name.length, 32);
});

test('currentPinInfo returns null after consumed', () => {
  const m = new PairManager({ dataDir: tmpDir(), logger: { log: () => {}, warn: () => {} } });
  assert.equal(m.currentPinInfo(), null);
  const { pin } = m.generatePin();
  assert.equal(m.currentPinInfo().pin, pin);
  m.verifyPin(pin, 'Test');
  assert.equal(m.currentPinInfo(), null);
});

test('push subscription can be saved, loaded, and cleared for paired device', () => {
  const dir = tmpDir();
  const m1 = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  const { pin } = m1.generatePin();
  const { deviceToken } = m1.verifyPin(pin, 'Push Device');
  const sub = {
    endpoint: 'https://push.example.test/send/abc',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  };

  assert.equal(m1.setPushSub(deviceToken, sub, 'UA'), true);
  assert.deepEqual(m1.getPushSub(deviceToken), sub);

  const m2 = new PairManager({ dataDir: dir, logger: { log: () => {}, warn: () => {} } });
  assert.deepEqual(m2.getPushSub(deviceToken), sub);
  assert.equal(m2.setPushSub(deviceToken, null), true);
  assert.equal(m2.getPushSub(deviceToken), null);
});
