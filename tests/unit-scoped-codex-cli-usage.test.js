'use strict';

const assert = require('assert');
const path = require('path');
const {
  recordCodexCliUsage,
  selectCodexCliUsageForScope,
  pruneCodexCliUsage,
} = require('../main/usage/scoped-codex-cli-usage.js');

const now = 10_000_000;
const defaultRoot = path.resolve('C:\\profiles\\main\\sessions');
const secondRoot = path.resolve('C:\\profiles\\second\\sessions');
const store = new Map();

recordCodexCliUsage(store, {
  id: 'main-session',
  createdAt: now - 20_000,
  codexSessionsRoot: defaultRoot,
}, { usage5h: { pct: 11 }, usage7d: { pct: 2 } }, now - 1000, defaultRoot);
recordCodexCliUsage(store, {
  id: 'second-session',
  createdAt: now - 10_000,
  codexSessionsRoot: secondRoot,
}, { usage5h: { pct: 88 }, usage7d: { pct: 44 } }, now, defaultRoot);

assert.strictEqual(selectCodexCliUsageForScope(store, {
  sessionsRoot: defaultRoot,
  authSinceMs: now - 30_000,
}, { now, maxAgeMs: 120_000, defaultSessionsRoot: defaultRoot }).usage5h.pct, 11,
'a newer /usage from another profile must not overwrite the selected profile');

const sameRootAfterAuthSwitch = new Map();
recordCodexCliUsage(sameRootAfterAuthSwitch, {
  id: 'old-account-session',
  createdAt: now - 60_000,
  codexSessionsRoot: defaultRoot,
}, { usage5h: { pct: 97 }, usage7d: { pct: 81 } }, now, defaultRoot);
assert.strictEqual(selectCodexCliUsageForScope(sameRootAfterAuthSwitch, {
  sessionsRoot: defaultRoot,
  authSinceMs: now - 30_000,
}, { now, maxAgeMs: 120_000, defaultSessionsRoot: defaultRoot }), null,
'a session created before the current auth must not supply current-account quota');

recordCodexCliUsage(sameRootAfterAuthSwitch, {
  id: 'current-account-session',
  createdAt: now - 20_000,
  codexSessionsRoot: defaultRoot,
}, { usage5h: { pct: 3 }, usage7d: { pct: 1 } }, now - 1000, defaultRoot);
assert.strictEqual(selectCodexCliUsageForScope(sameRootAfterAuthSwitch, {
  sessionsRoot: defaultRoot,
  authSinceMs: now - 30_000,
}, { now, maxAgeMs: 120_000, defaultSessionsRoot: defaultRoot }).usage5h.pct, 3);

pruneCodexCliUsage(sameRootAfterAuthSwitch, now + 11 * 60_000, 10 * 60_000);
assert.strictEqual(sameRootAfterAuthSwitch.size, 0, 'stale per-session CLI quota entries must expire');

console.log('unit-scoped-codex-cli-usage OK');
