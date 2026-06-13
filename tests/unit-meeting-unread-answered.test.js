'use strict';
// 2026-05-31 道雪：群聊侧栏"等你 N"状态机契约测试。
//
// 改动：renderer/renderer.js 的 unread 语义从"轮粒度未读计数"细化到"本轮已答 AI 数（Set<sid>.size）"。
//   - 新增 groupchat-partial-update handler：终态（completed/manual_extracted）+ turnNum 跨轮清空 Set + active 不累加
//   - selectMeeting 清空 meeting.unreadAnswered
//   - groupchat-turn-complete handler 不再做 unreadCount++
//
// renderer.js 是 IIFE 包裹的 renderer 脚本，不便 require 调内部函数。这里用契约测试（grep
//   源码）锁定关键状态机字面量不被回归。行为级验证依赖 Playwright + 真实 Hub 实例的 E2E。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'renderer.js');
const src = fs.readFileSync(SRC_PATH, 'utf-8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e.message || e));
  }
}

function extractIpcHandler(eventName) {
  const idx = src.indexOf(`ipcRenderer.on('${eventName}'`);
  if (idx < 0) return '';
  const nextIdx = src.indexOf('ipcRenderer.on(', idx + 1);
  return src.slice(idx, nextIdx > 0 ? nextIdx : idx + 4000);
}

// ---------------- 契约 1：partial-update handler 存在且只在终态累加 ----------------
test('groupchat-partial-update handler 存在且只在 completed/manual_extracted 终态累加', () => {
  const body = extractIpcHandler('groupchat-partial-update');
  assert.ok(body.length > 0, 'renderer.js 必须监听 groupchat-partial-update（侧栏 unread 聚合器）');
  // 必须显式判断 status === 'completed' || status === 'manual_extracted'
  assert.ok(/status\s*!==?\s*['"]completed['"][\s\S]{0,80}status\s*!==?\s*['"]manual_extracted['"]/.test(body)
        || /status\s*===?\s*['"]completed['"][\s\S]{0,80}status\s*===?\s*['"]manual_extracted['"]/.test(body),
    'handler 必须显式过滤终态 completed/manual_extracted —— streaming/timeout/errored 不计数');
});

// ---------------- 契约 2：partial-update handler 用 turnNum 作跨轮清零边界 ----------------
test('partial-update handler 用 turnNum 与 _lastUnreadTurnNum 比对清空 Set', () => {
  const body = extractIpcHandler('groupchat-partial-update');
  assert.ok(/_lastUnreadTurnNum/.test(body),
    'handler 必须维护 meeting._lastUnreadTurnNum 作为本轮边界标识');
  assert.ok(/unreadAnswered/.test(body),
    'handler 必须读写 meeting.unreadAnswered（Set<sid> 本轮已答集合）');
  assert.ok(/unreadAnswered[^.]*\.clear\(\)/.test(body),
    'turnNum 变化时必须 .clear() 旧 Set，否则会跨轮累积导致 N 越界');
});

// ---------------- 契约 3：active meeting 不累加（用户正看着不打扰） ----------------
test('partial-update handler active meeting 短路不累加', () => {
  const body = extractIpcHandler('groupchat-partial-update');
  assert.ok(/meetingId\s*===\s*activeMeetingId/.test(body),
    'handler 必须有 active 判断');
  // active 判断后必须 return（不能 add）
  const activeIdx = body.indexOf('meetingId === activeMeetingId');
  assert.ok(activeIdx > 0);
  // 在 active 判断之后 30 字符内必须有 return（避免误加）
  assert.ok(/return/.test(body.slice(activeIdx, activeIdx + 80)),
    'active meeting 命中后必须立即 return，不能继续 unreadAnswered.add');
});

// ---------------- 契约 4：selectMeeting 清空 unreadAnswered ----------------
test('selectMeeting 用户进群聊时清空 unreadAnswered', () => {
  // 找 selectMeeting 函数体（前 1500 字符够覆盖 cleanup 块）
  const fnIdx = src.indexOf('function selectMeeting');
  assert.ok(fnIdx > 0, 'selectMeeting 函数必须存在');
  const body = src.slice(fnIdx, fnIdx + 2000);
  assert.ok(/unreadAnswered[^.]*\.clear\(\)/.test(body),
    'selectMeeting 必须 .clear() meeting.unreadAnswered（用户进群即"已查阅"）');
});

// ---------------- 契约 5：旧 turn-complete handler 不再做 unreadCount++ ----------------
test('groupchat-turn-complete handler 不再累加 meeting.unreadCount（已被新 Set 机制取代）', () => {
  const body = extractIpcHandler('groupchat-turn-complete');
  assert.ok(body.length > 0, 'turn-complete handler 仍应存在（触发排序刷新）');
  assert.ok(!/meeting\.unreadCount\s*=\s*\(meeting\.unreadCount\s*\|\|\s*0\)\s*\+\s*1/.test(body),
    'turn-complete 不能再 unreadCount++（与本轮 Set 机制语义重叠会导致双计数）');
});

console.log('Running unit-meeting-unread-answered contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
