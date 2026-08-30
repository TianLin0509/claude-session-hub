const test = require('node:test');
const assert = require('node:assert');
const { formatAbsoluteTime } = require('../renderer/format-time.js');

test('same day → HH:MM', () => {
  const now = new Date('2026-05-04T06:22:00Z'); // 北京 14:22
  const ts = new Date('2026-05-04T00:30:00Z').getTime(); // 北京 08:30
  assert.strictEqual(formatAbsoluteTime(ts, now), '08:30');
});

test('cross day same year → M月D日 HH:MM', () => {
  const now = new Date('2026-05-04T06:22:00Z');
  const ts = new Date('2026-05-03T06:22:00Z').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '5月3日 14:22');
});

test('cross year → YYYY年M月D日 HH:MM', () => {
  const now = new Date('2026-05-04T06:22:00Z');
  const ts = new Date('2025-12-03T06:22:00Z').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '2025年12月3日 14:22');
});

test('same-day comparison follows Beijing rather than the host timezone', () => {
  const now = new Date('2026-08-30T16:30:00Z'); // 北京 8/31 00:30
  const ts = new Date('2026-08-30T15:55:00Z').getTime(); // 北京 8/30 23:55
  assert.strictEqual(formatAbsoluteTime(ts, now), '8月30日 23:55');
});
