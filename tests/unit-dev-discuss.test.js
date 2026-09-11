'use strict';
/**
 * 开发群聊「先讨论，再开工」的阶段模块。
 * 守三件事：阶段判断的兜底方向、讨论块的内容约束、任务说明的抠取。
 */
const assert = require('assert');
const DD = require('../core/dev-discuss.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-discuss');

test('阶段缺省是开工：老群聊没有这个字段，行为必须和以前一模一样', () => {
  assert.strictEqual(DD.phaseOf(null), 'build');
  assert.strictEqual(DD.phaseOf({}), 'build');
  assert.strictEqual(DD.phaseOf({ devPhase: 'whatever' }), 'build');
  assert.strictEqual(DD.phaseOf({ devPhase: 'discuss' }), 'discuss');
});

test('只有开发场景的群聊才认讨论阶段', () => {
  const sw = { devPhase: 'discuss', steps: [['m1'], ['m2']] };
  assert.strictEqual(DD.isDiscussing({ scene: 'dev', groupChat: true, serialWorkflow: sw }), true);
  assert.strictEqual(DD.isDiscussing({ scene: 'general', groupChat: true, serialWorkflow: sw }), false, '通用群聊即使误带字段也不该被当成开发讨论');
  assert.strictEqual(DD.isDiscussing({ scene: 'dev', groupChat: false, serialWorkflow: sw }), false);
  assert.strictEqual(DD.isDiscussing({ scene: 'dev', groupChat: true, serialWorkflow: { devPhase: 'build' } }), false);
});

test('席位角色按工作流步骤位置：第一步工作位，第二步合并位，其余无角色', () => {
  const sw = { steps: [['m1'], ['m2']] };
  assert.strictEqual(DD.devRoleOf(sw, 'm1'), 'worker');
  assert.strictEqual(DD.devRoleOf(sw, 'm2'), 'merger');
  assert.strictEqual(DD.devRoleOf(sw, 'm3'), '');
  assert.strictEqual(DD.devRoleOf(null, 'm1'), '');
});

test('讨论块：禁改代码、分工明确、指向合同、带定位说明', () => {
  const worker = DD.buildDiscussBlock({ role: 'worker', locator: '【先定位项目根】看项目库' });
  assert(worker.startsWith(DD.DISCUSS_MARKER), '开头必须是固定标记，方便复盘时一眼认出');
  assert(/禁止修改仓库里的任何文件/.test(worker) && /禁止建 worktree/.test(worker), '讨论阶段的核心约束是不动代码');
  assert(/AUTHOR\.md/.test(worker) && /方案提出者/.test(worker), '工作位要先读自己的合同再提方案');
  assert(/【先定位项目根】看项目库/.test(worker), '开在工作根时讨论阶段同样要先找到仓库');
  const merger = DD.buildDiscussBlock({ role: 'merger' });
  assert(/MERGER\.md/.test(merger) && /反证/.test(merger) && /不要迎合/.test(merger), '合并位在讨论阶段当反方，对冲它后面审查时被自己观点锚定');
  assert(!/先定位项目根/.test(merger), '没给定位说明就不带');
  const none = DD.buildDiscussBlock({ role: '' });
  assert(!/AUTHOR\.md|MERGER\.md/.test(none), '不在两步里的成员只给通用约束');
  for (const block of [worker, merger, none]) {
    assert(block.includes(DD.TASK_SPEC_HEADING), '要告诉 AI 收敛时用哪个标题，否则「开工」预填抠不到');
    assert(!/[A-Za-z]:\\/.test(block.replace('【先定位项目根】看项目库', '')), '底座通用：讨论块里不许写死路径');
  }
});

test('讨论块只在讨论阶段追加，且和英雄块一样接在 prompt 末尾', () => {
  const discussing = { scene: 'dev', groupChat: true, serialWorkflow: { devPhase: 'discuss', steps: [['m1'], ['m2']], projectLocator: '【先定位项目根】X' } };
  const block = DD.discussBlockFor(discussing, 'm2');
  assert(/MERGER\.md/.test(block) && !/【先定位项目根】X/.test(block), '旧项目库快照不再注入讨论');
  assert.strictEqual(DD.discussBlockFor({ ...discussing, serialWorkflow: { ...discussing.serialWorkflow, devPhase: 'build' } }, 'm2'), '', '开工后一个字不加');
  assert.strictEqual(DD.appendDiscussBlock('base', ''), 'base');
  assert.strictEqual(DD.appendDiscussBlock('base', 'extra'), 'base\n\nextra');
  assert.strictEqual(DD.appendDiscussBlock('', 'extra'), 'extra');
});

test('从回复里抠任务说明：从「## 任务说明」起到结尾；没有就空', () => {
  const reply = '我先说两句铺垫。\n\n## 任务说明\n目标：给建群弹窗加起手方式\n非目标：不动合同\n验收标准：单测过\n风险与回退：无';
  const spec = DD.extractTaskSpec(reply);
  assert(spec.startsWith('## 任务说明'));
  assert(/风险与回退：无$/.test(spec));
  assert.strictEqual(DD.extractTaskSpec('随便聊聊，任务说明这四个字出现在句子里不算'), '');
  assert.strictEqual(DD.extractTaskSpec('##任务说明\n目标：紧凑写法也认'), '##任务说明\n目标：紧凑写法也认');
});

test('取最近一份任务说明，且只看 AI 的发言', () => {
  const messages = [
    { role: 'assistant', content: '## 任务说明\n目标：旧的' },
    { role: 'user', content: '## 任务说明\n目标：用户自己贴的不算，那是收敛请求的回显' },
    { role: 'assistant', content: '## 任务说明\n目标：新的' },
    { role: 'assistant', content: '同意，没有补充。' },
  ];
  assert(/目标：新的/.test(DD.latestTaskSpec(messages)));
  assert.strictEqual(DD.latestTaskSpec([]), '');
  assert.strictEqual(DD.latestTaskSpec([{ role: 'user', content: '## 任务说明\nx' }]), '');
});

test('「收敛」请求文本告诉工作位用固定标题，给合并位留补充空间', () => {
  assert(DD.CONVERGE_REQUEST.includes(DD.TASK_SPEC_HEADING));
  assert(/合并位/.test(DD.CONVERGE_REQUEST) && /待拍板/.test(DD.CONVERGE_REQUEST), '有分歧要留给维护者拍板，不许 AI 替他定');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
