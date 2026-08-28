'use strict';

// 2026 年休市日来自上海证券交易所年度休市安排。自动赛程在覆盖期外会
// 明确暂停，避免把“周一至周五”静默当成真实交易日历。
const EXCHANGE_CALENDAR = Object.freeze({
  schemaVersion: 1,
  market: 'CN_A_SH_SZ',
  timezone: 'Asia/Shanghai',
  coverageStart: '2026-01-01',
  coverageEnd: '2026-12-31',
  source: 'https://www.sse.com.cn/disclosure/dealinstruc/closed/',
  closedDates: Object.freeze([
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
    '2026-02-14', '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', '2026-02-28',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-09',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-20', '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-10',
  ]),
});

function chinaClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const row = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${row.year}-${row.month}-${row.day}`,
    weekday: row.weekday,
    hour: Number(row.hour),
    minute: Number(row.minute),
    minutes: Number(row.hour) * 60 + Number(row.minute),
  };
}

function tradingDayStatus(date, calendar = EXCHANGE_CALENDAR) {
  const value = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { isTradingDay: false, reason: 'invalid-date', certainty: 'invalid' };
  }
  if (value < calendar.coverageStart || value > calendar.coverageEnd) {
    return {
      isTradingDay: false,
      reason: `calendar-out-of-coverage:${calendar.coverageStart}:${calendar.coverageEnd}`,
      certainty: 'out-of-coverage',
    };
  }
  const noonUtc = new Date(`${value}T04:00:00.000Z`);
  const weekday = noonUtc.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { isTradingDay: false, reason: 'weekend', certainty: 'official-calendar' };
  }
  if (new Set(calendar.closedDates).has(value)) {
    return { isTradingDay: false, reason: 'exchange-closed', certainty: 'official-calendar' };
  }
  return { isTradingDay: true, reason: 'exchange-open', certainty: 'official-calendar' };
}

function parseClock(value, fallback) {
  const input = /^\d{2}:\d{2}$/.test(String(value || '')) ? String(value) : fallback;
  const [hour, minute] = input.split(':').map(Number);
  return Math.max(0, Math.min(1439, hour * 60 + minute));
}

module.exports = {
  EXCHANGE_CALENDAR,
  chinaClock,
  parseClock,
  tradingDayStatus,
};
