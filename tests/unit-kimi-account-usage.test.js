'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseKimiUsagePayload,
  readKimiAccountUsage,
} = require('../main/usage/kimi-account-usage.js');

const now = Date.parse('2026-07-19T00:00:00Z');
const payload = {
  usage: { used: '13', remaining: '87', limit: '100', resetTime: '2026-07-25T00:00:00Z' },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { used: '67', remaining: '33', limit: '100', resetTime: '2026-07-19T01:00:00Z' },
  }],
};

assert.deepStrictEqual(parseKimiUsagePayload(payload, now), {
  usage5h: { pct: 67, used: 67, limit: 100, label: '5h', resetsAt: Date.parse('2026-07-19T01:00:00Z') },
  usage7d: { pct: 13, used: 13, limit: 100, label: '周', resetsAt: Date.parse('2026-07-25T00:00:00Z') },
  observedAt: now,
  source: 'kimi-api',
});

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-usage-'));
  try {
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(home, 'credentials', 'kimi-code.json'), JSON.stringify({
      access_token: 'secret-test-token',
      expires_at: now + 3600000,
    }), 'utf8');
    let request = null;
    const result = await readKimiAccountUsage({
      home,
      now: () => now,
      fetchImpl: async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, json: async () => payload };
      },
    });
    assert.strictEqual(request.url, 'https://api.kimi.com/coding/v1/usages');
    assert.strictEqual(request.init.headers.Authorization, 'Bearer secret-test-token');
    assert.strictEqual(result.usage5h.pct, 67);
    assert.strictEqual(result.usage7d.pct, 13);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log('unit-kimi-account-usage OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
