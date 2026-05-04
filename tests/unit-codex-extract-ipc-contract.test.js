'use strict';
// B1.3 契约测试 — main.js manual-extract IPC + TranscriptTap wrapper 透传 extractMode
//
// 覆盖：
//   1. TranscriptTap.extractLatestTurn 在 codex 4 态返回值时（含空 text）正确透传 r.extractMode
//   2. main.js 源码在 manual-extract handler 的 4 处 return 都带 extractMode 字段
//
// 走 source-grep 契约（不启 Electron），只断言关键不变量。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { TranscriptTap, CodexTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('../tests/helpers/fake-codex-rollout');

let failed = 0;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === 1. TranscriptTap wrapper 透传 codex extractMode ===

async function testTranscriptTapTransparentlyForwardsCodexNoBoundMode() {
  // 不动 TranscriptTap 内部 _codex 实例（默认 ~/.codex/sessions），但用一个根本不存在的
  // hub sid 调 extractLatestTurn —— claude/gemini 都返 null，codex 也找不到 _bound，
  // 应该返回 { extractMode: 'no_rollout_bound' } 让 wrapper 透传出来。
  const tap = new TranscriptTap();
  const r = await tap.extractLatestTurn('nonexistent-sid-xxx', 0);
  // wrapper 应当返回 codex 的 4 态对象（extractMode='no_rollout_bound'），不是 null
  assert.ok(r, 'TranscriptTap.extractLatestTurn should return codex 4-state object, not null');
  assert.strictEqual(r.extractMode, 'no_rollout_bound', `expected no_rollout_bound, got ${r.extractMode}`);
}

async function testTranscriptTapForwardsCodexFinalAnswer() {
  // 注入一个隔离 sessionsRoot 的 CodexTap 替换 TranscriptTap 内部实例，验证 final_answer 透传
  const tmpRoot = path.join(os.tmpdir(), 'tt-fwd-final-' + Date.now());
  const cwd = 'C:\\test\\proj-fwd';
  const tap = new TranscriptTap();
  // monkey-patch _codex 实例（测试隔离用）
  tap._codex = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  // 重新连 turn-complete / session-bound 事件冒泡（mimic constructor）
  tap._codex.on('turn-complete', (ev) => tap.emit('turn-complete', ev));
  tap._codex.on('session-bound', (ev) => tap.emit('session-bound', ev));

  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    await fr.writeFullTurn(['mid'], 'final-via-wrapper', { gapMs: 5 });
    await fr.close();

    const hubSid = 'hub-fwd-1';
    tap._codex.registerSession(hubSid, { cwd });

    // 等绑定（轮询 _bound）
    let bound = false;
    for (let i = 0; i < 40; i++) {
      if (tap._codex._bound.has(hubSid)) { bound = true; break; }
      await _sleep(50);
    }
    assert.ok(bound, 'codex tap must bind via wrapper');

    const r = await tap.extractLatestTurn(hubSid, 0);
    assert.ok(r, 'wrapper must return result');
    assert.strictEqual(r.text, 'final-via-wrapper');
    assert.strictEqual(r.extractMode, 'final_answer', `wrapper must forward final_answer, got ${r.extractMode}`);
  } finally {
    tap._codex.unregisterSession('hub-fwd-1');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === 2. main.js manual-extract IPC 源码契约（4 处 return 都带 extractMode）===

function testMainJsManualExtractSourceContract() {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // 找到 'roundtable-manual-extract' handler 的范围（从 ipcMain.handle 到下一个 ipcMain.handle）
  const startIdx = mainSrc.indexOf("ipcMain.handle('roundtable-manual-extract'");
  assert.ok(startIdx > 0, 'main.js must contain roundtable-manual-extract handler');
  const endIdx = mainSrc.indexOf("ipcMain.handle('roundtable-resend-prompt'", startIdx);
  assert.ok(endIdx > startIdx, 'must find next handler as boundary');
  const handlerBlock = mainSrc.slice(startIdx, endIdx);

  // 契约 A：handler 内必须出现 extractMode 字段透传
  assert.ok(
    handlerBlock.includes('extractMode'),
    'manual-extract handler must reference extractMode field (Spec S2 contract)',
  );

  // 契约 B：handler 内非 missing_sid / extract_failed 两条 early-return 之外的所有 return
  //   都应带 extractMode（覆盖 no_content 失败路径 + 3 个 ok=true 路径 = 4 处）
  const returns = handlerBlock.match(/return\s+\{[^}]+\}/g) || [];
  // 排除 missing_sid 和 extract_failed（那两条不需要 extractMode，因为没机会调 extractLatestTurn）
  const nonEarlyReturns = returns.filter((r) => !r.includes('missing_sid') && !r.includes('extract_failed'));
  assert.ok(
    nonEarlyReturns.length >= 4,
    `expected ≥4 non-early returns (no_content + 3 ok paths), got ${nonEarlyReturns.length}`,
  );
  for (const ret of nonEarlyReturns) {
    assert.ok(
      ret.includes('extractMode'),
      `each non-early return must include extractMode field, missing in: ${ret.slice(0, 100)}...`,
    );
  }
}

// === 3. main.js source contract: 不重命名 mode 字段（保留 watcher_settle/patch_last_turn/text_only）===
function testMainJsLegacyModeNotRenamed() {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const startIdx = mainSrc.indexOf("ipcMain.handle('roundtable-manual-extract'");
  const endIdx = mainSrc.indexOf("ipcMain.handle('roundtable-resend-prompt'", startIdx);
  const handlerBlock = mainSrc.slice(startIdx, endIdx);

  // 契约：旧 mode 字段（IPC 上下文 mode）必须保留 3 个值
  assert.ok(handlerBlock.includes("'watcher_settle'"), 'mode=watcher_settle must remain');
  assert.ok(handlerBlock.includes("'patch_last_turn'"), 'mode=patch_last_turn must remain');
  assert.ok(handlerBlock.includes("'text_only'"), 'mode=text_only must remain');
}

// === runner ===

const tests = [
  testTranscriptTapTransparentlyForwardsCodexNoBoundMode,
  testTranscriptTapForwardsCodexFinalAnswer,
  testMainJsManualExtractSourceContract,
  testMainJsLegacyModeNotRenamed,
];

(async () => {
  for (const t of tests) {
    try {
      await t();
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
