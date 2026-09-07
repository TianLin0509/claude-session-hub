'use strict';
/**
 * 临时职责帽默认折叠（2026-09-07 用户要求：右侧那一整块默认不要出现）。
 *
 * 为什么用源码断言：这块面板是 meeting-room.js 里的一个字符串模板，没有可 require 的出口，
 * 而它坏掉的方式是「不报错、只是又变回展开」——单跑任何模块的单测都抓不到。
 *
 * 守三条：
 *   1. 没有 localStorage 记录时判定为折叠（默认折叠，不是默认展开）；
 *   2. 折叠时**不渲染**正文，而不是 display:none —— 后者那八个 select 仍在 DOM 里，
 *      Tab 键照样走进去，侧栏高度问题也会以别的形式回来；
 *   3. 标题行可点，点了写回 localStorage 再重绘（用户的显式选择要被记住）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8');
const room = read('renderer/meeting-room.js');
const css = read('renderer/styles/meeting-room-chat-flow.css');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('duty-hats-default-collapsed');

test('没有用户记录时默认折叠', () => {
  assert(/_DUTY_HATS_STATE_KEY = 'mr-duty-hats-state'/.test(room), '折叠状态要有自己的 localStorage 键');
  const fn = room.slice(room.indexOf('function _getDutyHatsCollapsed'), room.indexOf('function _setDutyHatsCollapsed'));
  assert(/state !== 'expanded'/.test(fn), "默认必须是折叠：只有显式记过 'expanded' 才展开");
  assert(/catch \{ return true; \}/.test(fn), 'localStorage 读不到时也当折叠，不能回落成展开');
});

test('折叠时正文根本不渲染，不是藏起来', () => {
  const render = room.slice(room.indexOf('function _renderDutyHatPanel'), room.indexOf('function _buildDutyHatPrompt'));
  assert(/const collapsed = _getDutyHatsCollapsed\(\);/.test(render), '渲染时要读折叠状态');
  assert(/const body = collapsed \? '' :/.test(render), '折叠时正文必须是空串，而不是加个 hidden 类');
  assert(/mr-duty-hat-list/.test(render) && render.indexOf('const body') < render.indexOf('mr-duty-hat-list'),
    '八行下拉必须落在 body 里，否则折叠也拦不住它');
});

test('标题行可点、会记住选择、点完重绘', () => {
  const render = room.slice(room.indexOf('function _renderDutyHatPanel'), room.indexOf('function _buildDutyHatPrompt'));
  assert(/data-duty-hats-toggle="1"/.test(render), '标题行要带 toggle 钩子');
  assert(/aria-expanded="\$\{collapsed \? 'false' : 'true'\}"/.test(render), '折叠态要对读屏可见');
  const handler = room.slice(room.indexOf("_closestInPanel(ev.target, '[data-duty-hats-toggle]'"));
  assert(/_setDutyHatsCollapsed\(!_getDutyHatsCollapsed\(\)\)/.test(handler.slice(0, 400)), '点击要翻转并写回');
  assert(/refreshGroupChatPanel/.test(handler.slice(0, 400)), '写回之后要重绘，否则点了没反应');
});

test('样式跟上：标题行是按钮，得有指针光标和插入符', () => {
  const block = css.slice(css.indexOf('.mr-duty-hats-head {'), css.indexOf('.mr-duty-hats-count {'));
  assert(/cursor: pointer/.test(block), '可点的东西要有 pointer，否则用户不知道能点');
  assert(/\.mr-duty-hats-caret/.test(css), '折叠/展开要有可见的三角标');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
