'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BEIJING_TIME_ZONE,
  beijingDateKey,
  beijingEpoch,
  beijingParts,
  formatBeijingClock,
  formatBeijingDateTime,
} = require('../core/beijing-time.js');
const { buildNightWindow } = require('../renderer/home-workbench.js');

test('Beijing clock is fixed UTC+8 and independent of host timezone', () => {
  const ts = Date.parse('2026-08-30T05:20:31Z');
  assert.equal(BEIJING_TIME_ZONE, 'Asia/Shanghai');
  assert.deepEqual(beijingParts(ts), {
    year: 2026, month: 8, day: 30, hour: 13, minute: 20, second: 31, millisecond: 0,
  });
  assert.equal(formatBeijingClock(ts), '13:20');
  assert.equal(formatBeijingClock(ts, { seconds: true }), '13:20:31');
  assert.equal(formatBeijingDateTime(ts), '2026-08-30 13:20:31');
  assert.equal(beijingDateKey(ts), '2026-08-30');
});

test('ISO timestamps use the same Beijing conversion as epoch milliseconds', () => {
  assert.equal(formatBeijingDateTime('2020-01-01T00:00:00.000Z'), '2020-01-01 08:00:00');
});

test('Beijing wall-clock conversion handles day rollover', () => {
  const epoch = beijingEpoch({ year: 2026, month: 8, day: 31, hour: 0, minute: 5 });
  assert.equal(new Date(epoch).toISOString(), '2026-08-30T16:05:00.000Z');
});

test('night summary boundaries are anchored to Beijing 20:00 and 08:00', () => {
  const eveningNow = Date.parse('2026-08-30T13:00:00Z'); // 北京 21:00
  assert.deepEqual(buildNightWindow(eveningNow), {
    start: Date.parse('2026-08-30T12:00:00Z'),
    end: eveningNow,
    label: '今晚 20:00 至现在',
  });

  const daytimeNow = Date.parse('2026-08-30T02:00:00Z'); // 北京 10:00
  assert.deepEqual(buildNightWindow(daytimeNow), {
    start: Date.parse('2026-08-29T12:00:00Z'),
    end: Date.parse('2026-08-30T00:00:00Z'),
    label: '昨晚 20:00 至今早 08:00',
  });
});
