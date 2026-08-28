'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PHILOSOPHY_TEMPLATES, getPhilosophy } = require('../core/agent-league-philosophies.js');

test('ships a provisional Chuxin baseline plus eight distinct philosophies without model presets', () => {
  assert.equal(PHILOSOPHY_TEMPLATES.length, 9);
  assert.equal(new Set(PHILOSOPHY_TEMPLATES.map((row) => row.key)).size, 9);
  for (const row of PHILOSOPHY_TEMPLATES) {
    assert(row.summary.length > 10);
    assert(row.edge.length > 10);
    assert(row.entry.length > 10);
    assert(row.exit.length > 10);
    assert.equal(Object.hasOwn(row, 'provider'), false);
    assert.equal(Object.hasOwn(row, 'model'), false);
  }
  const baseline = getPhilosophy('chuxin-value-speculation');
  assert.equal(baseline.provisional, true);
  assert.equal(baseline.checklist.length, 7);
  assert.match(baseline.summary, /估值与位置/);
  assert.equal(getPhilosophy('risk-first').title, '风险优先与现金管理');
  assert.equal(getPhilosophy('missing'), null);
});
