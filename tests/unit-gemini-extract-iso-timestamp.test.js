'use strict';
// gemini-equiv RED — extractLatestGeminiTurn 必须正确解析 ISO 字符串 timestamp
//
// 用户反馈：手动一键提取后把"历史多轮信息全提取了"。
// 根因：gemini 0.40.1 jsonl 写的 timestamp 是 ISO 字符串 ("2026-05-04T13:38:21.867Z")，
//   但 extractLatestGeminiTurn 只在 typeof timestamp === 'number' 时取值，否则置 null，
//   ts < sincePromptTs 过滤条件被绕过 → 全部 type:"gemini" 行被收集。
// 期望：ISO 字符串也应解析成 ms epoch，让 sincePromptTs 过滤生效。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GeminiTap } = require('../core/transcript-tap');
const { FakeGeminiSession } = require('./helpers/fake-gemini-session');

let failed = 0;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === case 1: ISO 字符串 timestamp 早于 sincePromptTs 应被过滤 ===
async function testIsoTimestampFiltering() {
  const tmpRoot = path.join(os.tmpdir(), 'gemini-iso-ts-' + Date.now());
  const cwd = 'C:\\test\\iso-ts';
  const tap = new GeminiTap({ tmpRoot });

  let fr;
  try {
    fr = new FakeGeminiSession({ tmpRoot, cwd });
    await fr.start();

    // 第 1 轮：早期 content（ISO ts t1）
    const t1 = new Date('2026-05-04T13:39:00.000Z').getTime();
    await fr.writeRaw({
      id: 'hist-1', timestamp: '2026-05-04T13:39:00.000Z', type: 'user',
      content: [{ text: '第 1 轮 prompt' }],
    });
    await fr.writeRaw({
      id: 'hist-2', timestamp: '2026-05-04T13:39:00.500Z', type: 'gemini',
      content: '第 1 轮回答（不应被提取）',
    });

    // 第 2 轮：当前 content（ISO ts t2）
    const t2 = new Date('2026-05-04T13:40:00.000Z').getTime();
    await fr.writeRaw({
      id: 'cur-1', timestamp: '2026-05-04T13:40:00.000Z', type: 'user',
      content: [{ text: '第 2 轮 prompt' }],
    });
    await fr.writeRaw({
      id: 'cur-2', timestamp: '2026-05-04T13:40:00.500Z', type: 'gemini',
      content: '第 2 轮回答（应被提取）',
    });
    await fr.close();

    const hubSid = 'hub-iso-test';
    tap.registerSession(hubSid, { cwd });
    let bound = false;
    for (let i = 0; i < 60; i++) {
      if (tap._bound.has(hubSid)) { bound = true; break; }
      await _sleep(100);
    }
    assert.ok(bound, 'must bind');

    // 用 t2 - 100ms 作为 sincePromptTs（应只拿第 2 轮）
    const sincePromptTs = t2 - 100;
    const result = await tap.extractLatestGeminiTurn(hubSid, sincePromptTs);
    assert.ok(result, 'must return non-null result');
    assert.ok(result.text, 'must have text');
    assert.ok(
      !result.text.includes('第 1 轮回答'),
      `历史第 1 轮内容不应被提取，但 text=${result.text}`,
    );
    assert.ok(
      result.text.includes('第 2 轮回答'),
      `当前第 2 轮内容应被提取，但 text=${result.text}`,
    );
    assert.strictEqual(result.lineCount, 1, '只应收集 1 行 type:"gemini"');
  } finally {
    if (fr) { try { await fr.close(); } catch {} }
    tap.unregisterSession('hub-iso-test');
    try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// === case 2: sincePromptTs=0 仍应拿全部内容（向后兼容）===
async function testZeroSinceTsReturnsAll() {
  const tmpRoot = path.join(os.tmpdir(), 'gemini-iso-ts-zero-' + Date.now());
  const cwd = 'C:\\test\\iso-ts-zero';
  const tap = new GeminiTap({ tmpRoot });

  let fr;
  try {
    fr = new FakeGeminiSession({ tmpRoot, cwd });
    await fr.start();
    await fr.writeRaw({ id: 'a', timestamp: '2026-05-04T10:00:00.000Z', type: 'gemini', content: 'A' });
    await fr.writeRaw({ id: 'b', timestamp: '2026-05-04T11:00:00.000Z', type: 'gemini', content: 'B' });
    await fr.close();

    const hubSid = 'hub-zero-test';
    tap.registerSession(hubSid, { cwd });
    let bound = false;
    for (let i = 0; i < 60; i++) {
      if (tap._bound.has(hubSid)) { bound = true; break; }
      await _sleep(100);
    }
    assert.ok(bound, 'must bind');

    const result = await tap.extractLatestGeminiTurn(hubSid, 0);
    assert.ok(result && result.text === 'AB', `应拿到 AB，实际=${result?.text}`);
    assert.strictEqual(result.lineCount, 2);
  } finally {
    if (fr) { try { await fr.close(); } catch {} }
    tap.unregisterSession('hub-zero-test');
    try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// === case 3: number ts 仍正常工作（向后兼容老格式）===
async function testNumberTimestampStillWorks() {
  const tmpRoot = path.join(os.tmpdir(), 'gemini-num-ts-' + Date.now());
  const cwd = 'C:\\test\\num-ts';
  const tap = new GeminiTap({ tmpRoot });

  let fr;
  try {
    fr = new FakeGeminiSession({ tmpRoot, cwd });
    await fr.start();
    const t1 = 1777892000000;
    const t2 = 1777893000000;
    await fr.writeRaw({ id: 'a', timestamp: t1, type: 'gemini', content: '老格式早期' });
    await fr.writeRaw({ id: 'b', timestamp: t2, type: 'gemini', content: '老格式当前' });
    await fr.close();

    const hubSid = 'hub-num-test';
    tap.registerSession(hubSid, { cwd });
    let bound = false;
    for (let i = 0; i < 60; i++) {
      if (tap._bound.has(hubSid)) { bound = true; break; }
      await _sleep(100);
    }
    assert.ok(bound, 'must bind');

    const result = await tap.extractLatestGeminiTurn(hubSid, t2 - 100);
    assert.ok(result && result.text === '老格式当前', `期望"老格式当前"，实际=${result?.text}`);
  } finally {
    if (fr) { try { await fr.close(); } catch {} }
    tap.unregisterSession('hub-num-test');
    try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// === runner ===
const tests = [testIsoTimestampFiltering, testZeroSinceTsReturnsAll, testNumberTimestampStillWorks];
(async () => {
  for (const t of tests) {
    try { await t(); console.log('  ✓', t.name); }
    catch (e) { console.error('  ✗', t.name); console.error('    ', e.stack || e.message); failed++; }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
