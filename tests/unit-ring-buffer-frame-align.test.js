'use strict';
// 终端显式恢复时的快照重建（历史问题由 ef31eb2 于 2026-07-26 暴露）。
//
// Renderer reload/丢失后会通过 hydrateTerminalFromSnapshot，用 SessionManager 的
// 环形缓冲原始 PTY 字节重放重建。
// 缓冲原为 16KB 且按字节尾切 —— 装不下 Codex/Kimi 一整帧带色彩的全屏重绘，
// 重建出来内容大面积缺失（实测视口非空行 30 → 2）。
//
// 两种"起点对齐"都试过并放弃，这里用测试把结论固定住，避免有人再走一遍：
//   - 对齐到最后一次 \x1b[2J：TUI 每帧都清屏，会把滚动回缓冲整个丢光
//   - 剥离开头的 CSI 残尾：与正文（数字开头）无法可靠区分，会吃掉真实内容

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SessionManager } = require('../core/session-manager.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function makeManager() {
  const mgr = Object.create(SessionManager.prototype);
  mgr.sessions = new Map();
  return mgr;
}

function seed(mgr, id, limit) {
  mgr.sessions.set(id, { ringBuffer: '', ringBufferLimit: limit });
  return () => mgr.sessions.get(id).ringBuffer;
}

console.log('Running ring buffer tests...');

test('the ring buffer holds a full coloured TUI frame', () => {
  const m = SRC.match(/const RING_BUFFER_BYTES = ([^;]+);/);
  assert.ok(m, 'RING_BUFFER_BYTES must be declared');
  // eslint-disable-next-line no-eval
  const value = eval(m[1]);
  // 16KB 实测保全率 56.8%（400 行只剩 227 行），256KB 起 100%，1MB 给带色输出留余量
  assert.ok(value >= 256 * 1024,
    `a reconstructed terminal rebuilds from this buffer; 16KB measured only 56.8% content `
    + `preservation on a 400-line session; got ${value} bytes`);
});

test('scrollback written before a screen clear is preserved', () => {
  const mgr = makeManager();
  const read = seed(mgr, 's', 5000);
  mgr._appendToRingBuffer('s', 'SCROLLBACK-LINE\r\n'.repeat(20));
  mgr._appendToRingBuffer('s', '\x1b[2J\x1b[H');
  mgr._appendToRingBuffer('s', 'HEADER\r\n\x1b[20;1H> input');
  const rb = read();
  assert.ok(rb.includes('SCROLLBACK-LINE'), 'history before the clear must stay');
  assert.ok(rb.includes('HEADER'), 'the newest frame must stay too');
});

test('no clear-based realignment is reintroduced', () => {
  assert.doesNotMatch(SRC, /lastClear/,
    'aligning to the last \\x1b[2J discards the whole scrollback for TUIs that repaint every frame');
  assert.doesNotMatch(SRC, /alignRingBufferToFrame\(/,
    'both realignment heuristics were measured to do more harm than good');
});

test('plain text that happens to start with digits is never eaten', () => {
  const mgr = makeManager();
  const read = seed(mgr, 's', 16);
  mgr._appendToRingBuffer('s', 'xxxxxxxxxxxxxxxxxxxx5 files changed');
  assert.ok(read().includes('5 files changed'),
    'a CSI-remnant heuristic would strip this; real content must survive');
});

test('surrogate-pair trimming still guards the cut point', () => {
  const mgr = makeManager();
  const read = seed(mgr, 's', 12);
  mgr._appendToRingBuffer('s', 'AAAA😀BBBB😀CCCC');
  const first = read().charCodeAt(0);
  assert.ok(!(first >= 0xDC00 && first <= 0xDFFF), 'must not start with a lone low surrogate');
});

test('buffers under the limit are returned untouched', () => {
  const mgr = makeManager();
  const read = seed(mgr, 's', 1000);
  const payload = '\x1b[2Jhello\r\nworld';
  mgr._appendToRingBuffer('s', payload);
  assert.strictEqual(read(), payload, 'no truncation means no rewriting');
});

if (!process.exitCode) console.log('All ring buffer tests passed.');
