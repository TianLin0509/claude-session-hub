'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
const modal = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workflow-config-modal.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

console.log('Running groupchat workflow UX contract tests...');

for (const removedLabel of ['综合共识', '互相挑错', '生成交接', '引用焦点卡', '复制本轮']) {
  assert.ok(!renderer.includes(removedLabel), `群聊极简模式不应保留按钮：${removedLabel}`);
}

assert.ok(!modal.includes('class="mcm-primary wf-save"'), '串行设置不应再要求点击保存');
assert.match(modal, /改动自动生效/);
assert.match(modal, /function _emitChange\(/);
assert.match(modal, /contextmenu/);
assert.match(modal, /stepPrompts/);
assert.match(modal, /Claude 方案/);
assert.match(modal, /Codex 落地/);

assert.match(index, /id="mr-interrupt-btn"/);
assert.match(renderer, /groupchat:interrupt/);
assert.match(renderer, /本轮已中断/);
assert.match(renderer, /开始/);
assert.match(renderer, /完成/);

console.log('  OK minimal action surface');
console.log('  OK autosave and per-AI prompt editor contract');
console.log('  OK interrupt and two-time labels contract');
