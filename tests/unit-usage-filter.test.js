'use strict';

const assert = require('assert');
const { shouldAcceptUsage, createUsageFilter } = require('../core/usage-filter.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running usage-filter tests...');

// --- 5h (fixed window) — monotonic lock SHOULD stay ---

test('5h: accepts first value when prev=null', () => {
  const prev = null;
  const next = { pct: 50, resetsAt: 1_700_000_000_000 };
  assert.strictEqual(shouldAcceptUsage(prev, next), true);
});

test('5h: accepts rising pct in same window', () => {
  const prev = { pct: 50, resetsAt: 1_700_000_000_000 };
  const next = { pct: 60, resetsAt: 1_700_000_000_000 };
  assert.strictEqual(shouldAcceptUsage(prev, next), true);
});

test('5h: rejects falling pct in same window (stale-snapshot guard)', () => {
  const prev = { pct: 80, resetsAt: 1_700_000_000_000 };
  const next = { pct: 40, resetsAt: 1_700_000_000_000 };
  assert.strictEqual(shouldAcceptUsage(prev, next), false);
});

test('5h: accepts any pct after window reset (resetsAt jump > 60s)', () => {
  const prev = { pct: 80, resetsAt: 1_700_000_000_000 };
  const next = { pct: 10, resetsAt: 1_700_000_000_000 + 5 * 3600 * 1000 };
  assert.strictEqual(shouldAcceptUsage(prev, next), true);
});

// --- 7d (rolling window) — monotonic lock MUST NOT apply ---
// This is the bug: Anthropic weekly limit is a 7-day rolling window. Old
// consumption naturally rolls out and pct goes DOWN, but the monotonic lock
// pins Hub to the historical peak forever (resetsAt stays roughly constant
// in rolling mode, so the >60s reset branch never fires either).

test('7d (rolling): accepts falling pct in same window', () => {
  const prev = { pct: 75, resetsAt: 1_700_000_000_000 };
  const next = { pct: 60, resetsAt: 1_700_000_000_000 + 30_000 }; // <60s drift
  assert.strictEqual(shouldAcceptUsage(prev, next, { isRolling: true }), true);
});

test('7d (rolling): accepts rising pct too', () => {
  const prev = { pct: 40, resetsAt: 1_700_000_000_000 };
  const next = { pct: 55, resetsAt: 1_700_000_000_000 + 10_000 };
  assert.strictEqual(shouldAcceptUsage(prev, next, { isRolling: true }), true);
});

test('7d (rolling): still rejects null next', () => {
  const prev = { pct: 40, resetsAt: 1_700_000_000_000 };
  assert.strictEqual(shouldAcceptUsage(prev, null, { isRolling: true }), false);
});

// --- createUsageFilter() integration: 5h monotonic, 7d not ---

test('filter(): 7d falling value accepted, 5h falling value rejected', () => {
  const f = createUsageFilter();
  // Seed with peaks
  f.filter({ pct: 80, resetsAt: 1_700_000_000_000 }, { pct: 75, resetsAt: 1_700_000_000_000 });
  // Now both pcts come in lower (5h fixed window, stale; 7d rolling, real drop)
  const out = f.filter(
    { pct: 30, resetsAt: 1_700_000_000_000 + 10_000 },  // 5h: should reject (stale guard)
    { pct: 60, resetsAt: 1_700_000_000_000 + 10_000 },  // 7d: should accept (rolling drop)
  );
  assert.strictEqual(out.usage5h, null, '5h falling value must be rejected');
  assert.ok(out.usage7d, '7d falling value must be accepted');
  assert.strictEqual(out.usage7d.pct, 60);
  assert.strictEqual(out.anyAccepted, true);
  // Snapshot reflects accepted state
  const snap = f.snapshot();
  assert.strictEqual(snap.usage5h.pct, 80, '5h snapshot stays at peak 80');
  assert.strictEqual(snap.usage7d.pct, 60, '7d snapshot updates to new 60');
});
