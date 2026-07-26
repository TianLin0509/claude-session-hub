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

test('串行工作流提供 5 个任务预设按钮', () => {
  assert.strictEqual(WT.TASK_PRESETS.length, 5);
  assert.deepStrictEqual(WT.TASK_PRESETS.map(item => item.name), ['续跑', '审查', '功能', '修 Bug', '调研']);
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
