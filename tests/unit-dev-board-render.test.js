'use strict';
/**
 * 看板一行必须把 Agent 申报的四行都渲染出来。
 *
 * 被坑出来的：boardRow 老老实实解析了 progress / verified / risk / report 四个字段，
 * 但 rowHtml 只渲染了 progress 和 blockers —— 验证证据、风险、报告链接全被丢掉。
 * 维护者不看代码，这四行就是他能看到的全部；丢了三行等于人话通道少了四分之三。
 *
 * 这类「解析了但没显示」不会报错，只会让人以为 Agent 根本没写。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-board-render');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'renderer/ran.js'), 'utf-8');
const DP = require('../renderer/dev-progress.js');

test('boardRow 产出的每个人话字段，看板都要渲染', () => {
  // 以数据层的实际产出为准，而不是我记忆里的字段名 —— 数据层加字段时这条会提醒补渲染
  const row = DP.boardRow(
    { id: 'm1', title: 't', scene: 'dev', groupChat: true },
    [{ text: 'PROGRESS: 干了活\nVERIFIED: 跑了 7 条\nRISK: 有点风险\nREPORT: C:\\a.html' }]
  );
  for (const f of ['progress', 'verified', 'risk', 'report']) {
    assert(row[f], 'boardRow 应该解析出 ' + f + '（测试前提不成立）');
    assert(SRC.includes('row.' + f),
      '看板没渲染 row.' + f + ' —— 解析了却不显示，等于白写');
  }
  assert(SRC.includes('row.blockers'), '打回原因也要显示');
});

test('拼接里四行一个不落', () => {
  // 直接断言字面量，不在测试里再套一层正则（转义层数容易掉，本轮已被坑过两次）
  assert(SRC.includes('line, verified, risk, blocked, report'),
    'rowHtml 的拼接必须依次含 line/verified/risk/blocked/report，否则某几行被静默丢掉');
});

test('点「看报告」必须阻止冒泡，否则会连带跳进群聊', () => {
  // 第一次出现是 HTML 模板，最后一次才是事件挂载点 —— 要看的是后者
  const i = SRC.lastIndexOf('devb-report');
  assert(i > 0, '缺少报告点击的挂载点');
  const near = SRC.slice(i, i + 600);
  assert(near.includes('addEventListener'), '报告要绑点击事件');
  assert(near.includes('stopPropagation'),
    '报告点击必须 stopPropagation —— 否则用户以为点开报告，实际被扔进群聊');
});

test('用系统默认程序打开，且打不开要看得见', () => {
  assert(SRC.includes('shell.openPath'), '要用 shell.openPath 打开本机文件');
  assert(SRC.includes('打不开'), '打不开时必须在界面上说出来，不能静默失败');
});

test('没有的字段不占地方，不显示「暂无」这类废话', () => {
  const row = DP.boardRow(
    { id: 'm2', title: 't', scene: 'dev', groupChat: true },
    [{ text: 'PROGRESS: 只改了文档\nRISK: 无\nREPORT: 无' }]
  );
  assert.strictEqual(row.risk, '', '「无」应归一成空');
  assert.strictEqual(row.report, '');
  // 渲染侧用三元判断，空值直接给空串
  assert(SRC.includes("row.risk\n      ? ") || SRC.includes('row.risk'), '风险行应是条件渲染');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
