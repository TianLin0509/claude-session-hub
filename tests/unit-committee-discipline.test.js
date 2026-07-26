'use strict';
/**
 * 投委会战法纪律底色注入单测（task#2）。
 * 真 require 执行 orchestrator，验证 research 场景带「追涨/低吸右侧画像」纪律，general 隔离不污染。
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const orchestrator = require(path.join(root, 'core', 'group-chat-orchestrator.js'));
const { buildSystemPromptText, COMMITTEE_DISCIPLINE } = orchestrator._private;

// ── 纪律常量含画像表核心 ──
assert.ok(COMMITTEE_DISCIPLINE, 'COMMITTEE_DISCIPLINE 应导出');
assert.ok(COMMITTEE_DISCIPLINE.includes('右侧交易战法纪律'), '纪律标题');
for (const k of ['追涨', '低吸', '右侧', '上升趋势', '否决线', '题材正宗', '20 日线', '宁可错过']) {
  assert.ok(COMMITTEE_DISCIPLINE.includes(k), `纪律缺关键词: ${k}`);
}
// 关键防错：追涨/低吸都右侧、差异在阶段；低吸≠左侧抄底（用户亲自纠正过的点）
assert.ok(COMMITTEE_DISCIPLINE.includes('差异只在阶段'), '必须强调「差异只在阶段」');
assert.ok(COMMITTEE_DISCIPLINE.includes('不是左侧抄底'), '低吸必须标「不是左侧抄底」');

// ── research system prompt 带纪律底色（常驻，自由聊也带）──
const sysResearch = buildSystemPromptText('委员A', 'research');
assert.ok(sysResearch.includes('右侧交易战法纪律'), 'research system prompt 应含战法纪律底色');
assert.ok(sysResearch.includes('追涨') && sysResearch.includes('低吸'), 'research 含追涨/低吸');
assert.ok(sysResearch.includes('反空话铁律'), 'research 仍含反空话铁律（未被破坏）');

// ── general 场景隔离，不被污染 ──
const sysGeneral = buildSystemPromptText('x', 'general');
assert.ok(!sysGeneral.includes('右侧交易战法纪律'), 'general 不得含战法纪律');
assert.ok(!sysGeneral.includes('追涨'), 'general 不被污染');

console.log('committee-discipline ok | research 带纪律底色 + general 隔离 + 反空话保留');
