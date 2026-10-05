'use strict';
// 快答的记忆来自助理沉淀的两份 Markdown：USER.md（偏好）与 MEMORY.md（长期事实），标题与说明行不进提示词。
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt } = require('../core/hub-assistant/fast-lane');
test('the fast lane prompt carries both USER.md and MEMORY.md without their headings', () => {
  const p = systemPrompt({ userPrefs: '# 田哥的偏好与习惯\n> 说明\n- 回答先给结论', memory: '# 长期记忆\n> 说明\n- 常用仿真平台是 SuperRAN' });
  assert.match(p, /回答先给结论/); assert.match(p, /田哥的长期记忆/); assert.match(p, /SuperRAN/);
  assert.doesNotMatch(p, /# 长期记忆|> 说明/);
  assert.doesNotMatch(systemPrompt({ userPrefs: '', memory: '# 长期记忆\n> 说明\n' }), /田哥的长期记忆/, '空记忆不加这一段');
});
