'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeAccountUsageFromControl } = require('../core/claude-native-usage');
const { ClaudeNativeSession } = require('../core/claude-native-session');

const REPLY = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 7, resets_at: '2026-09-12T21:39:59.650641+00:00' },
    seven_day: { utilization: 2, resets_at: '2026-09-19T10:59:59.650661+00:00' },
    seven_day_opus: null,
  },
};

test('account usage maps the engine reply onto the windows the rings read', () => {
  const usage = claudeAccountUsageFromControl(REPLY, 1000);
  assert.deepEqual(usage.usage5h, { pct: 7, resetsAt: Date.parse('2026-09-12T21:39:59.650641+00:00') });
  assert.deepEqual(usage.usage7d, { pct: 2, resetsAt: Date.parse('2026-09-19T10:59:59.650661+00:00') });
  assert.equal(usage.subscriptionType, 'max');
  assert.equal(usage.observedAt, 1000);
});

test('an engine that cannot report quota yields nothing instead of a zeroed ring', () => {
  // A missing figure must never be published as "0% used": the monotonic filter
  // would accept it as a new window and erase a real reading.
  assert.equal(claudeAccountUsageFromControl({ rate_limits_available: false, rate_limits: REPLY.rate_limits }), null);
  assert.equal(claudeAccountUsageFromControl({ rate_limits_available: true, rate_limits: {} }), null);
  assert.equal(claudeAccountUsageFromControl(null), null);
  const partial = claudeAccountUsageFromControl({ rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 41 }, seven_day: { utilization: 'n/a' } } });
  assert.deepEqual(partial.usage5h, { pct: 41, resetsAt: 0 });
  assert.equal(partial.usage7d, null);
});

test('a disconnected native session reports no quota instead of asking a dead transport', async () => {
  const session = new ClaudeNativeSession({ id: 's', kind: 'claude', cwd: process.cwd(),
    launchArgs: [], sessionId: '11111111-2222-3333-4444-555555555555' });
  assert.equal(await session.readAccountUsage(), null);
  const controls = [];
  session.client = { control: async request => { controls.push(request); return REPLY; } };
  session.runtime.connection = 'connected';
  const usage = await session.readAccountUsage();
  assert.deepEqual(controls, [{ subtype: 'get_usage' }]);
  assert.equal(usage.usage5h.pct, 7);
});
