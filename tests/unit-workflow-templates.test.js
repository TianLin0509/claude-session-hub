'use strict';

const assert = require('assert');
const WT = require('../renderer/workflow-templates.js');

let pass = 0;
function test(name, fn) {
  fn(); pass++;
  console.log('  ✓ ' + name);
}

const members = [
  { memberId: 'm1', kind: 'codex', title: 'Codex' },
  { memberId: 'm2', kind: 'claude', title: 'Claude' },
  { memberId: 'm3', kind: 'deepseek', title: 'DeepSeek' },
];

console.log('workflow-templates');

test('内置 4 个语义模板', () => {
  assert.strictEqual(WT.TEMPLATES.length, 4);
});

test('串行工作流提供 6 个任务预设按钮', () => {
  assert.strictEqual(WT.TASK_PRESETS.length, 6);
  assert.deepStrictEqual(WT.TASK_PRESETS.map(item => item.name),
    ['续跑', '审查', '功能', '修 Bug', '调研', '开发任务']);
});

test('开发任务是工作位↔合并位的两步循环，两步必须落到不同成员', () => {
  const c = WT.createTemplateConfig('dev-task', members);
  assert(c && c.steps.length === 2 && c.stepConfigs.length === 2);
  assert.deepStrictEqual(c.steps[0], ['m1']);
  assert.deepStrictEqual(c.steps[1], ['m2']);       // 落到同一个成员就成了自审自合
  assert(c.loop.enabled === true && c.loop.maxRounds === 3);
  assert(c.stepConfigs[0].prompt.includes('.agents/AUTHOR.md'));
  assert(c.stepConfigs[1].prompt.includes('.agents/MERGER.md'));
  assert(c.stepConfigs[1].prompt.includes('RESULT: PASS 或 FAIL'));
  assert(!/动过就要求先 rebase/.test(c.stepConfigs[1].prompt), '主干前进不能无条件制造 rebase 返工');
  assert(/冲突或集成测试失败/.test(c.stepConfigs[1].prompt), '只有真实集成失败才要求工作位修复');
});

test('开发预设必须通用：prompt 里不出现项目名或绝对路径', () => {
  // 这是「Hub 底座通用、项目差异沉淀在项目自己仓库里」的守门测试。
  // 一旦有人往 prompt 里写死 C:\... 或某个项目名，这条会红。
  const c = WT.createTemplateConfig('dev-task', members);
  for (const sc of c.stepConfigs) {
    assert(!/[A-Za-z]:\\/.test(sc.prompt), '不许出现 Windows 绝对路径：' + sc.prompt);
    assert(!/SuperRAN|superran/.test(sc.prompt), '不许写死项目名：' + sc.prompt);
    assert(sc.prompt.includes('.agents/'), '必须指向仓库内相对路径的合同');
  }
});

test('开发预设带按步超时，且能穿过归一化（引擎才读得到）', () => {
  // loop-engine: Math.max(60_000, Math.min(30*60_000, stepConfigs[i].timeoutMs || 10*60_000))
  // normalizeStepConfigs 以前只留 name/prompt，模板填的 timeoutMs 会被吃掉，引擎永远读到默认值。
  const c = WT.createTemplateConfig('dev-task', members);
  assert.strictEqual(c.stepConfigs[0].timeoutMs, 30 * 60 * 1000);
  assert.strictEqual(c.stepConfigs[1].timeoutMs, 25 * 60 * 1000);

  const norm = WT.normalizeStepConfigs(c.steps, c.stepConfigs);
  assert(norm.every((s, i) => s.timeoutMs === c.stepConfigs[i].timeoutMs),
    'timeoutMs 必须在归一化后保留');
});

test('非法 timeoutMs 不写进归一化结果，避免污染引擎的 clamp', () => {
  const bad = WT.normalizeStepConfigs([['m1'], ['m1'], ['m1']],
    [{ timeoutMs: 'abc' }, { timeoutMs: -5 }, { timeoutMs: 0 }]);
  assert(bad.every(s => !('timeoutMs' in s)));
});

test('开发预设只指向合同文件，不在 Hub 里复制流程规则', () => {
  const c = WT.createTemplateConfig('dev-task', members);
  for (const sc of c.stepConfigs) {
    assert(sc.prompt.includes('.agents'), 'dev-task 的 prompt 应指向 .agents 合同');
  }
  // prompt 里不该出现具体的流程规则，否则改流程就得回来改 Hub
  assert(!/worktree add|git push|pytest/.test(c.stepConfigs.map(s => s.prompt).join('\n')),
    '具体命令应留在合同 .md 里，不要复制进 Hub');
});

test('根因修复预设联动为诊断、修复、回归三步', () => {
  const c = WT.createTemplateConfig('task-root-cause-fix', members);
  assert(c && c.steps.length === 3 && c.stepConfigs.length === 3);
  assert.deepStrictEqual(c.steps[0], ['m1', 'm2', 'm3']);
  assert(/诊断/.test(c.stepConfigs[0].name));
  assert(/根因/.test(c.stepConfigs[1].prompt));
  assert(/回归/.test(c.stepConfigs[2].name));
});

test('审查预设使用不同步骤职责而非固定模型人格', () => {
  const c = WT.createTemplateConfig('task-review-verify', members);
  assert.deepStrictEqual(c.stepConfigs.map(item => item.name), ['缺陷审查', '回归审查', '验证缺口', '验收裁决']);
  assert(c.stepConfigs.every(item => !/你是|专家|首席/.test(item.prompt)));
  assert(c.stepConfigs[3].prompt.includes('RESULT: PASS 或 FAIL'));
});

test('审视→方案→落地→终审生成 4 个可编辑步骤', () => {
  const c = WT.createTemplateConfig('review-plan-build-finalize', members);
  assert(c && c.steps.length === 4 && c.stepConfigs.length === 4);
  assert.deepStrictEqual(c.steps[0], ['m1', 'm2', 'm3']);
  assert(/终审/.test(c.stepConfigs[3].name));
  assert.strictEqual(c.loop.enabled, false);
});

test('快速闭环固定为执行 + 并行评审，默认最多 3 次且无 polish', () => {
  const c = WT.createTemplateConfig('fast-review-loop', members);
  assert.deepStrictEqual(c.steps, [['m1'], ['m2', 'm3']]);
  assert.strictEqual(c.loop.enabled, true);
  assert.strictEqual(c.loop.maxRounds, 3);
  assert.strictEqual(c.loop.polish, false);
});

test('成员不足时拒绝需要多 AI 的模板', () => {
  assert.strictEqual(WT.createTemplateConfig('fast-review-loop', members.slice(0, 1)), null);
});

test('stepConfigs 与自定义步骤自动对齐，不锁模板', () => {
  const normalized = WT.normalizeStepConfigs([['m1'], ['m2'], ['m3']], [{ name: 'A', prompt: 'P' }]);
  assert.deepStrictEqual(normalized, [
    { name: 'A', prompt: 'P' },
    { name: '', prompt: '' },
    { name: '', prompt: '' },
  ]);
});

test('逐步 prompt 注入总目标、步骤名和职责', () => {
  const prompt = WT.buildSerialStepPrompt('修复登录', { name: '复核', prompt: '先复现再修复' }, 1, 3);
  assert(/修复登录/.test(prompt) && /复核/.test(prompt) && /先复现再修复/.test(prompt));
  assert(/前序步骤/.test(prompt));
});

test('空 step prompt 完全兼容旧串行行为', () => {
  assert.strictEqual(WT.buildSerialStepPrompt('原始问题', { name: 'A', prompt: '' }, 0, 2), '原始问题');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
