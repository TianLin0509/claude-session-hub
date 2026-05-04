const test = require('node:test');
const assert = require('node:assert');
const { formatAbsoluteTime } = require('../renderer/format-time.js');

test('same day → HH:MM', () => {
  const now = new Date('2026-05-04T14:22:00');
  const ts = new Date('2026-05-04T08:30:00').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '08:30');
});

test('cross day same year → M月D日 HH:MM', () => {
  const now = new Date('2026-05-04T14:22:00');
  const ts = new Date('2026-05-03T14:22:00').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '5月3日 14:22');
});

test('cross year → YYYY年M月D日 HH:MM', () => {
  const now = new Date('2026-05-04T14:22:00');
  const ts = new Date('2025-12-03T14:22:00').getTime();
  assert.strictEqual(formatAbsoluteTime(ts, now), '2025年12月3日 14:22');
});
