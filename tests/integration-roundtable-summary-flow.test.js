'use strict';
// Integration test：方案 F 摘要按钮全流程组件协同
//
// 不模拟完整 IPC（涉及 sessionManager/PTY/sendToRenderer 等 main.js 大量依赖），
// 但验证 4 个核心组件协同：
//   1. buildBriefSummaryPrompt 输出含五元组结构 + timeline 路径
//   2. orchestrator beginTurn('summary-brief') + completeTurn 接受 isSummary meta
//   3. timeline.writeTurn 识别 summary-brief mode → 写"摘要 by ... · 五元组"标题
//   4. computeLastTurnInjection 对 summary-brief 上一轮 → isSummaryInjection=true 全注入
//      下游 buildFanoutPrompt 渲染摘要注入

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { RoundtableOrchestrator } = require('../core/roundtable-orchestrator.js');
const tl = require('../core/roundtable-timeline.js');
const { computeLastTurnInjection } = require('../core/roundtable-injection.js');
const scenes = require('../core/roundtable-scenes.js');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'rt-summary-flow-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const labelMap = { sid_a: 'Claude', sid_b: 'Gemini', sid_c: 'Codex' };
const labelOf = (sid) => labelMap[sid] || sid;

// === 1. buildBriefSummaryPrompt 输出含五元组 + timeline footer ===
function testBriefSummaryPromptOutput() {
  const orch = new RoundtableOrchestrator(tmpDir(), 'm-test', scenes.getScene('general'));
  const prompt = orch.buildBriefSummaryPrompt(
    5, 'sid_a', labelOf,
    { fromTurn: 1, toTurn: 4 },
    'C:\\proj\\.arena\\timeline-m-test.md'
  );
  // 标题
  assert.ok(prompt.includes('第 5 轮 · 摘要轮 · by Claude'), 'title with summarizer label');
  // 任务说明
  assert.ok(prompt.includes('五元组'), 'mentions 五元组');
  // 五段格式
  assert.ok(prompt.includes('1. **目标**'), 'slot 1 目标');
  assert.ok(prompt.includes('2. **关键事实**'), 'slot 2 关键事实');
  assert.ok(prompt.includes('3. **关键分歧**'), 'slot 3 关键分歧');
  assert.ok(prompt.includes('4. **当前结论**'), 'slot 4 当前结论');
  assert.ok(prompt.includes('5. **下一步**'), 'slot 5 下一步');
  // 浓缩范围
  assert.ok(prompt.includes('第 1 - 4 轮'), 'summarize range');
  // 约束
  assert.ok(prompt.includes('不超过 500 字'), '500 字约束');
  assert.ok(prompt.includes('第一人称'), '第一人称约束');
  // timeline footer
  assert.ok(prompt.includes('C:\\proj\\.arena\\timeline-m-test.md'), 'timeline path footer');
  console.log('  ✓ testBriefSummaryPromptOutput');
}

// === 2. orchestrator 接受 'summary-brief' mode + isSummary meta 持久化 ===
function testOrchestratorAcceptsSummaryBriefMode() {
  const dir = tmpDir();
  const orch = new RoundtableOrchestrator(dir, 'm-int', scenes.getScene('general'));

  // 跑一轮 fanout 准备 summarizer 上下文
  orch.beginTurn('fanout');
  orch.completeTurn(1, 'fanout', '问题', { sid_a: 'A 回答' }, {}, { sid_a: 'completed' });

  // 触发摘要轮
  const tn = orch.beginTurn('summary-brief');
  assert.strictEqual(tn, 2, 'summary turn num = 2');
  assert.strictEqual(orch.state.currentMode, 'summary-brief');

  const rec = orch.completeTurn(tn, 'summary-brief', '', { sid_a: '1. 目标:xxx\n2. 关键事实:yyy' },
    { isSummary: true, summarizers: ['sid_a'], summarizeRange: { fromTurn: 1, toTurn: 1 }, dispatchMode: 'all' },
    { sid_a: 'completed' });
  assert.strictEqual(rec.mode, 'summary-brief');
  assert.strictEqual(rec.isSummary, true, 'meta.isSummary persisted');
  assert.deepStrictEqual(rec.summarizers, ['sid_a']);
  console.log('  ✓ testOrchestratorAcceptsSummaryBriefMode');
}

// === 3. timeline.writeTurn 识别 summary-brief → "摘要 by ... · 五元组" 标题 ===
function testTimelineWritesSummaryTurnHeader() {
  const cwd = tmpDir();
  const mid = 'm-tl';

  // 第一轮普通
  tl.writeTurn(mid, {
    n: 1, mode: 'fanout', userInput: '问题',
    by: { sid_a: '答 A' }, timestamp: Date.now(), dispatchMode: 'all',
  }, '通用圆桌', cwd, null, labelOf);

  // 第二轮摘要
  tl.writeTurn(mid, {
    n: 2, mode: 'summary-brief', userInput: '',
    by: { sid_a: '1. 目标:...\n2. 关键事实:...' },
    timestamp: Date.now(), dispatchMode: 'pilot',
    summarizers: ['sid_a'],
  }, '通用圆桌', cwd, null, labelOf);

  const content = tl.readFull(mid, cwd, null);
  assert.ok(content.includes('## 第 1 轮 · fanout · all'));
  assert.ok(content.includes('## 第 2 轮 · 摘要 by Claude（五元组）'),
    'summary turn title format');
  assert.ok(content.includes('触发：用户点「摘要」按钮'), 'summary trigger note (中文冒号)');
  console.log('  ✓ testTimelineWritesSummaryTurnHeader');
}

// === 4. computeLastTurnInjection 对 summary-brief → isSummaryInjection=true ===
function testInjectionRecognizesSummaryBriefAsSpecial() {
  const lastTurn = {
    n: 5, mode: 'summary-brief', dispatchMode: 'pilot',
    by: { sid_a: '1. 目标:...\n2. 关键事实:...' },
  };
  const r = computeLastTurnInjection(lastTurn, ['sid_b', 'sid_c'], labelOf, () => null);
  // 摘要轮注入给所有当前发言者（不论身份是否同组）
  assert.ok(r.sid_b);
  assert.ok(r.sid_c);
  assert.strictEqual(r.sid_b.isSummaryInjection, true, 'sid_b receives summary injection');
  assert.strictEqual(r.sid_c.isSummaryInjection, true, 'sid_c receives summary injection');
  // 同样的摘要内容（不个性化排除）
  assert.strictEqual(r.sid_b.speakers.length, 1);
  assert.strictEqual(r.sid_b.speakers[0].text, '1. 目标:...\n2. 关键事实:...');
  assert.strictEqual(r.sid_c.speakers[0].text, '1. 目标:...\n2. 关键事实:...');
  console.log('  ✓ testInjectionRecognizesSummaryBriefAsSpecial');
}

// === 5. 端到端：摘要 → fanout 注入摘要 → AI 收到的 prompt 含摘要 by 标题 ===
function testEndToEndSummaryToFanoutInjection() {
  const dir = tmpDir();
  const orch = new RoundtableOrchestrator(dir, 'm-e2e', scenes.getScene('general'));

  // 主驾深聊（pilot 3 轮）
  for (let i = 1; i <= 3; i++) {
    orch.beginTurn('fanout');
    orch.completeTurn(i, 'fanout', `问题 ${i}`, { sid_a: `主驾第${i}轮` },
      { dispatchMode: 'pilot' }, { sid_a: 'completed' });
  }
  // 第 4 轮摘要
  orch.beginTurn('summary-brief');
  orch.completeTurn(4, 'summary-brief', '',
    { sid_a: '1. 目标:深挖兆易创新\n2. 关键事实:113.2 / PE 38\n3. 关键分歧:估值\n4. 当前结论:中性 65%\n5. 下一步:副驾审查' },
    { isSummary: true, summarizers: ['sid_a'], dispatchMode: 'pilot' },
    { sid_a: 'completed' });

  // 第 5 轮副驾审查（observer 模式 — 副驾两家发言）
  const lastTurn = orch.getLastTurn();
  assert.strictEqual(lastTurn.mode, 'summary-brief');

  const inj = computeLastTurnInjection(lastTurn, ['sid_b', 'sid_c'], labelOf, () => null);
  assert.ok(inj.sid_b);
  assert.strictEqual(inj.sid_b.isSummaryInjection, true);

  // 副驾 b 的 prompt
  const dispatchSpec = { mode: 'observer', selfRole: 'observer', sameStageLabels: ['Codex'], pilotLabel: 'Claude' };
  const prompt = orch.buildFanoutPrompt(5, '你怎么看主驾的判断？', null, dispatchSpec, inj.sid_b, 'C:\\fake\\timeline.md');

  assert.ok(prompt.includes('## 上一轮（第 4 轮 · 摘要 by Claude · 五元组）'),
    'fanout prompt should contain summary injection title');
  assert.ok(prompt.includes('1. 目标:深挖兆易创新'), 'summary content injected');
  assert.ok(prompt.includes('副驾发言（主驾 Claude 本轮静音'), 'dispatch context observer');
  assert.ok(prompt.includes('完整历史:C:\\fake\\timeline.md'), 'timeline footer');
  console.log('  ✓ testEndToEndSummaryToFanoutInjection');
}

console.log('Running integration roundtable-summary-flow tests...');
let failed = 0;
const tests = [
  testBriefSummaryPromptOutput,
  testOrchestratorAcceptsSummaryBriefMode,
  testTimelineWritesSummaryTurnHeader,
  testInjectionRecognizesSummaryBriefAsSpecial,
  testEndToEndSummaryToFanoutInjection,
];
for (const t of tests) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    if (e.stack) console.error('    ', e.stack.split('\n').slice(1, 4).join('\n     '));
    failed++;
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
