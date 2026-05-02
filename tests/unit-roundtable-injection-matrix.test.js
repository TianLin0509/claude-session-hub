'use strict';
// 单元测试 core/roundtable-injection.js — 上一轮注入矩阵 (方案 F · 2026-05-02)
//
// 覆盖 spec §8.1 矩阵 11 行规则：
//   1. 首轮 → 不注入
//   2. all → all：每个 AI 收除自己外另两家
//   3. all → pilot：主驾收另两家
//   4. all → observer：每个副驾收主驾 + 另一副驾
//   5. pilot → pilot（同主驾）：跳过 ← 同组规则
//   6. pilot → observer：副驾收主驾全文
//   7. pilot → all：每个 AI 收主驾全文（主驾自己跳过）
//   8. observer → observer（同两副驾）：跳过 ← 同组规则
//   9. observer → pilot：主驾收副驾两家
//  10. observer → all：每 AI 收"上一轮发言者中除自己外"
//  11. summary-brief → 任意：全注入摘要

const assert = require('assert');
const { computeLastTurnInjection, _setsEqual } = require('../core/roundtable-injection');

const SID_PILOT = 'sid_pilot';
const SID_CO1 = 'sid_co1';   // 副驾 1
const SID_CO2 = 'sid_co2';   // 副驾 2

const labelMap = { sid_pilot: 'Claude', sid_co1: 'Gemini', sid_co2: 'Codex' };
const labelOf = (sid) => labelMap[sid] || sid;
const roleMap = { sid_pilot: 'pilot', sid_co1: 'observer', sid_co2: 'observer' };
const roleOf = (sid) => roleMap[sid] || null;

function makeTurn(n, mode, dispatchMode, byMap, byStatusMap = null) {
  return {
    n,
    mode,
    dispatchMode,
    by: byMap || {},
    byStatus: byStatusMap,
  };
}

// ============================================================
function testRule1_FirstTurnNoInjection() {
  const r = computeLastTurnInjection(null, [SID_PILOT, SID_CO1, SID_CO2], labelOf, roleOf);
  assert.strictEqual(r[SID_PILOT], null);
  assert.strictEqual(r[SID_CO1], null);
  assert.strictEqual(r[SID_CO2], null);
  // 也测 lastTurn 是 undefined
  const r2 = computeLastTurnInjection(undefined, [SID_PILOT], labelOf, roleOf);
  assert.strictEqual(r2[SID_PILOT], null);
  console.log('  ✓ testRule1_FirstTurnNoInjection');
}

function testRule2_AllToAll() {
  // all → all：三家全发言，每家应收除自己外另两家（不跳过，即使集合相同）
  const last = makeTurn(1, 'fanout', 'all', {
    sid_pilot: 'Claude 上一轮',
    sid_co1: 'Gemini 上一轮',
    sid_co2: 'Codex 上一轮',
  });
  const r = computeLastTurnInjection(last, [SID_PILOT, SID_CO1, SID_CO2], labelOf, roleOf);
  // 主驾应收 Gemini + Codex
  assert.ok(r[SID_PILOT], 'pilot should receive injection');
  const pilotSpkSids = r[SID_PILOT].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(pilotSpkSids, [SID_CO1, SID_CO2].sort(), 'pilot sees other 2');
  // co1 应收 pilot + co2
  const co1Sids = r[SID_CO1].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(co1Sids, [SID_PILOT, SID_CO2].sort(), 'co1 sees other 2');
  // co2 应收 pilot + co1
  const co2Sids = r[SID_CO2].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(co2Sids, [SID_PILOT, SID_CO1].sort(), 'co2 sees other 2');
  console.log('  ✓ testRule2_AllToAll');
}

function testRule5_PilotToPilot_Skip() {
  const last = makeTurn(2, 'fanout', 'pilot', { sid_pilot: 'Claude 主驾上一轮' });
  const r = computeLastTurnInjection(last, [SID_PILOT], labelOf, roleOf);
  assert.strictEqual(r[SID_PILOT], null, 'pilot→pilot should skip injection');
  console.log('  ✓ testRule5_PilotToPilot_Skip');
}

function testRule8_ObserverToObserver_Skip() {
  const last = makeTurn(3, 'fanout', 'observer', {
    sid_co1: 'Gemini 副驾上一轮',
    sid_co2: 'Codex 副驾上一轮',
  });
  const r = computeLastTurnInjection(last, [SID_CO1, SID_CO2], labelOf, roleOf);
  assert.strictEqual(r[SID_CO1], null, 'co1 should skip');
  assert.strictEqual(r[SID_CO2], null, 'co2 should skip');
  console.log('  ✓ testRule8_ObserverToObserver_Skip');
}

function testRule6_PilotToObserver() {
  const last = makeTurn(2, 'fanout', 'pilot', { sid_pilot: 'Claude 主驾深聊' });
  const r = computeLastTurnInjection(last, [SID_CO1, SID_CO2], labelOf, roleOf);
  assert.ok(r[SID_CO1], 'co1 should receive injection');
  assert.strictEqual(r[SID_CO1].speakers.length, 1, 'one speaker');
  assert.strictEqual(r[SID_CO1].speakers[0].sid, SID_PILOT);
  assert.strictEqual(r[SID_CO1].speakers[0].label, 'Claude');
  assert.strictEqual(r[SID_CO1].speakers[0].text, 'Claude 主驾深聊');
  assert.ok(r[SID_CO2], 'co2 should receive injection too');
  assert.strictEqual(r[SID_CO2].speakers[0].sid, SID_PILOT);
  console.log('  ✓ testRule6_PilotToObserver');
}

function testRule9_ObserverToPilot() {
  const last = makeTurn(4, 'fanout', 'observer', {
    sid_co1: 'Gemini 上一轮',
    sid_co2: 'Codex 上一轮',
  });
  const r = computeLastTurnInjection(last, [SID_PILOT], labelOf, roleOf);
  assert.ok(r[SID_PILOT]);
  assert.strictEqual(r[SID_PILOT].speakers.length, 2);
  const sids = r[SID_PILOT].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(sids, [SID_CO1, SID_CO2].sort());
  console.log('  ✓ testRule9_ObserverToPilot');
}

function testRule3_AllToPilot() {
  const last = makeTurn(1, 'fanout', 'all', {
    sid_pilot: 'pilot text',
    sid_co1: 'co1 text',
    sid_co2: 'co2 text',
  });
  // 当前轮：仅主驾发言
  const r = computeLastTurnInjection(last, [SID_PILOT], labelOf, roleOf);
  assert.ok(r[SID_PILOT]);
  // 主驾应收到另两家（不含自己）
  assert.strictEqual(r[SID_PILOT].speakers.length, 2);
  const sids = r[SID_PILOT].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(sids, [SID_CO1, SID_CO2].sort());
  console.log('  ✓ testRule3_AllToPilot');
}

function testRule4_AllToObserver() {
  const last = makeTurn(1, 'fanout', 'all', {
    sid_pilot: 'pilot text',
    sid_co1: 'co1 text',
    sid_co2: 'co2 text',
  });
  // 当前轮：副驾两家
  const r = computeLastTurnInjection(last, [SID_CO1, SID_CO2], labelOf, roleOf);
  assert.ok(r[SID_CO1]);
  // 副驾 1 应收到主驾 + 另一副驾（不含自己）
  assert.strictEqual(r[SID_CO1].speakers.length, 2);
  const sids1 = r[SID_CO1].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(sids1, [SID_PILOT, SID_CO2].sort());
  // 副驾 2 同理
  const sids2 = r[SID_CO2].speakers.map(s => s.sid).sort();
  assert.deepStrictEqual(sids2, [SID_PILOT, SID_CO1].sort());
  console.log('  ✓ testRule4_AllToObserver');
}

function testRule7_PilotToAll() {
  const last = makeTurn(2, 'fanout', 'pilot', { sid_pilot: 'pilot solo' });
  // 当前轮：三家全员
  const r = computeLastTurnInjection(last, [SID_PILOT, SID_CO1, SID_CO2], labelOf, roleOf);
  // 主驾自己跳过（lastSpeakers - {self} 为空）
  assert.strictEqual(r[SID_PILOT], null, 'pilot self should skip (no other in last)');
  // 副驾应收到主驾
  assert.ok(r[SID_CO1]);
  assert.strictEqual(r[SID_CO1].speakers.length, 1);
  assert.strictEqual(r[SID_CO1].speakers[0].sid, SID_PILOT);
  console.log('  ✓ testRule7_PilotToAll');
}

function testRule11_SummaryBriefInjection() {
  const last = makeTurn(5, 'summary-brief', 'pilot',
    { sid_pilot: '1. 目标：xxx\n2. 关键事实：yyy\n3. 关键分歧：zzz' },
    null);
  // 当前轮：副驾两家审查
  const r = computeLastTurnInjection(last, [SID_CO1, SID_CO2], labelOf, roleOf);
  assert.ok(r[SID_CO1]);
  assert.strictEqual(r[SID_CO1].isSummaryInjection, true);
  assert.strictEqual(r[SID_CO1].speakers.length, 1);
  assert.strictEqual(r[SID_CO1].speakers[0].text, '1. 目标：xxx\n2. 关键事实：yyy\n3. 关键分歧：zzz');
  // 摘要也注入给摘要发出方自己
  const r2 = computeLastTurnInjection(last, [SID_PILOT], labelOf, roleOf);
  assert.ok(r2[SID_PILOT], 'summary-brief should inject to self too (回看自己摘要)');
  assert.strictEqual(r2[SID_PILOT].isSummaryInjection, true);
  console.log('  ✓ testRule11_SummaryBriefInjection');
}

function testInjectionPayloadFields() {
  const last = makeTurn(7, 'debate', 'all', {
    sid_pilot: 'p text',
    sid_co1: 'c1 text',
    sid_co2: 'c2 text',
  }, { sid_pilot: 'completed', sid_co1: 'absent', sid_co2: 'errored' });
  const r = computeLastTurnInjection(last, [SID_PILOT], labelOf, roleOf);
  assert.ok(r[SID_PILOT]);
  assert.strictEqual(r[SID_PILOT].lastTurnNum, 7);
  assert.strictEqual(r[SID_PILOT].lastTurnMode, 'debate');
  assert.strictEqual(r[SID_PILOT].lastDispatchMode, 'all');
  assert.strictEqual(r[SID_PILOT].isSummaryInjection, false);
  // status 透传
  const speakers = r[SID_PILOT].speakers;
  const co1 = speakers.find(s => s.sid === SID_CO1);
  assert.strictEqual(co1.status, 'absent');
  const co2 = speakers.find(s => s.sid === SID_CO2);
  assert.strictEqual(co2.status, 'errored');
  // role 透传
  assert.strictEqual(co1.role, 'observer');
  console.log('  ✓ testInjectionPayloadFields');
}

function testSetsEqualHelper() {
  assert.ok(_setsEqual(['a', 'b'], ['b', 'a']));
  assert.ok(_setsEqual([], []));
  assert.ok(!_setsEqual(['a'], ['a', 'b']));
  assert.ok(!_setsEqual(['a', 'b'], ['a', 'c']));
  console.log('  ✓ testSetsEqualHelper');
}

console.log('Running roundtable-injection unit tests...');
let failed = 0;
const tests = [
  testRule1_FirstTurnNoInjection,
  testRule2_AllToAll,
  testRule3_AllToPilot,
  testRule4_AllToObserver,
  testRule5_PilotToPilot_Skip,
  testRule6_PilotToObserver,
  testRule7_PilotToAll,
  testRule8_ObserverToObserver_Skip,
  testRule9_ObserverToPilot,
  testRule11_SummaryBriefInjection,
  testInjectionPayloadFields,
  testSetsEqualHelper,
];
for (const t of tests) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    failed++;
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
