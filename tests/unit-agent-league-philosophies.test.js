'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PHILOSOPHY_TEMPLATES, getPhilosophy } = require('../core/agent-league-philosophies.js');

test('ships a provisional Chuxin baseline plus nine distinct philosophies without model presets', () => {
  assert.equal(PHILOSOPHY_TEMPLATES.length, 10);
  assert.equal(new Set(PHILOSOPHY_TEMPLATES.map((row) => row.key)).size, 10);
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

test('the Chuxin avatar carries the right-side dual-mode contract, not the left-side baseline', () => {
  const avatar = getPhilosophy('chuxin-avatar-right-side');
  assert.equal(avatar.title, '初心化身·右侧双模式');
  // 化身不是"待确认草案"：它是按创建者已确认的体系建的。
  assert.equal(avatar.provisional, undefined);
  // 追涨与低吸是同一套选股标准下的两个阶段，checklist 必须把"先判阶段"写成硬规则。
  assert.equal(avatar.checklist.length, 11);
  assert.match(avatar.checklist.find((row) => row.id === 'P1').text, /先判定当前属于追涨还是低吸阶段/);
  assert.match(avatar.checklist.find((row) => row.id === 'P1').text, /不得用于否决高龙分标的/);
  assert.match(avatar.summary, /强度决定买什么/);
  assert.match(avatar.universe, /华为昇腾/);
  // 每个环节都要有自己的提示，不能退回三家几乎逐字相同的默认文案。
  for (const stage of ['daily', 'hook', 'weekly']) {
    assert(Array.isArray(avatar.prompts[stage]) && avatar.prompts[stage].length >= 5);
  }
  assert(avatar.sections.length >= 3);
  assert(avatar.strategySections.length >= 1);
});
