'use strict';
// PTY 顶部大片空白（Codex / Claude 都出现过，用户 2026-07-27 多次反馈）。
// 排查发现两条置底路径互补却都漏掉了"Claude 会话被 resize"这一格：
//   showTerminal        pinOnShow = !isCodexSession && focus   → 只在"显示"时置底，且排除 Codex
//   fitAndResizeTerminal shouldAutoPinCodexTerminal 写死 isCodexKind → 只在"fit"后置底，且只认 Codex
// 于是终端行数一变，xterm 重排后视口可能停在旧位置、正文上方留白，且不会自愈。
// 这里锁住与 CLI 无关的通用规则：fit 前贴底 ⇒ fit 后仍贴底。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

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

function fitBody() {
  const start = SRC.indexOf('function fitAndResizeTerminal(');
  assert.ok(start > 0, 'fitAndResizeTerminal must exist');
  const end = SRC.indexOf('\nfunction ', start + 10);
  return SRC.slice(start, end > 0 ? end : start + 2500);
}

console.log('Running terminal fit bottom-pin tests...');

test('bottom state is sampled before the fit, not after', () => {
  const body = fitBody();
  const sampleAt = body.indexOf('const wasAtBottom = isTerminalViewportAtBottom(cached)');
  const fitAt = body.indexOf('cached.fitAddon.fit()');
  assert.ok(sampleAt > 0, 'fit must record whether the viewport was pinned to the bottom');
  assert.ok(fitAt > sampleAt, 'the sample must be taken before fit() reflows the buffer');
});

test('a terminal that was at the bottom is re-pinned regardless of CLI kind', () => {
  const body = fitBody();
  assert.match(body, /else if \(wasAtBottom\) \{/,
    'non-Codex terminals must also be re-pinned after a resize');
  assert.match(body, /else if \(wasAtBottom\) \{[\s\S]{0,400}pinTerminalViewportToBottom\(cached\)/,
    'the re-pin must actually scroll the viewport to the bottom');
});

test('the re-pin survives xterm reflow by repeating on the next frame', () => {
  const body = fitBody();
  assert.match(body, /else if \(wasAtBottom\) \{[\s\S]{0,500}requestAnimationFrame\(/,
    'xterm settles reflow on the next frame, so one pin is not enough');
});

test('Codex keeps its own follow-bottom logic and is not double-pinned', () => {
  const body = fitBody();
  assert.match(body, /if \(pinAfterFit\) scheduleCodexBottomPin\(sessionId, cached\);\s*\n\s*else if \(wasAtBottom\)/,
    'Codex must take the scheduleCodexBottomPin branch exclusively, honouring _codexFollowBottom');
});

test('a terminal the user scrolled away from is left alone', () => {
  const body = fitBody();
  // wasAtBottom 为 false 时不得有任何置底调用
  const elseBranch = body.slice(body.indexOf('else if (wasAtBottom)'));
  assert.ok(!/^\s*else\s*\{[\s\S]*pinTerminalViewportToBottom/m.test(elseBranch),
    'scrolled-up terminals must not be yanked back to the bottom on resize');
});

if (!process.exitCode) console.log('All terminal fit bottom-pin tests passed.');
