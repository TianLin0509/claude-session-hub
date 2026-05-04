'use strict';
// 契约测试 — 单家 patch 路径不得复用整轮 turn-complete IPC
//
// Bug（2026-05-04 道雪）：用户点 A 卡片的"一键提取"或"重新拉起"，B/C 卡片误进入 thinking
//   流光态。根因：main.js 的 manual-extract patch_last_turn 分支 + resend-participant
//   分支都发了 'roundtable-turn-complete'，但 renderer 的 turn-complete handler 会
//   清空整个 _partialBy + currentMode，把本轮还在跑的其他家的 partial 一并丢掉。
//   refreshRoundtablePanel 拉回真实 currentMode（仍非 idle）后，无 partial 的家就
//   被 line 524 的兜底分支判为 status='thinking'，触发流光特效。
//
// 修复：单家 patch 改发 'roundtable-partial-update'（已有的局部 patch 路径）。
//   本测试锁住源码契约，防止以后又被改回 turn-complete。
//
// 走 source-grep 契约（不启 Electron），只断言关键不变量。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failed = 0;

function _readMainSrc() {
  return fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
}

function _extractHandlerBlock(mainSrc, ipcName) {
  const startIdx = mainSrc.indexOf(`ipcMain.handle('${ipcName}'`);
  assert.ok(startIdx > 0, `must find ipcMain.handle('${ipcName}', ...)`);
  const nextHandlerRegex = /ipcMain\.handle\(['"]/g;
  nextHandlerRegex.lastIndex = startIdx + 1;
  const m = nextHandlerRegex.exec(mainSrc);
  const endIdx = m ? m.index : mainSrc.length;
  return mainSrc.slice(startIdx, endIdx);
}

// === case 1: manual-extract handler 不发 turn-complete ===
function testManualExtractDoesNotSendTurnComplete() {
  const mainSrc = _readMainSrc();
  const block = _extractHandlerBlock(mainSrc, 'roundtable-manual-extract');
  assert.ok(
    !block.includes("'roundtable-turn-complete'"),
    'manual-extract handler 不得发 roundtable-turn-complete（会误清整个 _partialBy → 其他家流光）',
  );
  // 必须改用 partial-update（局部 patch 路径）
  assert.ok(
    block.includes("'roundtable-partial-update'"),
    'manual-extract patch_last_turn 分支必须发 roundtable-partial-update（局部刷新 sid 卡片）',
  );
}

// === case 2: resend-participant handler 不发 turn-complete ===
function testResendParticipantDoesNotSendTurnComplete() {
  const mainSrc = _readMainSrc();
  const block = _extractHandlerBlock(mainSrc, 'roundtable-resend-participant');
  assert.ok(
    !block.includes("'roundtable-turn-complete'"),
    'resend-participant handler 不得发 roundtable-turn-complete（同 manual-extract bug）',
  );
  assert.ok(
    block.includes("'roundtable-partial-update'"),
    'resend-participant 必须发 roundtable-partial-update（局部刷新 sid 卡片）',
  );
}

// === case 3: 整轮 dispatchRoundtableTurn 仍发 turn-complete（不要误删合法用法）===
function testDispatchTurnCompleteStillEmitted() {
  const mainSrc = _readMainSrc();
  // dispatchRoundtableTurn 是顶层函数（不是 ipcMain.handle 块），整轮 settle 后必须 turn-complete
  const startIdx = mainSrc.indexOf('async function dispatchRoundtableTurn');
  assert.ok(startIdx > 0, 'must find dispatchRoundtableTurn function');
  // 找下一个顶层 function / ipcMain.handle 作 boundary
  const nextRegex = /\n(async function |function |ipcMain\.handle\()/g;
  nextRegex.lastIndex = startIdx + 1;
  const m = nextRegex.exec(mainSrc);
  const endIdx = m ? m.index : mainSrc.length;
  const block = mainSrc.slice(startIdx, endIdx);
  assert.ok(
    block.includes("'roundtable-turn-complete'"),
    'dispatchRoundtableTurn 整轮 settle 必须发 turn-complete（合法用法，不要误删）',
  );
}

// === case 4: turn-complete 全文件出现次数应 ≤ 2（dispatch + summary-brief）===
//   保险：防止又被引入新的单家 patch 路径误用。
function testTurnCompleteSendCountUpperBound() {
  const mainSrc = _readMainSrc();
  // sendToRenderer('roundtable-turn-complete' 的出现次数
  const matches = mainSrc.match(/sendToRenderer\(['"]roundtable-turn-complete['"]/g) || [];
  assert.ok(
    matches.length <= 2,
    `sendToRenderer('roundtable-turn-complete') 出现 ${matches.length} 次，最多允许 2 次`
      + `（dispatch 整轮 + summary-brief 整轮）。多出的几乎肯定是单家 patch 误用，会触发流光 bug。`,
  );
  assert.ok(
    matches.length >= 1,
    'turn-complete 至少应出现 1 次（整轮 dispatch settle 路径）',
  );
}

// === runner ===
const tests = [
  testManualExtractDoesNotSendTurnComplete,
  testResendParticipantDoesNotSendTurnComplete,
  testDispatchTurnCompleteStillEmitted,
  testTurnCompleteSendCountUpperBound,
];

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
