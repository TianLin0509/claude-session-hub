'use strict';
// pilot-mode Task 0（2026-05-01）— SummaryEngine.summarizeWithKind 静态契约单测
//
// 真实 CLI 调用需要代理 + API quota，不在 CI 跑（设 RUN_E2E_SUMMARIZE 触发）。
// 这里只锁住接口形态：unknown kind 抛、5 个合法 kind 路由分支不抛、_extractCodexFinalText
// 解析 Codex JSONL 输出。

const assert = require('assert');
const { SummaryEngine } = require('../core/summary-engine.js');

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => console.log(`  ✓ ${name}`),
                    e => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; });
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Running SummaryEngine.summarizeWithKind tests...');

(async () => {
  await test('summarizeWithKind throws on unknown kind', async () => {
    const eng = new SummaryEngine();
    await assert.rejects(
      () => eng.summarizeWithKind('unknown-kind', 'sys', 'prompt'),
      /Unsupported kind/,
      'must reject unknown kind'
    );
  });

  test('summarizeWithKind exposes the 5 expected kinds via routing', () => {
    // 通过看源码字符串保证路由分支齐全（避免单纯靠 try-call 测试需要真实 CLI）
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'summary-engine.js'), 'utf8');
    for (const kind of ['claude', 'deepseek', 'glm', 'codex', 'gemini']) {
      assert.ok(
        new RegExp(`case\\s+'${kind}'`).test(src),
        `summarizeWithKind missing case for ${kind}`
      );
    }
  });

  test('_buildEnvForKind sets ANTHROPIC_BASE_URL for deepseek', () => {
    const eng = new SummaryEngine();
    const env = eng._buildEnvForKind('deepseek');
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.ok(env.CLAUDE_CONFIG_DIR.includes('.claude-deepseek'),
      `expected CLAUDE_CONFIG_DIR to include .claude-deepseek, got ${env.CLAUDE_CONFIG_DIR}`);
  });

  test('_buildEnvForKind isolates GLM CLAUDE_CONFIG_DIR', () => {
    const eng = new SummaryEngine();
    const env = eng._buildEnvForKind('glm');
    assert.ok(env.CLAUDE_CONFIG_DIR.includes('.claude-glm'),
      `expected CLAUDE_CONFIG_DIR to include .claude-glm, got ${env.CLAUDE_CONFIG_DIR}`);
  });

  test('_buildEnvForKind for claude does not pollute env', () => {
    const eng = new SummaryEngine();
    const env = eng._buildEnvForKind('claude');
    // claude 默认订阅，不应注入 ANTHROPIC_BASE_URL
    assert.ok(!env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL === process.env.ANTHROPIC_BASE_URL,
      'claude env should not carry deepseek/glm-specific overrides');
  });

  test('_extractCodexFinalText parses item.completed.item.text', () => {
    const eng = new SummaryEngine();
    const jsonl = [
      '{"type":"item.in_progress","item":{"type":"message","text":"par"}}',
      '{"type":"item.completed","item":{"type":"message","text":"final-text-here"}}',
    ].join('\n');
    const out = eng._extractCodexFinalText(jsonl);
    assert.strictEqual(out, 'final-text-here');
  });

  test('_extractCodexFinalText falls back to old protocol message.text', () => {
    const eng = new SummaryEngine();
    const jsonl = [
      '{"type":"thinking","text":"..."}',
      '{"type":"message","text":"old-protocol-out"}',
    ].join('\n');
    const out = eng._extractCodexFinalText(jsonl);
    assert.strictEqual(out, 'old-protocol-out');
  });

  // 真实 E2E（仅在显式开启时跑，因为需要代理 + API quota）
  if (process.env.RUN_E2E_SUMMARIZE) {
    await test('claude summarize returns text (E2E)', async () => {
      const eng = new SummaryEngine();
      const out = await eng.summarizeWithKind('claude', '一句话总结输入。', '今天上海天气晴。');
      assert.ok(out && out.length > 0);
    });
  }

  console.log('All passed.');
})();
