'use strict';
// 2026-10-14: the host-shell and login-banner checks clean only a raw tail of
// the 1 MB terminal ring, with the whole-buffer clean as the fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi, cleanTail, detectHostShellTakeover, createAuthBannerMonitor } = require('../core/host-shell-detector');

function noisy(bytes, seed = 7) {
  let x = seed, out = '';
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x; };
  const pieces = ['\x1b[38;2;10;20;30m', '\x1b[0m', '\x1b[3C', '\x1b]0;title\x07', '\x1b[?25l', 'text ', '中文回答 ', '\r\n', '│ ', '\x1b(B'];
  while (out.length < bytes) out += pieces[rnd() % pieces.length];
  return out;
}

test('the cleaned tail equals the tail of the cleaned whole buffer', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const buffer = noisy(1024 * 1024 + seed * 37, seed);
    for (const chars of [500, 1200]) assert.equal(cleanTail(buffer, chars), stripAnsi(buffer).slice(-chars), `seed ${seed}`);
  }
  // A tail made almost entirely of control sequences falls back to the whole buffer.
  const dense = 'PS C:\\Users\\me> ' + '\x1b[0m'.repeat(20000);
  assert.equal(cleanTail(dense, 500), stripAnsi(dense).slice(-500));
});

test('prompt and login-banner detection keep their answers on a 1 MB ring', () => {
  const history = noisy(1024 * 1024);
  assert.equal(detectHostShellTakeover(history + '\r\nPS C:\\Users\\me> '), true);
  assert.equal(detectHostShellTakeover(history + '\r\n\x1b[32mthinking…\x1b[0m'), false);
  const monitor = createAuthBannerMonitor();
  assert.notEqual(monitor.tick(history + '\r\nPlease run /login', 1), 'none');
  assert.equal(createAuthBannerMonitor().tick(history, 1), 'none');
});
