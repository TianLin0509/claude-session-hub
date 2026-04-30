'use strict';
// Stage 2 P0-1 单测：锁住 transcript-tap.js Gemini JSONL 三层完成信号识别契约。
//
// 不 spawn 真 Gemini CLI（pty / 文件系统侵入太大），改为静态扫 transcript-tap.js
// 源码 + 通过 grep 形式断言关键判定行存在。这与 unit-roundtable-fast-path.test.js
// 的"双路盯住"模式一致：源码契约不破，runtime 行为靠 P0-4 watcher 的 EventEmitter 单测覆盖。
//
// 覆盖点：
//   1. type:"result" 行触发 emit signalSource='result_event'
//   2. type:"message_update" status:"finalized" 行触发 emit signalSource='message_update'
//   3. type:"gemini" + tokens.total 仍触发 emit signalSource='tokens_total'（向后兼容）
//   4. emitIfComplete 函数支持 meta 参数（{ signalSource }）
//   5. emit payload 含 signalSource 字段
//   6. extractLatestGeminiTurn 方法存在于 GeminiTap 类 + TranscriptTap 顶层包装

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSrc() {
  return fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf-8');
}

// 取 JSONL 分支函数体（onLine = (obj) => { ... } 紧跟 isJsonl 判定的那段）
function extractJsonlOnLineBody(src) {
  const startIdx = src.indexOf('Gemini 0.39+ JSONL');
  assert.ok(startIdx >= 0, 'JSONL branch comment must exist');
  const endIdx = src.indexOf('Gemini 0.38 and older', startIdx);
  assert.ok(endIdx > startIdx, 'old JSON branch must follow JSONL branch');
  return src.slice(startIdx, endIdx);
}

function testJsonlResultEventIdentified() {
  const body = extractJsonlOnLineBody(readSrc());
  // 必须识别 type:"result" 并 emit signalSource='result_event'
  assert.ok(/obj\?\.type\s*===\s*['"]result['"]/.test(body),
    'JSONL onLine must check obj.type === "result"');
  assert.ok(/signalSource:\s*['"]result_event['"]/.test(body),
    'must emit with signalSource: "result_event"');
  console.log('  ✓ testJsonlResultEventIdentified');
}

function testJsonlMessageUpdateIdentified() {
  const body = extractJsonlOnLineBody(readSrc());
  assert.ok(/obj\?\.type\s*===\s*['"]message_update['"]/.test(body),
    'JSONL onLine must check obj.type === "message_update"');
  assert.ok(/obj\.status\s*===\s*['"]finalized['"]/.test(body),
    'must require status === "finalized"');
  assert.ok(/signalSource:\s*['"]message_update['"]/.test(body),
    'must emit with signalSource: "message_update"');
  console.log('  ✓ testJsonlMessageUpdateIdentified');
}

function testJsonlTokensTotalBackwardCompat() {
  const body = extractJsonlOnLineBody(readSrc());
  // tokens.total 路径必须保留为 L3 启发式
  assert.ok(/obj\?\.type\s*===\s*['"]gemini['"]/.test(body),
    'tokens_total path: obj.type === "gemini"');
  assert.ok(/obj\.tokens\.total\s*!=\s*null/.test(body),
    'tokens_total path: tokens.total != null check');
  assert.ok(/signalSource:\s*['"]tokens_total['"]/.test(body),
    'tokens_total path: signalSource: "tokens_total"');
  console.log('  ✓ testJsonlTokensTotalBackwardCompat');
}

function testEmitPayloadHasSignalSource() {
  const src = readSrc();
  // emitIfComplete 内部 emit('turn-complete', {...}) 必须含 signalSource 字段
  // 取 emitIfComplete 函数体到下一个 "if (isJsonl)" 之前
  const startIdx = src.indexOf('const emitIfComplete = (content, meta');
  assert.ok(startIdx >= 0, 'emitIfComplete must accept meta param: (content, meta = {})');
  const endIdx = src.indexOf('if (isJsonl)', startIdx);
  assert.ok(endIdx > startIdx);
  const fnBody = src.slice(startIdx, endIdx);
  assert.ok(/this\.emit\(['"]turn-complete['"]/.test(fnBody), 'must emit turn-complete');
  assert.ok(/signalSource:\s*meta\.signalSource/.test(fnBody),
    'emit payload must read signalSource from meta arg');
  console.log('  ✓ testEmitPayloadHasSignalSource');
}

function testExtractLatestGeminiTurnExists() {
  const src = readSrc();
  // GeminiTap 类内必须有 async extractLatestGeminiTurn(hubSessionId, sincePromptTs)
  assert.ok(/async extractLatestGeminiTurn\(hubSessionId,\s*sincePromptTs\)/.test(src),
    'GeminiTap must expose async extractLatestGeminiTurn(hubSessionId, sincePromptTs)');
  // 必须按时间戳过滤（timestamp / ts 二选一）
  assert.ok(/typeof obj\.timestamp\s*===\s*['"]number['"]/.test(src),
    'must check obj.timestamp');
  assert.ok(/typeof obj\.ts\s*===\s*['"]number['"]/.test(src),
    'must also fall back to obj.ts');
  // 必须只拼接 type === 'gemini' 的行
  assert.ok(/if \(obj\?\.type\s*!==\s*['"]gemini['"]\)\s*continue/.test(src),
    'extractLatestGeminiTurn must only collect type:"gemini" rows');
  // 返回 source: 'manual'
  assert.ok(/source:\s*['"]manual['"]/.test(src),
    'returned object must include source: "manual"');
  console.log('  ✓ testExtractLatestGeminiTurnExists');
}

function testTranscriptTapWrapperExists() {
  const src = readSrc();
  // TranscriptTap 顶层必须有 extractLatestGeminiTurn 委托
  // 找 class TranscriptTap 起点 + 该方法定义
  const tapStart = src.indexOf('class TranscriptTap');
  assert.ok(tapStart >= 0);
  const tapBody = src.slice(tapStart);
  assert.ok(/async extractLatestGeminiTurn\(hubSessionId,\s*sincePromptTs\)\s*\{[\s\S]*?this\._gemini\.extractLatestGeminiTurn/.test(tapBody),
    'TranscriptTap must wrap extractLatestGeminiTurn delegating to this._gemini');
  console.log('  ✓ testTranscriptTapWrapperExists');
}

function testRoundtableOrchestratorConstants() {
  // 锁住 P0-3：roundtable-orchestrator 导出 SOFT_ALERT_T1/T2，且值正确
  const orch = require('../core/roundtable-orchestrator.js');
  assert.strictEqual(orch.SOFT_ALERT_T1_MS, 90000, 'SOFT_ALERT_T1_MS must be 90000ms (90s)');
  assert.strictEqual(orch.SOFT_ALERT_T2_MS, 180000, 'SOFT_ALERT_T2_MS must be 180000ms (180s)');
  // TURN_WATCHDOG_MS 在 Stage 2 commit 2 已删除（main.js 改用 turn-completion-watcher）
  assert.strictEqual(orch.TURN_WATCHDOG_MS, undefined,
    'TURN_WATCHDOG_MS must NOT be exported (replaced by turn-completion-watcher soft alerts)');
  console.log('  ✓ testRoundtableOrchestratorConstants');
}

console.log('Running transcript-tap Gemini result-detection tests...');
testJsonlResultEventIdentified();
testJsonlMessageUpdateIdentified();
testJsonlTokensTotalBackwardCompat();
testEmitPayloadHasSignalSource();
testExtractLatestGeminiTurnExists();
testTranscriptTapWrapperExists();
testRoundtableOrchestratorConstants();
console.log('All passed.');
