'use strict';
// 锁定 paste-trapped-detector 三层判定（2026-05-05 道雪）。
//
// 三层 AND：时间门 3s + marker 连续 2 次同 N + 持续 ≥3s + activity 涨 <200 字节。
// 任一不满足 → 'unknown' 或 'ok'，不报 'stuck'。

const assert = require('assert');
const detector = require('../core/paste-trapped-detector.js');

function test(name, fn) {
  try {
    detector._resetAll();
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

console.log('Running paste-trapped-detector tests...');

// === 正则覆盖三家 paste marker ===
test('PASTE_MARKER_REGEX 识别 codex "[[Pasted Content 4834 chars]]"', () => {
  const m = detector.PASTE_MARKER_REGEX.exec('blah\n  [[Pasted Content 4834 chars]]\n  prompt>');
  assert.ok(m, 'regex 应命中');
  assert.strictEqual(m[1], '4834');
});

test('PASTE_MARKER_REGEX 识别 claude "[Pasted text +120 lines]"', () => {
  const m = detector.PASTE_MARKER_REGEX.exec('> [Pasted text +120 lines]\n');
  assert.ok(m);
  assert.strictEqual(m[1], '120');
});

test('PASTE_MARKER_REGEX 识别 gemini "[Pasted +30 lines]"', () => {
  const m = detector.PASTE_MARKER_REGEX.exec('│ [Pasted +30 lines] │');
  assert.ok(m);
  assert.strictEqual(m[1], '30');
});

test('PASTE_MARKER_REGEX 识别 codex 简写小写 "[paste 42 lines]"', () => {
  const m = detector.PASTE_MARKER_REGEX.exec('> [paste 42 lines]');
  assert.ok(m);
  assert.strictEqual(m[1], '42');
});

test('PASTE_MARKER_REGEX 不误命中无 paste 的字符', () => {
  const m = detector.PASTE_MARKER_REGEX.exec('Context 100% left · gpt-5.5');
  assert.strictEqual(m, null);
});

// === 时间门 ===
test('时间门：dispatch 后 < 3s tick 一律 unknown（即使 marker 在）', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 1000);  // 1s 前 dispatch
  const r = detector.tick(sid, '> [[Pasted Content 100 chars]]', 1000);
  assert.strictEqual(r, 'unknown', '3s 内应永远 unknown');
});

// === 没 marker → ok ===
test('3s 后无 marker → ok（streaming 中 / 已提交）', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 4000);
  const r = detector.tick(sid, 'normal streaming output...', 5000);
  assert.strictEqual(r, 'ok');
});

// === marker 第 1 次出现 → unknown，不立即报 ===
test('3s 后 marker 第 1 次看到 → unknown（建立基线，等下一次确认）', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 4000);
  const r = detector.tick(sid, '> [[Pasted Content 4000 chars]]', 100);
  assert.strictEqual(r, 'unknown');
});

// === 三层全满足 → stuck ===
test('三层全满足：marker 连续 2 次同 N + 持续 ≥3s + activity 涨 <200 → stuck', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 7000);
  const buf = '> [[Pasted Content 4834 chars]]\n  gpt-5.5 medium · Context 100%';
  // 第 1 次：建基线
  let r = detector.tick(sid, buf, 100);
  assert.strictEqual(r, 'unknown');

  // 通过 _injectEntry 模拟 markerFirstSeenTs 是 4s 前（满足 obsDuration ≥ 3s）
  detector._injectEntry(sid, { markerFirstSeenTs: Date.now() - 4000 });

  // 第 2 次：N 同，计数=2 + obsDuration 4s + activity 涨幅 (150-100)=50 < 200 → stuck
  r = detector.tick(sid, buf, 150);
  assert.strictEqual(r, 'stuck', '第 2 次：三层全满足 stuck');
});

// === 计数够但 streaming 中（activity 涨幅 ≥ 200）→ 不报 stuck ===
test('marker 持续 2 次 + 3s 但 activity 涨幅 ≥200 → 仍 unknown（streaming 慢，非 stuck）', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 7000);
  const buf = '> [[Pasted Content 1000 chars]]';
  detector.tick(sid, buf, 1000);  // 基线 activity=1000
  detector._injectEntry(sid, { markerFirstSeenTs: Date.now() - 4000 });
  // activity 从 1000 涨到 1500（+500，超过 MAX=200）→ 即使其他条件满足，仍 unknown
  const r = detector.tick(sid, buf, 1500);
  assert.strictEqual(r, 'unknown', '活动涨幅大说明 streaming 中，不是真 stuck');
});

// === 持续时间不够（< 3s） → 不报 stuck ===
test('marker 连续 2 次但持续 < 3s → unknown', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 7000);
  const buf = '> [[Pasted Content 100 chars]]';
  detector.tick(sid, buf, 100);
  // markerFirstSeenTs 不调（保持现在），后续 tick 间隔 ms 级，obsDuration 不到 3s
  const r = detector.tick(sid, buf, 120);
  assert.strictEqual(r, 'unknown', '持续不到 3s 不报 stuck');
});

// === N 变了 → 重置基线（unknown） ===
test('marker N 变化 → 重置基线，不报 stuck', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 7000);
  detector.tick(sid, '> [[Pasted Content 1000 chars]]', 100);
  const r = detector.tick(sid, '> [[Pasted Content 5000 chars]]', 100);  // N 变了
  assert.strictEqual(r, 'unknown', 'N 变化 → 重置');
});

// === stop 后 tick 一律 unknown ===
test('stop 后 tick 返回 unknown（entry 已清理）', () => {
  const sid = 'sid-A';
  detector.start(sid, Date.now() - 20000);
  detector.tick(sid, '> [[Pasted Content 100 chars]]', 100);
  detector.stop(sid);
  const r = detector.tick(sid, '> [[Pasted Content 100 chars]]', 100);
  assert.strictEqual(r, 'unknown');
});

// === 未 start 就 tick → unknown ===
test('未 start 就 tick → unknown', () => {
  const r = detector.tick('sid-NEVER', 'whatever', 0);
  assert.strictEqual(r, 'unknown');
});

console.log('\n✓ paste-trapped-detector: tests done\n');
