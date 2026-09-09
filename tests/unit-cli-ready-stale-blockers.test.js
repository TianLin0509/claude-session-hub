'use strict';
/**
 * 就绪检测：已经被新画面盖掉的启动/忙碌文本，不能永远把 CLI 判成未就绪。
 *
 * 2026-09-08 合并位在真实链路上撞到的：Codex 明明已经显示输入框，Hub 却一直说未就绪，
 * 开题连着两次 `cli_not_ready`。根因是 PTY 是**追加**的字节流 —— 清屏只是一个控制序列，
 * 早先那句 `Booting MCP server` / `esc to interrupt` 仍然留在 buffer 里；
 * 只要它还落在末尾那段窗口内，就会被当成「现在正在启动/正在跑」。
 *
 * 夹具 `fixtures/codex-ready-sample.txt` 是**真机抓的** Codex 原始字节流
 * （tests/capture-codex-ready-sample.js 抓的），里面这两段和输入框标记同时存在。
 * 所以这不是编出来的场景，只是真实样本里它们恰好落在窗口外才侥幸放行。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../core/group-chat-cli-ready-detector.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-ready-sample.txt'), 'utf8');
let probeSeq = 0;
const freshSid = () => { const sid = `probe-${++probeSeq}`; D.cleanup(sid); return sid; };
// 就绪判定是「双门」：过了阻断词那道之后，还要连续静默 STABLE_MS 才算稳。
// 所以「不该被拦」的用例必须问两次，中间等过静默期 —— 生产里是轮询，等价。
const sleepSync = (ms) => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
};
function readyAfterSettle(sid, kind, buf) {
  D.isReady(sid, kind, buf);
  sleepSync(D.STABLE_MS + 300);
  return D.isReady(sid, kind, buf);
}

console.log('cli-ready · 过期的启动/忙碌文本');

test('真机样本里，启动文本和输入框标记本来就同时存在', () => {
  assert.ok(SAMPLE.lastIndexOf('Booting MCP server') > 0, '样本里有启动文本');
  assert.ok(SAMPLE.lastIndexOf('esc to interrupt') > 0, '样本里有忙碌文本');
  assert.ok(SAMPLE.lastIndexOf('Context ') > SAMPLE.lastIndexOf('esc to interrupt'),
    '输入框标记出现在它们之后 —— 也就是说那两段已经过期了');
});

test('阻断 启动文本离末尾近一点就永久判未就绪（真实样本的短缓冲变体）', () => {
  // 把样本中间截掉一段，模拟「启动之后 Codex 少打了几行」的真实情形：
  // 两段过期文本随之落进末尾窗口，输入框标记仍在它们之后。
  const cut = SAMPLE.slice(0, 3900) + SAMPLE.slice(5400);
  assert.ok(cut.lastIndexOf('esc to interrupt') > cut.length - 2000, '构造成功：过期文本落进了尾窗');
  assert.ok(cut.lastIndexOf('Context ') > cut.lastIndexOf('esc to interrupt'), '输入框标记仍在其后');
  assert.strictEqual(readyAfterSettle(freshSid(), 'codex', cut), true,
    '输入框标记比启动文本更新，就该认它已经就绪');
});

test('真的还在启动 / 真的在跑时，仍然判未就绪', () => {
  const booting = SAMPLE.slice(0, SAMPLE.lastIndexOf('Booting MCP server') + 40);
  assert.strictEqual(D.isReady(freshSid(), 'codex', booting), false, '启动文本是最新的 → 不许发');
  const busy = SAMPLE + 'thinking\r\n esc to interrupt ';
  assert.strictEqual(D.isReady(freshSid(), 'codex', busy), false, '忙碌文本是最新的 → 不许发');
  const modal = SAMPLE + '\r\nDo you trust the contents of this directory?';
  assert.strictEqual(D.isReady(freshSid(), 'codex', modal), false, '弹窗是最新的 → 不许发');
});

test('阻断词是最新信号时，问多少次都还是未就绪', () => {
  const busy = SAMPLE + 'thinking\r\n esc to interrupt ';
  assert.strictEqual(readyAfterSettle(freshSid(), 'codex', busy), false,
    '别因为屏幕不动了就把「正在跑」判成「就绪」');
});

test('kimi 的登录失效仍然拦得住（它的 marker 在阻断词之前）', () => {
  const kimi = 'context:'.padEnd(600, 'x') + '\r\nOAuth login expired\r\n';
  assert.strictEqual(D.isReady(freshSid(), 'kimi', kimi), false);
});

test('未注册的 kind 仍然默认就绪，不被这次改动波及', () => {
  assert.strictEqual(D.isReady(freshSid(), 'powershell', ''), true);
});

console.log(`\n${pass} passed`);
