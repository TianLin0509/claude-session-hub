'use strict';
// E1.1 RED — main.js manual-extract no_content 分支按 extractMode 分级 detail 文案
//
// 用户痛点（2026-05-04 截图重现）：
//   v2.1 加了 extractMode 字段透传到 IPC，但 main.js 的 detail 文本仍写死，
//   renderer alert(r.detail) 因此显示笼统"提取失败"，用户无法判断该等还是该进 shell。
//
// 修复后契约：no_content 路径下 detail 必须按 extractMode 给出针对性 hint。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failed = 0;

function _readMainJs() {
  return fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
}

function _readManualExtractHandler(src) {
  const start = src.indexOf("ipcMain.handle('roundtable-manual-extract'");
  assert.ok(start > 0, 'main.js must contain manual-extract handler');
  // 找下一个 ipcMain.handle 作为 boundary（不写死 'resend-prompt'，因为 debug-state
  // IPC handler 可能插在 manual-extract 与 resend-prompt 之间）
  const nextHandlerRegex = /ipcMain\.handle\(['"]/g;
  nextHandlerRegex.lastIndex = start + 1;
  const m = nextHandlerRegex.exec(src);
  const end = m ? m.index : src.length;
  assert.ok(end > start);
  return src.slice(start, end);
}

// === case 1: no_rollout_bound 文案含针对性 hint ===
function testNoRolloutBoundDetailHasHint() {
  const handler = _readManualExtractHandler(_readMainJs());
  // 必须含 extractMode 路由判定
  assert.ok(/extractMode\s*===\s*['"]no_rollout_bound['"]/.test(handler),
    'handler must branch on extractMode === "no_rollout_bound"');
  // 文案应提到 rollout 文件 / 绑定 / sessions 目录其中之一
  const hasRolloutHint = /rollout|绑定|sessions/.test(handler);
  assert.ok(hasRolloutHint, 'no_rollout_bound 文案必须含 rollout/绑定/sessions 关键词');
}

// === case 2: no_task_complete_yet 文案含针对性 hint ===
function testNoTaskCompleteYetDetailHasHint() {
  const handler = _readManualExtractHandler(_readMainJs());
  assert.ok(/extractMode\s*===\s*['"]no_task_complete_yet['"]/.test(handler),
    'handler must branch on extractMode === "no_task_complete_yet"');
  // 文案应提到 task_complete / MCP / 思考其中之一
  const hasTaskHint = /task_complete|MCP|思考|confirm/.test(handler);
  assert.ok(hasTaskHint, 'no_task_complete_yet 文案必须含 task_complete/MCP/思考 关键词');
}

// === case 3: 不同 extractMode 的 detail 必须真不同（防全文案完全相同的伪修复）===
function testDetailDiffersByMode() {
  const handler = _readManualExtractHandler(_readMainJs());
  // 兼容两种写法：object literal `detail: '...'` 或变量赋值 `detail = \`...\``
  const detailObjLiteralCount = (handler.match(/detail\s*:\s*[`'"]/g) || []).length;
  const detailAssignCount = (handler.match(/detail\s*=\s*[`'"]/g) || []).length;
  const total = detailObjLiteralCount + detailAssignCount;
  assert.ok(total >= 2,
    `必须有 ≥2 处 detail 字面量（按 extractMode 分支独立设置），got obj=${detailObjLiteralCount} assign=${detailAssignCount}`);
}

// === case 4: 进 shell hint 应在 no_rollout_bound 或 no_task_complete_yet 文案中至少出现一次 ===
function testEnterShellHintPresent() {
  const handler = _readManualExtractHandler(_readMainJs());
  // codex 常见两种 no_content 都建议进 shell 看 PTY 输出
  const hasShellHint = /进 shell|🔧|enter[-_ ]shell/i.test(handler);
  assert.ok(hasShellHint, 'no_content 路径必须含"进 shell"提示');
}

// === case 5: ok=true 路径也应携带 extractMode（让 UI 知道是 partial 还是 final）===
function testOkPathsCarryExtractMode() {
  const handler = _readManualExtractHandler(_readMainJs());
  // 已有 v2.1 实施：3 处 ok=true return 都附 extractMode
  // 这是回归保护，避免改 detail 时误删 ok 路径的 extractMode
  const okReturns = handler.match(/return\s+\{\s*ok:\s*true[^}]+\}/g) || [];
  assert.ok(okReturns.length >= 3, `expected ≥3 ok=true returns, got ${okReturns.length}`);
  for (const ret of okReturns) {
    assert.ok(ret.includes('extractMode'), `each ok return must carry extractMode: ${ret.slice(0, 80)}...`);
  }
}

// === runner ===

const tests = [
  testNoRolloutBoundDetailHasHint,
  testNoTaskCompleteYetDetailHasHint,
  testDetailDiffersByMode,
  testEnterShellHintPresent,
  testOkPathsCarryExtractMode,
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
