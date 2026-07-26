'use strict';

const assert = require('assert');
const {
  didClaudeSnapshotAdvance,
  selectClaudeStatuslineUsage,
} = require('../main/usage/claude-statusline-usage.js');

const selected = selectClaudeStatuslineUsage({
  newerWeekly: {
    ts: 20_000,
    usage7d: { pct: 14, resetsAt: 700_000 },
  },
  olderPrimary: {
    ts: 10_000,
    usage5h: { pct: 42, resetsAt: 300_000 },
  },
});

assert.deepStrictEqual(selected, {
  usage5h: { pct: 42, resetsAt: 300_000 },
  usage7d: { pct: 14, resetsAt: 700_000 },
  ts: 10_000,
  source: 'statusline-cache',
}, 'row freshness must use the older selected window instead of masking it with max(ts)');

assert.strictEqual(didClaudeSnapshotAdvance({
  usage5h: { pct: 42, resetsAt: 300_000 },
  observedAt: 100,
}, {
  usage5h: { pct: 42, resetsAt: 300_000 },
  observedAt: 200,
}), true, 'a newer observation is a new snapshot even when percentages are unchanged');

assert.strictEqual(didClaudeSnapshotAdvance({
  usage5h: { pct: 42, resetsAt: 300_000 },
  observedAt: 200,
}, {
  usage5h: { pct: 42, resetsAt: 300_001 },
  observedAt: 200,
}), false, 'reset timestamp drift inside the same observation must not claim a new snapshot');

assert.strictEqual(didClaudeSnapshotAdvance({ usage5h: { pct: 41 } }, {
  usage5h: { pct: 42 },
}), true, 'usage diff is a fallback only when neither side has an observation timestamp');

console.log('unit-claude-statusline-usage OK');
