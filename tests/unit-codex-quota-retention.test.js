'use strict';
const assert = require('node:assert/strict');
const { createAccountUsageController } = require('../renderer/account-usage-controller');
const { mergeCodexEntry } = require('../main/usage/usage-cache-merge');
const now = 1_800_000_000_000;
const saved = { usage7d: { pct: 28, resetsAt: now - 1 }, observedAt: now - 600000,
  source: 'app-server', scopeKey: 'account-a' };
const empty = { usage5h: null, usage7d: null, unavailable: true, observedAt: now, scopeKey: 'account-a' };
const controller = createAccountUsageController({ document: { getElementById() { return null; } },
  ipcRenderer: {}, sessions: new Map(), escapeHtml: String, nowFn: () => now, setIntervalFn() {} });
controller.applyUsageCache({ codex: saved });
controller.recordAgentUsage({ codex: empty });
assert.equal(controller.getSnapshot().codex.usage7d?.pct, 28, 'empty background observation must retain the last weekly quota');
assert.equal(controller.getSnapshot().codex.lastSeen, saved.observedAt, 'retention must not invent freshness');
assert.equal(mergeCodexEntry(saved, empty, now).usage7d?.pct, 28, 'disk cache must retain the same observation across restart');
const partial = { usage5h: { pct: 4 }, usage7d: null, observedAt: now, scopeKey: 'account-a', source: 'jsonl' };
controller.recordAgentUsage({ codex: partial });
assert.equal(controller.getSnapshot().codex.usage7d?.pct, 28, '5h-only background data must not erase the weekly bar');
assert.equal(controller.getSnapshot().codex.usage7d.observedAt, saved.observedAt);
const next = { usage7d: { pct: 0, resetsAt: now + 86400000 }, observedAt: now + 1,
  scopeKey: 'account-a', source: 'app-server' };
controller.recordAgentUsage({ codex: next });
assert.equal(controller.getSnapshot().codex.usage7d.pct, 0, 'new valid observation replaces retained value, including zero');
controller.recordAgentUsage({ codex: { ...empty, scopeKey: 'account-b' } });
assert.equal(controller.getSnapshot().codex.usage7d, null, 'never retain another account quota');
controller.recordAgentUsage({ codex: null });
assert.equal(controller.getSnapshot().codex, null, 'explicit clear remains unknown');
console.log('unit-codex-quota-retention OK');
