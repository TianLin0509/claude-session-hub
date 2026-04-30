'use strict';
// 锁住 dispatchRoundtableTurn 的 mode guard：
// - roundtableMode=true 的会议必须能进入调度（不是 'not roundtable-capable mode'）
// - researchMode=true 的会议必须能进入调度（投研路径不回归）
// - 两者都 false 的会议必须被拒
//
// 背景：main.js 第 896 行 guard 历史上只允许 researchMode，导致默认 roundtableMode=true
// 的新会议被后端拒绝。修复方式：把 guard 抽成 core/meeting-room.js 的 isRoundtableCapableMeeting
// 纯函数，main.js 引用它。本测试两路盯住：
//  1) 直接单测 helper 行为
//  2) grep main.js 确认 dispatchRoundtableTurn 调用 helper、且不回退到 'not research mode' 文案

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { MeetingRoomManager, isRoundtableCapableMeeting } = require('../core/meeting-room');

function testHelperRoundtableMode() {
  const m = { scene: 'general' };
  assert.strictEqual(isRoundtableCapableMeeting(m), true, 'scene=general should be capable');
  console.log('  ✓ testHelperRoundtableMode');
}

function testHelperResearchMode() {
  const m = { scene: 'research' };
  assert.strictEqual(isRoundtableCapableMeeting(m), true, 'scene=research should be capable');
  console.log('  ✓ testHelperResearchMode');
}

function testHelperNeitherMode() {
  const m = {};
  assert.strictEqual(isRoundtableCapableMeeting(m), false, 'no scene should be rejected');
  console.log('  ✓ testHelperNeitherMode');
}

function testHelperNullMeeting() {
  assert.strictEqual(isRoundtableCapableMeeting(null), false, 'null meeting should be rejected');
  assert.strictEqual(isRoundtableCapableMeeting(undefined), false, 'undefined meeting should be rejected');
  console.log('  ✓ testHelperNullMeeting');
}

function testRealCreatedMeetingIsCapable() {
  // 通过 createMeeting 真实构造一个 meeting，确认默认字段下 helper 返回 true。
  // 这条断言把"createMeeting 默认字段"和"dispatchRoundtableTurn guard"绑在一起：
  // 任何一方漂移都会让本测试挂掉。
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();
  assert.strictEqual(m.scene, 'general', 'createMeeting default should be scene=general');
  assert.strictEqual(isRoundtableCapableMeeting(m), true, 'default-created meeting must be roundtable-capable');
  console.log('  ✓ testRealCreatedMeetingIsCapable');
}

function testMainJsUsesHelper() {
  // main.js 必须在 dispatchRoundtableTurn 里引用 isRoundtableCapableMeeting，
  // 且不再返回旧的 'not research mode' reason；只允许新文案 'not roundtable-capable mode'。
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  assert.ok(
    mainSrc.includes('isRoundtableCapableMeeting'),
    'main.js must import and use isRoundtableCapableMeeting'
  );
  // 只针对 dispatchRoundtableTurn：旧文案是 `reason: 'not research mode'` 这种带 reason key 的写法。
  // 注意 main.js 的 HTTP isResearchFetch 路径里 `'{"error":"not research mode"}'` 是合法保留的（投研专属
  // MCP loopback，与 roundtable 调度无关），不能误伤。
  assert.ok(
    !/reason:\s*'not research mode'/.test(mainSrc),
    "dispatchRoundtableTurn must not return reason 'not research mode' anymore"
  );
  assert.ok(
    /reason:\s*'not roundtable-capable mode'/.test(mainSrc),
    "dispatchRoundtableTurn must use new reason 'not roundtable-capable mode'"
  );
  console.log('  ✓ testMainJsUsesHelper');
}

function testCreateMeetingMenuContract() {
  // +号菜单必须有 general 入口（后续 Task 5 会合并为单入口）；
  // 老的 #create-meeting-modal 已废弃,不再出现在 HTML 中。
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
  assert.ok(/data-meeting-mode="general"/.test(html), 'menu must have general mode entry');
  assert.ok(!/data-meeting-mode="driver"/.test(html), 'driver mode entry must be removed');
  assert.ok(html.includes('通用圆桌'), 'menu label "通用圆桌" must appear');
  assert.ok(!html.includes('主驾会议'), 'legacy "主驾会议" label must be removed');
  assert.ok(!/id="create-meeting-modal"/.test(html), 'legacy create-meeting modal must be removed');
  console.log('  ✓ testCreateMeetingMenuContract');
}

function testRendererCreateMeetingByMode() {
  // createMeetingByMode 必须存在并通过 IPC 创建会议。
  // 后续 Task 5 会简化这个函数,这里只检查核心契约。
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');
  assert.ok(/async function createMeetingByMode\s*\(\s*mode\s*\)/.test(src),
    'createMeetingByMode function must exist');
  assert.ok(/invoke\(['"]create-meeting['"]\s*,\s*\{\s*mode\s*\}/.test(src),
    'createMeetingByMode must invoke create-meeting IPC with {mode}');
  assert.ok(!/mode\s*===\s*['"]driver['"]/.test(src),
    'driver branch must be removed (driver mode deprecated)');
  console.log('  ✓ testRendererCreateMeetingByMode');
}

console.log('Running roundtable dispatch mode-guard tests...');
testHelperRoundtableMode();
testHelperResearchMode();
testHelperNeitherMode();
testHelperNullMeeting();
testRealCreatedMeetingIsCapable();
testMainJsUsesHelper();
testCreateMeetingMenuContract();
testRendererCreateMeetingByMode();
console.log('All passed.');
