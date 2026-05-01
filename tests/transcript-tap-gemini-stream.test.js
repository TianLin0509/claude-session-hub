'use strict';
// Task 2（2026-05-01）单测：GeminiTap streamingBuf 接口契约。
//
// 完整 onLine 累积验证由 E2E（Task 12）真跑 Gemini turn 后断言；
// 这里只锁住公开接口的 null-safety 与签名，避免 main.js 调用时 TypeError。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { TranscriptTap } = require('../core/transcript-tap');

function test(name, fn) {
  return Promise.resolve(fn())
    .then(() => console.log(`  ✓ ${name}`))
    .catch(e => {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    });
}

async function main() {
  console.log('Running GeminiTap streamingBuf contract tests...');

  await test('未注册 sid → getStreamingText 返回 null（null-safe）', () => {
    const tap = new TranscriptTap();
    assert.strictEqual(tap.getStreamingText('not-bound'), null);
    tap.clearStreamingBuf('not-bound');  // should not throw
  });

  await test('GeminiTap 实例存在 getStreamingText / clearStreamingBuf 方法', () => {
    const { TranscriptTap: T2 } = require('../core/transcript-tap');
    const tap = new T2();
    // 通过 _gemini 私有路径直接确认（避免 ClaudeTap 的优先级覆盖）
    assert.strictEqual(typeof tap._gemini.getStreamingText, 'function');
    assert.strictEqual(typeof tap._gemini.clearStreamingBuf, 'function');
    // 未绑定时返回 null
    assert.strictEqual(tap._gemini.getStreamingText('any-sid'), null);
  });

  await test('源代码契约：onLine 必须 _pushStreamBlock 三种 content 路径', () => {
    // 静态分析 _bindSession 的 onLine 体，锁住 result / message_update / gemini 三路均累积 buf
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf-8');
    const start = src.indexOf('async _bindSession');
    assert.ok(start > 0, '_bindSession 必须存在');
    const end = src.indexOf('class TranscriptTap', start);
    const body = src.slice(start, end);
    // 三种 content 来源都必须 _pushStreamBlock
    const pushCalls = (body.match(/_pushStreamBlock\(/g) || []).length;
    assert.ok(pushCalls >= 4, `_pushStreamBlock 调用至少 4 次（result/message_update/gemini-with-tokens/gemini-no-tokens），实际 ${pushCalls}`);
    assert.ok(/_streamingBuf\s*=\s*\[\]/.test(body) || /_streamingBuf:\s*\[\]/.test(body), 'boundEntry 必须含 _streamingBuf 初始化');
    assert.ok(/_STREAM_BUF_MAX_BYTES\s*=\s*50000/.test(body), '50KB 截断阈值必须存在');
  });

  console.log('All passed.');
}

main().catch(e => { console.error(e); process.exit(1); });
