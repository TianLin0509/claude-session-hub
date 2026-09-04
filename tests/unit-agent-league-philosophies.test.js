'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PHILOSOPHY_TEMPLATES, getPhilosophy } = require('../core/agent-league-philosophies.js');

test('ships a provisional Chuxin baseline plus ten distinct philosophies without model presets', () => {
  assert.equal(PHILOSOPHY_TEMPLATES.length, 11);
  assert.equal(new Set(PHILOSOPHY_TEMPLATES.map((row) => row.key)).size, 11);
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

test('the bingdian philosophy encodes the interview, not the first (inverted) inference', () => {
  const p = getPhilosophy('bingdian-dragon-cycle');
  assert.equal(p.title, '冰点梭哈·龙头情绪周期');
  // 第一版按交割单反推，把"熟悉度"当成了入场门槛。本人受访澄清后因果反过来：
  // 反复交易是龙头身份的结果。这条测试锁住修正方向，防止哪天又退回去。
  assert.equal(getPhilosophy('bingdian-familiar-rotation'), null);
  assert.match(p.checklist.find((row) => row.id === 'D1').text, /当期市场核心龙头/);
  assert.match(p.checklist.find((row) => row.id === 'D1').text, /做过很多次不构成理由/);

  // 「冰点」是市场情绪冰点，「梭哈」是真的梭哈 —— 重手上限必须留着，
  // 但必须被情绪证据锁住，否则 Agent 会在没有触发条件时用满 60%。
  assert.equal(p.maxSingleWeight, 0.60);
  const e1 = p.checklist.find((row) => row.id === 'E1');
  assert.match(e1.text, /冰点共振/);
  assert.match(e1.text, /数据不可得/);
  assert.match(e1.text, /不得用推测代替/);
  // 工具已接上（scan_emotion_cycle），但 fallback 分支必须保留：
  // 超窗/端点挂掉/超时都会发生，接上工具并没有消除取不到数的风险。
  assert(p.sections.some((s) => /冰点共振怎么取数/.test(s.title)));
  assert(p.sections.some((s) => /取不到数据时/.test(s.title)));
  assert.match(p.checklist.find((row) => row.id === 'E1').text, /scan_emotion_cycle/);
  assert.match(p.checklist.find((row) => row.id === 'E1').text, /unavailable_out_of_window/);

  // 追问补充：冰点不是一个而是四个，触发重手的是共振。
  // 写成单一冰点会让 Agent 在远低于真实频率的门槛上开重仓。
  assert.match(p.checklist.find((row) => row.id === 'E1').text, /共振/);
  assert.match(p.checklist.find((row) => row.id === 'E1').text, /1500/);
  assert(p.sections.some((s) => /冰点不是一个/.test(s.title)));
  // 主动性/带动性是两个不同时点的观察，不能合并成一句「领涨」。
  const d2 = p.checklist.find((row) => row.id === 'D2');
  assert.match(d2.text, /板块日内领涨/);
  assert.match(d2.text, /封板后/);
  // 华胜天成的三条教训必须各自有硬规则，不能只写在正文里。
  assert.match(p.checklist.find((row) => row.id === 'X2').text, /水下不给红盘/);
  assert.match(p.checklist.find((row) => row.id === 'R2').text, /未止跌企稳/);
  assert.match(p.checklist.find((row) => row.id === 'E2').text, /正反馈/);
  // 反抽是「盘中重仓、尾盘 T 出」，收盘快照测不到；
  // 第一版据此把反抽仓位低估成了 20%。
  assert.match(p.checklist.find((row) => row.id === 'R1').text, /≤40%/);


  // 卖出信号是量能和情绪。+8%/-6% 是统计结果，写成规则就同时丢掉两端。
  assert.match(p.checklist.find((row) => row.id === 'X1').text, /不得写成固定百分比目标/);
  assert.match(p.exit, /不设固定百分比目标/);

  // 本人认为耐心是全部优势；空仓不需要理由，模式外操作才需要。
  assert.match(p.checklist.find((row) => row.id === 'B1').text, /害怕自己赚不到钱/);

  const ids = p.checklist.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const stage of ['daily', 'hook', 'weekly']) {
    assert(Array.isArray(p.prompts[stage]) && p.prompts[stage].length >= 5);
  }
  assert(p.strategySections.length >= 1);
});
