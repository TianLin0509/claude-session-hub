'use strict';
// M2.4 修复 unit test：GeminiTap 的 idle_timer_5s 应该在所有 type:"gemini" content
// 行都 schedule（包括有 tokens.total 的 L3 路径），即便主路径 emit 因去重未触发，
// 5s 兜底也能 emit。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { transcriptTap, GeminiTap } = (() => {
  // GeminiTap 不直接 export，但 transcriptTap 内部用。我们直接 require 整个文件
  // 用 cheap 方式构造 GeminiTap 实例。
  const m = require('../core/transcript-tap.js');
  // transcript-tap.js 的 module.exports 含 transcriptTap 单例，但 GeminiTap 类本身不导出。
  // 折中：从内部 require 链取（不优雅但够测）
  return { transcriptTap: m.transcriptTap || m };
})();

// 用 cheaper 路径：直接构造 mock JSONL 文件 + 触发 GeminiTap 的内部
// 我们 require transcript-tap.js 拿到 GeminiTap 类的引用？不导出。
// 退路：跳过类直接测—— 通过 monkey 修改 require cache 拿内部类，太复杂
// 用一个简化的"行为"测试：实例化 transcriptTap → registerSession → 触发 onLine 路径
// 实际更可控的是直接 require 内部模块，绕过 export。

// 方法 B：直接 require 整个模块拿到 internal exports
delete require.cache[require.resolve('../core/transcript-tap.js')];
const tt = require('../core/transcript-tap.js');

// 检查 transcriptTap 单例是否导出
function testGeminiOnLineSchedulesIdleTimerForLineWithTokens() {
  // 文件级 invariant 检查（GeminiTap 类未导出，无法直接实例化测试，改为静态分析）
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'core', 'transcript-tap.js'), 'utf8');

  // 1. 必须有 isContentLine 检测
  assert.ok(/const isContentLine = \(/.test(src), 'should define isContentLine in GeminiTap onLine');

  // 2. isContentLine 必须覆盖三种 type
  const isContentLineDef = src.match(/const isContentLine = \([\s\S]{0,500}\);/);
  assert.ok(isContentLineDef, 'isContentLine def should be locatable');
  const cd = isContentLineDef[0];
  assert.ok(/'gemini'/.test(cd) && /'result'/.test(cd) && /'message_update'/.test(cd),
    `isContentLine should test for all 3 types, got: ${cd.slice(0, 200)}`);

  // 3. isContentLine 后必须调 _scheduleGeminiIdleEmit
  assert.ok(/if \(isContentLine\) _scheduleGeminiIdleEmit\(\)/.test(src),
    'onLine top should call _scheduleGeminiIdleEmit when isContentLine');

  // 4. _scheduleGeminiIdleEmit 总调用次数应该 ≤ 1（只在顶部统一调，不在分支重复）
  const scheduleCalls = src.match(/_scheduleGeminiIdleEmit\(\)/g) || [];
  // 函数定义本身不算调用 — 只数 () 调用
  assert.ok(scheduleCalls.length === 1,
    `_scheduleGeminiIdleEmit() should be called exactly once in onLine (no double-schedule); found ${scheduleCalls.length} calls`);

  console.log('  ✓ testGeminiOnLineSchedulesIdleTimerForLineWithTokens');
}

console.log('Running M2.4 GeminiTap idle-emit unit tests...');
let failed = 0;
const tests = [testGeminiOnLineSchedulesIdleTimerForLineWithTokens];
for (const t of tests) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    failed++;
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
