'use strict';
// 2026-05-02 修复锁定：
//   1. ClaudeTap idle-timer 兜底 emit（修 DeepSeek/GLM 卡片不更新——不再单点依赖 Stop hook）
//   2. extractLatestTurn 扩展到所有 backend（修一键提取按钮"假的"——旧版本仅 Gemini）
//   3. 顶层 TranscriptTap.extractLatestTurn 统一路由（按 backend 自动分发）
//   4. main.js IPC 改用统一入口（不再调过时的 extractLatestGeminiTurn）
//
// 测试方式：
//   - 行为测试：用真临时 JSONL 文件触发 ClaudeTap.notifyStop / extractLatestTurn，验证返回值
//   - 契约测试：grep main.js / transcript-tap.js 锁住关键函数和调用模式

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { TranscriptTap, readLastAssistantMessageFromClaudeTranscript } = require('../core/transcript-tap');

// ---------------- 工具：写一个伪 Claude transcript JSONL ----------------
function makeFakeClaudeJsonl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tap-test-'));
  const file = path.join(dir, 'fake-session.jsonl');
  fs.writeFileSync(file, '');
  return file;
}
function appendAssistantTurn(file, text) {
  const obj = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// ---------------- 测 1：ClaudeTap.extractLatestTurn 真能读到 transcript ----------------
async function testClaudeExtractLatestTurn() {
  const tap = new TranscriptTap();
  const sid = 'test-claude-sid-1';
  tap.registerSession(sid, 'claude', { cwd: process.cwd() });

  const file = makeFakeClaudeJsonl();
  appendAssistantTurn(file, '第 1 轮回答内容');
  appendAssistantTurn(file, '第 2 轮回答内容');

  // 直接调 ClaudeTap.notifyStop 模拟 hook 触发，让 transcriptPath 绑定
  await tap.notifyClaudeStop(sid, file);

  // 走顶层统一入口（IPC 实际调的就是这个）
  const r = await tap.extractLatestTurn(sid);
  assert.ok(r && r.text, 'extractLatestTurn 必须返回非空 result');
  assert.strictEqual(r.text, '第 2 轮回答内容', '必须返回最新一轮 assistant text');
  assert.strictEqual(r.source, 'manual_claude_transcript', 'source 应标识来源');

  tap.unregisterSession(sid);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  console.log('  ✓ testClaudeExtractLatestTurn');
}

// ---------------- 测 2：DeepSeek / GLM 走 ClaudeTap，extract 同样工作 ----------------
async function testDeepseekGlmExtractGoesThroughClaudeTap() {
  const tap = new TranscriptTap();
  const file = makeFakeClaudeJsonl();
  appendAssistantTurn(file, 'DeepSeek 的回答');

  for (const kind of ['deepseek', 'glm']) {
    const sid = `test-${kind}-sid`;
    tap.registerSession(sid, kind, { cwd: process.cwd() });
    await tap.notifyClaudeStop(sid, file);

    const r = await tap.extractLatestTurn(sid);
    assert.ok(r && r.text, `${kind} extractLatestTurn 必须工作（DeepSeek/GLM 复用 ClaudeTap）`);
    assert.strictEqual(r.text, 'DeepSeek 的回答', `${kind} 必须返回 transcript 末尾内容`);
    tap.unregisterSession(sid);
  }

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  console.log('  ✓ testDeepseekGlmExtractGoesThroughClaudeTap');
}

// ---------------- 测 3：未绑定 transcriptPath → 返回 null（不抛错） ----------------
async function testExtractReturnsNullWhenUnbound() {
  const tap = new TranscriptTap();
  const sid = 'test-unbound-sid';
  tap.registerSession(sid, 'claude', { cwd: process.cwd() });
  // 不调 notifyClaudeStop → transcriptPath 一直 null

  const r = await tap.extractLatestTurn(sid);
  assert.strictEqual(r, null, '未绑定 transcriptPath 必须返回 null（让 IPC 报清晰错）');
  tap.unregisterSession(sid);
  console.log('  ✓ testExtractReturnsNullWhenUnbound');
}

// ---------------- 测 4：notifyStop emit turn-complete 带 signalSource ----------------
async function testNotifyStopEmitsWithSignalSource() {
  const tap = new TranscriptTap();
  const sid = 'test-emit-sid';
  tap.registerSession(sid, 'claude', { cwd: process.cwd() });

  const file = makeFakeClaudeJsonl();
  appendAssistantTurn(file, '答案 A');

  let received = null;
  tap.on('turn-complete', (evt) => { if (evt.hubSessionId === sid) received = evt; });

  await tap.notifyClaudeStop(sid, file);

  assert.ok(received, 'turn-complete 必须被 emit');
  assert.strictEqual(received.text, '答案 A');
  assert.strictEqual(received.signalSource, 'stop_hook', 'Stop hook 路径必须打 signalSource=stop_hook');

  tap.unregisterSession(sid);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  console.log('  ✓ testNotifyStopEmitsWithSignalSource');
}

// ---------------- 测 5：契约测试 — main.js IPC 必须用统一入口 ----------------
function testMainJsUsesUnifiedExtractEntry() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const startIdx = src.indexOf("ipcMain.handle('roundtable-manual-extract'");
  assert.ok(startIdx >= 0, 'roundtable-manual-extract handler 必须存在');
  // handler body 取 600 字（够覆盖整个函数）
  const body = src.slice(startIdx, startIdx + 2500);

  // 必须用统一入口 transcriptTap.extractLatestTurn
  assert.ok(/transcriptTap\.extractLatestTurn\(/.test(body),
    'roundtable-manual-extract handler 必须调 transcriptTap.extractLatestTurn 统一入口');
  // 必须**不再**调旧的 extractLatestGeminiTurn（否则又只支持 Gemini，bug 回归）
  assert.ok(!/transcriptTap\.extractLatestGeminiTurn\(/.test(body),
    'handler 必须不再调 extractLatestGeminiTurn（旧 bug：Claude/DeepSeek/GLM/Codex 全部失效 → 用户报"按钮假的"）');

  console.log('  ✓ testMainJsUsesUnifiedExtractEntry');
}

// ---------------- 测 6：契约测试 — ClaudeTap 必须有 idle-timer 兜底 ----------------
function testClaudeTapHasIdleEmitFallback() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf-8');

  // 必须定义 _CLAUDE_IDLE_EMIT_MS 常量（5s 兜底间隔）
  assert.ok(/_CLAUDE_IDLE_EMIT_MS\s*=\s*\d+/.test(src),
    'transcript-tap.js 必须定义 _CLAUDE_IDLE_EMIT_MS（idle-timer 兜底间隔）');
  // 必须有 _scheduleIdleEmit / _cancelIdleEmit 内部方法
  assert.ok(/_scheduleIdleEmit\s*\(/.test(src),
    'ClaudeTap 必须有 _scheduleIdleEmit 方法（onLine 触发的兜底 emit timer）');
  assert.ok(/_cancelIdleEmit\s*\(/.test(src),
    'ClaudeTap 必须有 _cancelIdleEmit 方法（Stop hook 抢先时取消兜底 timer）');
  // notifyStop 必须调 _cancelIdleEmit（快路径取消 timer）
  const notifyStopIdx = src.indexOf('async notifyStop(hubSessionId');
  assert.ok(notifyStopIdx >= 0, 'notifyStop 函数必须存在');
  // notifyStop 函数体大约 60-80 行 ≈ 3500 字符，固定取 4000 覆盖整个函数（含 emit 段）
  const notifyStopBody = src.slice(notifyStopIdx, notifyStopIdx + 4000);
  assert.ok(/_cancelIdleEmit\(/.test(notifyStopBody),
    'notifyStop 必须调 _cancelIdleEmit（Stop hook 触发时取消兜底 timer，不重复 emit）');
  // emit turn-complete 必须带 signalSource
  assert.ok(/signalSource:\s*['"]stop_hook['"]/.test(notifyStopBody),
    "notifyStop emit 必须带 signalSource: 'stop_hook' 标识");
  // idle 路径 emit 必须带 signalSource
  assert.ok(/signalSource:\s*['"]idle_timer_5s['"]/.test(src),
    "idle-timer 兜底 emit 必须带 signalSource: 'idle_timer_5s'（与 stop_hook 区分）");

  console.log('  ✓ testClaudeTapHasIdleEmitFallback');
}

// ---------------- 测 8：契约测试 — GeminiTap 也有 idle-timer 兜底 ----------------
//   2026-05-02 用户反馈："Gemini 第一轮没快速提取"，根因是 token 信号延迟到达时
//   onLine 三层 emit 都不触发。修复：与 ClaudeTap 同套 idle-timer 思路。
function testGeminiTapHasIdleEmitFallback() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf-8');

  // 必须定义 _GEMINI_IDLE_EMIT_MS 常量
  assert.ok(/_GEMINI_IDLE_EMIT_MS\s*=\s*\d+/.test(src),
    'transcript-tap.js 必须定义 _GEMINI_IDLE_EMIT_MS（GeminiTap idle 兜底间隔）');
  // 必须有 _scheduleGeminiIdleEmit 内部函数
  assert.ok(/_scheduleGeminiIdleEmit/.test(src),
    'GeminiTap 必须有 _scheduleGeminiIdleEmit（onLine 触发的兜底 emit timer）');
  // idle 路径 emit 必须带新 signalSource
  assert.ok(/signalSource:\s*['"]idle_timer_5s['"]/.test(src),
    'idle-timer 兜底 emit 必须带 signalSource: idle_timer_5s');
  // GeminiTap.emitIfComplete 必须 clearTimeout(_idleTimer) 防重复 emit
  const geminiBindIdx = src.indexOf('async _bindSession');
  assert.ok(geminiBindIdx > 0, 'GeminiTap._bindSession 必须存在');
  const geminiBindBody = src.slice(geminiBindIdx, geminiBindIdx + 5000);
  // emitIfComplete 闭包必须含 _idleTimer + clearTimeout
  assert.ok(/emitIfComplete[\s\S]{0,800}?_idleTimer[\s\S]{0,200}?clearTimeout/.test(geminiBindBody),
    'GeminiTap.emitIfComplete 必须 clearTimeout(_idleTimer) 防 L1/L3 抢先后重复 emit');
  // unregisterSession 必须清 idle timer 防 leak（用 indexOf 定位整段函数体，避免正则非贪婪
  // 在 try {} 第一个 } 处提前截断）
  const geminiClassIdx = src.indexOf('class GeminiTap');
  assert.ok(geminiClassIdx > 0, '能定位到 GeminiTap class');
  const geminiUnregisterIdx = src.indexOf('unregisterSession(hubSessionId)', geminiClassIdx);
  assert.ok(geminiUnregisterIdx > 0, '能定位到 GeminiTap.unregisterSession');
  // 取函数 + 后续 1500 字符（足够覆盖整个函数体）
  const geminiUnregisterBody = src.slice(geminiUnregisterIdx, geminiUnregisterIdx + 1500);
  assert.ok(/_idleTimer/.test(geminiUnregisterBody),
    'GeminiTap.unregisterSession 必须清 _idleTimer 防 leak');

  console.log('  ✓ testGeminiTapHasIdleEmitFallback');
}

// ---------------- 测 7：契约测试 — 三个 backend 都有 extractLatestTurn ----------------
function testAllBackendsHaveExtractLatestTurn() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf-8');

  // ClaudeTap
  const claudeIdx = src.indexOf('class ClaudeTap');
  const claudeEndIdx = src.indexOf('class CodexTap', claudeIdx);
  const claudeBody = src.slice(claudeIdx, claudeEndIdx);
  assert.ok(/async\s+extractLatestTurn\s*\(/.test(claudeBody),
    'ClaudeTap 必须有 extractLatestTurn 方法');

  // CodexTap
  const codexIdx = src.indexOf('class CodexTap');
  const codexEndIdx = src.indexOf('class GeminiTap', codexIdx);
  const codexBody = src.slice(codexIdx, codexEndIdx);
  assert.ok(/async\s+extractLatestTurn\s*\(/.test(codexBody),
    'CodexTap 必须有 extractLatestTurn 方法');

  // GeminiTap 已有 extractLatestGeminiTurn（保留兼容）
  const geminiIdx = src.indexOf('class GeminiTap');
  const geminiEndIdx = src.indexOf('class TranscriptTap', geminiIdx);
  const geminiBody = src.slice(geminiIdx, geminiEndIdx);
  assert.ok(/async\s+extractLatestGeminiTurn\s*\(/.test(geminiBody),
    'GeminiTap 必须保留 extractLatestGeminiTurn（顶层 extractLatestTurn 仍调它）');

  // 顶层 TranscriptTap 必须有统一 extractLatestTurn 路由
  const ttIdx = src.indexOf('class TranscriptTap');
  const ttBody = src.slice(ttIdx);
  assert.ok(/async\s+extractLatestTurn\s*\(/.test(ttBody),
    'TranscriptTap 顶层必须有 extractLatestTurn 统一路由方法');
  // 路由必须调三个 backend
  assert.ok(/this\._claude\.extractLatestTurn/.test(ttBody),
    '顶层 extractLatestTurn 必须调 this._claude.extractLatestTurn');
  assert.ok(/this\._codex\.extractLatestTurn/.test(ttBody),
    '顶层 extractLatestTurn 必须调 this._codex.extractLatestTurn');
  assert.ok(/this\._gemini\.extractLatestGeminiTurn/.test(ttBody),
    '顶层 extractLatestTurn 必须调 this._gemini.extractLatestGeminiTurn');

  console.log('  ✓ testAllBackendsHaveExtractLatestTurn');
}

// ---------------- 跑测 ----------------
(async () => {
  console.log('Running ClaudeTap idle-emit + extractLatestTurn tests...');
  let failed = 0;
  const tests = [
    testClaudeExtractLatestTurn,
    testDeepseekGlmExtractGoesThroughClaudeTap,
    testExtractReturnsNullWhenUnbound,
    testNotifyStopEmitsWithSignalSource,
    testMainJsUsesUnifiedExtractEntry,
    testClaudeTapHasIdleEmitFallback,
    testGeminiTapHasIdleEmitFallback,
    testAllBackendsHaveExtractLatestTurn,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) {
      console.error('  ✗', t.name);
      console.error('    ', e.message);
      failed++;
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
