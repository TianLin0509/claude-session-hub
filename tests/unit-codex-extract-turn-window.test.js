'use strict';
// 2026-07-12 道雪：extractLatestTurn 轮次窗口（opts.untilTs）回归测试。
//   血泪场景：用户对第 5 轮点「重新提取」，旧实现只有 sincePromptTs 下界且被 renderer
//   传成"当前轮开始时间"——从尾向前扫 task_complete 永远命中最新轮答案，patch 回
//   第 5 轮 = 内容张冠李戴；或窗口错位提取不到 = "重新提取失败"。
//   新契约：调用方传 [该轮用户消息 ts, 下一轮用户消息 ts) 窗口，提取严格框在该轮内；
//   窗口外（下一轮）的 user_message 也不得推进 effectiveSince 下界。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FakeCodexRollout } = require('../tests/helpers/fake-codex-rollout');
const { CodexTap } = require('../core/transcript-tap');

let failed = 0;

function _tmpRoot(label) {
  return path.join(os.tmpdir(), `codex-turnwin-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _waitForBind(tap, hubSessionId, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tap._bound.has(hubSessionId)) return true;
    await _sleep(50);
  }
  return false;
}

// 两轮完整对话 fixture：turn5 提问+回答，turn6 提问+回答
async function _writeTwoTurns(fr, baseTime) {
  await fr.writeRaw({
    timestamp: new Date(baseTime.getTime() + 100).toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message: 'turn5 question' },
  });
  await fr.writeTaskComplete('turn5 answer', 500, { at: new Date(baseTime.getTime() + 200) });
  await fr.writeRaw({
    timestamp: new Date(baseTime.getTime() + 400).toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message: 'turn6 question' },
  });
  await fr.writeTaskComplete('turn6 answer', 600, { at: new Date(baseTime.getTime() + 500) });
}

// === case 1: 带 untilTs 的旧轮重提取拿到旧轮答案（不是最新轮）===
async function testOldTurnWindowExtractsOldAnswer() {
  const tmpRoot = _tmpRoot('old');
  const cwd = 'C:\\test\\proj-turnwin-old';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const baseTime = new Date();
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, startAt: baseTime });
    await fr.start();
    await _writeTwoTurns(fr, baseTime);
    await fr.close();

    const hubSid = 'hub-turnwin-old';
    tap.registerSession(hubSid, { cwd });
    assert.ok(await _waitForBind(tap, hubSid), 'must bind');

    // 窗口 = [turn5 用户消息, turn6 用户消息)
    const r = await tap.extractLatestTurn(hubSid, baseTime.getTime() + 100, { untilTs: baseTime.getTime() + 400 });
    assert.ok(r, 'must return result');
    assert.strictEqual(r.text, 'turn5 answer', `旧轮窗口应拿旧轮答案，got '${r.text}'`);
    assert.strictEqual(r.extractMode, 'final_answer');
  } finally {
    tap.unregisterSession('hub-turnwin-old');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 2: 不带 untilTs（最新轮/兼容旧调用）仍拿最新答案 ===
async function testNoUntilTsKeepsLatestBehavior() {
  const tmpRoot = _tmpRoot('latest');
  const cwd = 'C:\\test\\proj-turnwin-latest';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const baseTime = new Date();
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, startAt: baseTime });
    await fr.start();
    await _writeTwoTurns(fr, baseTime);
    await fr.close();

    const hubSid = 'hub-turnwin-latest';
    tap.registerSession(hubSid, { cwd });
    assert.ok(await _waitForBind(tap, hubSid), 'must bind');

    const r = await tap.extractLatestTurn(hubSid, 0);
    assert.ok(r, 'must return result');
    assert.strictEqual(r.text, 'turn6 answer', '无窗口上界时保持"最新轮"原行为');
    assert.strictEqual(r.extractMode, 'final_answer');
  } finally {
    tap.unregisterSession('hub-turnwin-latest');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 3: 窗口外的 user_message 不得推进 effectiveSince（否则旧轮答案被自己轮的下界挤掉）===
async function testNextTurnUserMessageDoesNotAdvanceLowerBound() {
  const tmpRoot = _tmpRoot('bound');
  const cwd = 'C:\\test\\proj-turnwin-bound';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const baseTime = new Date();
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, startAt: baseTime });
    await fr.start();
    // turn5 回答落在 turn5 提问后、turn6 提问前
    await _writeTwoTurns(fr, baseTime);
    await fr.close();

    const hubSid = 'hub-turnwin-bound';
    tap.registerSession(hubSid, { cwd });
    assert.ok(await _waitForBind(tap, hubSid), 'must bind');

    // since 从 0 开始（模拟 Hub 重启后 orchestrator 只有 createdAt 可用的宽窗口），
    // 若 turn6 的 user_message(+400) 推进了下界，turn5 answer(+200) 会被过滤 → 提取失败。
    const r = await tap.extractLatestTurn(hubSid, 0, { untilTs: baseTime.getTime() + 400 });
    assert.ok(r, 'must return result');
    assert.strictEqual(r.text, 'turn5 answer', '窗口外 user_message 不得挤掉本轮答案');
  } finally {
    tap.unregisterSession('hub-turnwin-bound');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 4: 窗口内确实没有内容 → no_task_complete_yet（不越窗拿下一轮的）===
async function testEmptyWindowStaysHonest() {
  const tmpRoot = _tmpRoot('empty');
  const cwd = 'C:\\test\\proj-turnwin-empty';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 100 });
  try {
    const baseTime = new Date();
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, startAt: baseTime });
    await fr.start();
    // turn5 只有提问没有回答；turn6 有回答
    await fr.writeRaw({
      timestamp: new Date(baseTime.getTime() + 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'turn5 question' },
    });
    await fr.writeRaw({
      timestamp: new Date(baseTime.getTime() + 400).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'turn6 question' },
    });
    await fr.writeTaskComplete('turn6 answer', 600, { at: new Date(baseTime.getTime() + 500) });
    await fr.close();

    const hubSid = 'hub-turnwin-empty';
    tap.registerSession(hubSid, { cwd });
    assert.ok(await _waitForBind(tap, hubSid), 'must bind');

    const r = await tap.extractLatestTurn(hubSid, baseTime.getTime() + 100, { untilTs: baseTime.getTime() + 400 });
    assert.ok(r, 'must return object');
    assert.strictEqual(r.extractMode, 'no_task_complete_yet', '窗口内无回答必须诚实返回空，不得越窗拿下一轮');
    assert.strictEqual(r.text || '', '');
  } finally {
    tap.unregisterSession('hub-turnwin-empty');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

const tests = [
  testOldTurnWindowExtractsOldAnswer,
  testNoUntilTsKeepsLatestBehavior,
  testNextTurnUserMessageDoesNotAdvanceLowerBound,
  testEmptyWindowStaysHonest,
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
