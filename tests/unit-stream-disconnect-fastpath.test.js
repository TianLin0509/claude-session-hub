'use strict';
// 断连检测的快速路径（2026-10-11）：先用关键词挡掉、拼接后的尾巴不重复清洗。
// 结果必须和逐块完整清洗 + 三个模式全跑的做法一致。
const assert = require('assert');
const { appendStreamDisconnectChunk, detectStreamDisconnect, stripTerminalControls } = require('../core/stream-disconnect');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }
const E = String.fromCharCode(27);

test('三类断连文本都能认出，带颜色控制序列也行', () => {
  for (const line of ['■ stream disconnected before completion: error sending request',
    'error: unexpected status from response.completed ECONNRESET',
    `${E}[31mAPI Error: Connection error.${E}[0m`]) {
    assert.ok(detectStreamDisconnect(line), line);
  }
  assert.strictEqual(detectStreamDisconnect('普通输出：调度器按信道质量分配资源块'), null);
});

test('控制序列被拆在两块之间、关键词在下一块，仍然认得出', () => {
  let t = appendStreamDisconnectChunk('', `hello\n${E}[3`);
  t = appendStreamDisconnectChunk(t.tail, '1m■ stream disconnected before completion\n');
  assert.ok(t.issue && /stream disconnected/.test(t.issue.message));
});

test('关键词被拆在两块之间也认得出', () => {
  let t = appendStreamDisconnectChunk('', 'output\n■ str');
  assert.strictEqual(t.issue, null);
  t = appendStreamDisconnectChunk(t.tail, 'eam disconnected before completion\n');
  assert.ok(t.issue);
});

test('随机 TUI 流：快速路径与「拼接后整体再清洗再匹配」逐块结果一致', () => {
  const pieces = ['物理层', `${E}[38;2;1;2;3m`, '\r\n', 'stream ', 'disconnected', ' before completion', `${E}[`, '2K', 'API Error: ', 'Connection reset',
    'error: x response.completed', ' ECONNRESET', '\n', '⠋ 生成中', 'fatal: network unreachable', `${E}]0;title\x07`, 'HARQ 负责重传合并'];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let tail = '';
  for (let i = 0; i < 4000; i++) {
    const chunk = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pieces[Math.floor(rnd() * pieces.length)]).join('');
    const fast = appendStreamDisconnectChunk(tail, chunk);
    const combined = (tail + stripTerminalControls(chunk)).slice(-2400);
    const slow = detectStreamDisconnect(combined);
    assert.deepStrictEqual(fast.issue, slow, `chunk ${i}`);
    tail = fast.tail;
  }
});

console.log(`unit-stream-disconnect-fastpath: ${passed} passed`);
