'use strict';
// 2026-05-05 锁住 core/model-options.js 单一真理源的关键不变量（spec
// docs/superpowers/specs/2026-05-01-per-cli-model-picker-design.md §6.1）。
// 用于：
//   - renderer/renderer.js 单 session 顶栏 model picker
//   - 后续也会迁 renderer/meeting-create-modal.js 的圆桌创建 modal 复用同源
//
// 重点保证：
//   - 8 个 kind 都有 ≥1 个 model（防止 picker 弹空）
//   - 关键 id 在位（claude haiku/sonnet 4.6 等是用户最常切的几个，回归会被立刻发现）
//   - <kind>-resume 复用 base kind 清单（claude-resume → claude 等）
//   - canSwitchInline：claude 家族（含中转走 claude CLI 的 deepseek/glm/gpt/kimi/qwen）
//     true，codex/gemini false（PTY 不识别 inline /model）

const assert = require('assert');
const {
  MODEL_OPTIONS_BY_KIND,
  modelOptionsFor,
  canSwitchInline,
} = require('../core/model-options.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running model-options unit tests...');

test('all 8 kinds present and non-empty', () => {
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(Array.isArray(MODEL_OPTIONS_BY_KIND[k]), `${k} missing`);
    assert.ok(MODEL_OPTIONS_BY_KIND[k].length > 0, `${k} empty`);
    for (const opt of MODEL_OPTIONS_BY_KIND[k]) {
      assert.ok(opt && typeof opt.id === 'string' && opt.id.length > 0, `${k} option missing id`);
      assert.ok(typeof opt.label === 'string' && opt.label.length > 0, `${k} option missing label`);
    }
  }
});

test('claude list contains haiku-4-5 + sonnet-4-6 + opus-4-7 1m/regular', () => {
  const ids = MODEL_OPTIONS_BY_KIND.claude.map(o => o.id);
  assert.ok(ids.includes('claude-haiku-4-5'),    'haiku-4-5 missing');
  assert.ok(ids.includes('claude-sonnet-4-6'),   'sonnet-4-6 missing');
  assert.ok(ids.includes('claude-opus-4-7'),     'opus-4-7 (regular) missing');
  assert.ok(ids.includes('claude-opus-4-7[1m]'), 'opus-4-7[1m] missing');
});

test('codex list contains 5.5 / 5.4 / 5.3-codex', () => {
  const ids = MODEL_OPTIONS_BY_KIND.codex.map(o => o.id);
  assert.ok(ids.includes('gpt-5.5'));
  assert.ok(ids.includes('gpt-5.4'));
  assert.ok(ids.includes('gpt-5.3-codex'));
});

test('gpt kind (PackyAPI relay) excludes gpt-5.5 — PackyAPI 仅支持到 5.4 系列', () => {
  const ids = MODEL_OPTIONS_BY_KIND.gpt.map(o => o.id);
  assert.ok(!ids.includes('gpt-5.5'),
    `gpt-5.5 must NOT be in 'gpt' kind list (PackyAPI 不支持，只能在 'codex' kind 下用），got: ${ids.join(',')}`);
  assert.ok(ids.includes('gpt-5.4-high'), 'gpt-5.4-high should remain');
});

test('deepseek list contains v4-pro + v4-flash', () => {
  const ids = MODEL_OPTIONS_BY_KIND.deepseek.map(o => o.id);
  assert.deepStrictEqual(ids.sort(), ['deepseek-v4-flash', 'deepseek-v4-pro']);
});

test('modelOptionsFor: -resume kinds reuse base kind list', () => {
  assert.strictEqual(modelOptionsFor('claude-resume'),   MODEL_OPTIONS_BY_KIND.claude);
  assert.strictEqual(modelOptionsFor('codex-resume'),    MODEL_OPTIONS_BY_KIND.codex);
  assert.strictEqual(modelOptionsFor('gemini-resume'),   MODEL_OPTIONS_BY_KIND.gemini);
  assert.strictEqual(modelOptionsFor('deepseek-resume'), MODEL_OPTIONS_BY_KIND.deepseek);
  assert.strictEqual(modelOptionsFor('glm-resume'),      MODEL_OPTIONS_BY_KIND.glm);
});

test('modelOptionsFor: unknown / falsy kinds → empty array', () => {
  assert.deepStrictEqual(modelOptionsFor('powershell'), []);
  assert.deepStrictEqual(modelOptionsFor(undefined), []);
  assert.deepStrictEqual(modelOptionsFor(null), []);
  assert.deepStrictEqual(modelOptionsFor(''), []);
});

test('canSwitchInline: claude family (incl. relay-thru-claude-CLI) → true', () => {
  for (const k of ['claude', 'claude-resume', 'deepseek', 'deepseek-resume',
                   'glm', 'glm-resume', 'gpt', 'gpt-resume',
                   'kimi', 'kimi-resume', 'qwen', 'qwen-resume']) {
    assert.strictEqual(canSwitchInline(k), true, `${k} should support inline /model`);
  }
});

test('canSwitchInline: codex / gemini → false (PTY does not parse inline /model)', () => {
  assert.strictEqual(canSwitchInline('codex'), false);
  assert.strictEqual(canSwitchInline('codex-resume'), false);
  assert.strictEqual(canSwitchInline('gemini'), false);
  assert.strictEqual(canSwitchInline('gemini-resume'), false);
});

test('canSwitchInline: unknown / falsy → false', () => {
  assert.strictEqual(canSwitchInline('powershell'), false);
  assert.strictEqual(canSwitchInline(undefined), false);
  assert.strictEqual(canSwitchInline(null), false);
  assert.strictEqual(canSwitchInline(''), false);
});

console.log('All passed.');
