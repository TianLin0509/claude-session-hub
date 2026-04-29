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
  const m = { researchMode: false, roundtableMode: true };
  assert.strictEqual(isRoundtableCapableMeeting(m), true, 'roundtableMode=true should be capable');
  console.log('  ✓ testHelperRoundtableMode');
}

function testHelperResearchMode() {
  const m = { researchMode: true, roundtableMode: false };
  assert.strictEqual(isRoundtableCapableMeeting(m), true, 'researchMode=true should be capable');
  console.log('  ✓ testHelperResearchMode');
}

function testHelperNeitherMode() {
  const m = { researchMode: false, roundtableMode: false };
  assert.strictEqual(isRoundtableCapableMeeting(m), false, 'neither mode should be rejected');
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
  assert.strictEqual(m.roundtableMode, true, 'createMeeting default should be roundtableMode=true');
  assert.strictEqual(m.researchMode, false, 'createMeeting default should be researchMode=false');
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

function testCreateMeetingModalHtmlContract() {
  // 弹窗 UI 入口必须与 createMeeting 默认 roundtableMode=true 对齐：
  // - 通用圆桌 radio 存在且 checked；不再有 value="free"
  // - 主驾/投研 radio 仍在
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
  assert.ok(
    /name="meeting-mode"\s+value="roundtable"\s+checked/.test(html),
    'create-meeting modal must default to roundtable radio'
  );
  assert.ok(html.includes('通用圆桌'), 'roundtable label "通用圆桌" must appear');
  assert.ok(!/value="free"/.test(html), 'legacy value="free" must be removed');
  assert.ok(/value="driver"/.test(html), 'driver radio must still exist');
  assert.ok(/value="research"/.test(html), 'research radio must still exist');
  console.log('  ✓ testCreateMeetingModalHtmlContract');
}

function testRendererSubmitHasRoundtableBranch() {
  // submitCreateMeeting 必须显式处理 isRoundtableMode 分支，而不是依赖 createMeeting 隐式默认。
  // _syncMeetingModeUI 必须有 isRoundtable 描述文案。
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');
  assert.ok(/isRoundtableMode\s*=\s*meetingMode\s*===\s*'roundtable'/.test(src),
    'submitCreateMeeting must derive isRoundtableMode from radio value');
  assert.ok(/else if\s*\(isRoundtableMode\)/.test(src),
    'submitCreateMeeting must have an explicit roundtable branch');
  assert.ok(/toggle-roundtable-mode'.*enabled:\s*true/s.test(src) ||
            /'toggle-roundtable-mode'[\s\S]{0,200}enabled:\s*true/.test(src),
    'roundtable branch must invoke toggle-roundtable-mode with enabled:true');
  assert.ok(src.includes('三家平等讨论'),
    '_syncMeetingModeUI must show roundtable description');
  console.log('  ✓ testRendererSubmitHasRoundtableBranch');
}

console.log('Running roundtable dispatch mode-guard tests...');
testHelperRoundtableMode();
testHelperResearchMode();
testHelperNeitherMode();
testHelperNullMeeting();
testRealCreatedMeetingIsCapable();
testMainJsUsesHelper();
testCreateMeetingModalHtmlContract();
testRendererSubmitHasRoundtableBranch();
console.log('All passed.');
