'use strict';

const assert = require('assert');
const TaskPresets = require('../renderer/task-presets.js');

let pass = 0;
function test(name, fn) {
  fn();
  pass += 1;
  console.log('  ✓ ' + name);
}

console.log('task-presets');

test('内置五个普通 Session 任务预设且 id 唯一', () => {
  assert.strictEqual(TaskPresets.PRESETS.length, 5);
  assert.strictEqual(new Set(TaskPresets.PRESETS.map(item => item.id)).size, 5);
});

test('未知预设保持用户原文完全不变', () => {
  const original = '继续  保留双空格\n第二行';
  assert.strictEqual(TaskPresets.composePrompt(original, 'missing'), original);
});

test('发送时才把任务约束追加到用户原文之后', () => {
  const original = '修复登录失败';
  const composed = TaskPresets.composePrompt(original, 'root-cause-fix');
  assert(composed.startsWith(original + '\n\n---\n'));
  assert(composed.includes('【任务模式：根因修复】'));
  assert(composed.includes('复现 → 日志与证据 → 调用链'));
});

test('用户可编辑约束，空约束不会污染原文', () => {
  assert.strictEqual(TaskPresets.composePrompt('原文', 'safe-resume', '  '), '原文');
  assert.strictEqual(
    TaskPresets.composePrompt('原文', 'safe-resume', '只做下一步'),
    '原文\n\n---\n【任务模式：安全续跑】\n只做下一步',
  );
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
