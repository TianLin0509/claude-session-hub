'use strict';
// gemini-equiv RED — gemini ready 判定不应被持续 redraw 卡住
//
// 用户反馈："创建中→待命识别不准，gemini 特别慢"。
// 根因：roundtable-cli-ready-detector 双门要求 buffer 静默 1500ms，但 gemini 0.40.1
//   Ink TUI 在 PTY 下持续重渲染（spinner / cursor blink / token 计数刷新），
//   buffer 长度持续变化 → 永远不进入静默 → 卡"创建中"。
// 期望：gemini marker（'Type your message' / 'YOLO' / 'gemini-'）是已 ready 的强信号，
//   命中即应判 ready，不强制静默期。

const assert = require('assert');
const detector = require('../core/roundtable-cli-ready-detector');

let failed = 0;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBuf(prefix, lenTotal) {
  const pad = 'x'.repeat(Math.max(0, lenTotal - prefix.length));
  return prefix + pad;
}

// === case 1: gemini marker 命中 + buf ≥ MIN 立即 ready（fast-path）===
function testGeminiReadyImmediatelyOnMarker() {
  const sid = 'gemini-fast-' + Date.now();
  detector.cleanup(sid);
  const buf = makeBuf('xxx Type your message or @path/to/file YOLO Ctrl+Y gemini-2.5-flash xxx', 700);
  assert.strictEqual(
    detector.isReady(sid, 'gemini', buf), true,
    'gemini marker 命中 + buf ≥ MIN 应立即 ready（fast-path），不应被静默期 1500ms 卡',
  );
  detector.cleanup(sid);
}

// === case 2: gemini buffer 持续重渲染（spinner/cursor 闪烁）期间也 ready ===
async function testGeminiReadyDuringRedraw() {
  const sid = 'gemini-redraw-' + Date.now();
  detector.cleanup(sid);
  // 模拟 6 次 200ms 间隔的 buffer 重渲染（gemini Ink TUI spinner / cursor blink）
  for (let i = 0; i < 6; i++) {
    const buf = makeBuf('xxx Type your message YOLO gemini-2.5-flash xxx', 700 + i * 5);
    if (detector.isReady(sid, 'gemini', buf)) {
      detector.cleanup(sid);
      return;
    }
    await _sleep(200);
  }
  detector.cleanup(sid);
  throw new Error('gemini marker 命中但 1.2s 内 buffer 持续变化时仍未 ready — fast-path 失效');
}

// === case 2: claude 不受影响（仍需静默期）===
async function testClaudeStillNeedsStable() {
  const sid = 'claude-stable-' + Date.now();
  detector.cleanup(sid);

  const baseBuf = makeBuf('xxx shift+tab to cycle xxx', 700);
  assert.strictEqual(detector.isReady(sid, 'claude', baseBuf), false, '首次观察');

  // 200ms 后 buffer 变化 → claude 不应 ready（保持原静默期保护）
  await _sleep(200);
  const buf2 = makeBuf('xxx shift+tab to cycle xxx', 720);
  // claude 仍需 1500ms 静默；200ms 内 buffer 变化必定 false
  assert.strictEqual(
    detector.isReady(sid, 'claude', buf2), false,
    'claude 仍应等静默期，不被 gemini fast-path 影响',
  );
  detector.cleanup(sid);
}

// === case 3: gemini marker 不命中（OAuth 阶段）→ 仍 false ===
function testGeminiNoMarkerStillFalse() {
  const sid = 'gemini-no-marker-' + Date.now();
  detector.cleanup(sid);
  // 模拟 OAuth 阶段 buffer：含 "Waiting for authentication" 但无 marker
  const buf = makeBuf('xxx Waiting for authentication xxx', 700);
  assert.strictEqual(
    detector.isReady(sid, 'gemini', buf), false,
    'OAuth 阶段无 marker 不应 ready',
  );
  detector.cleanup(sid);
}

// === case 4: gemini buf < MIN_BUF_LEN → 仍 false（防早期假命中）===
function testGeminiTooSmallBuf() {
  const sid = 'gemini-small-' + Date.now();
  detector.cleanup(sid);
  const buf = 'Type your message YOLO'; // 短，含 marker 但 < MIN_BUF_LEN(500)
  assert.strictEqual(
    detector.isReady(sid, 'gemini', buf), false,
    'buf < MIN 不应 ready 即使 marker 命中',
  );
  detector.cleanup(sid);
}

// === runner ===
const tests = [testGeminiReadyImmediatelyOnMarker, testGeminiReadyDuringRedraw, testClaudeStillNeedsStable, testGeminiNoMarkerStillFalse, testGeminiTooSmallBuf];
(async () => {
  for (const t of tests) {
    try {
      const r = t();
      if (r && typeof r.then === 'function') await r;
      console.log('  ✓', t.name);
    } catch (e) {
      console.error('  ✗', t.name);
      console.error('    ', e.stack || e.message);
      failed++;
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
