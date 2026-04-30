'use strict';
// 单元测试 core/general-roundtable-mode.js + general-roundtable-private-store.js
// 用 Node 内置 assert + 临时目录隔离

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const grm = require('../core/general-roundtable-mode');
const grps = require('../core/general-roundtable-private-store');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'grm-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// === RULES 内容契约 ===
function testRulesContent() {
  const r = grm.GENERAL_ROUNDTABLE_RULES_TEMPLATE;
  assert.ok(r.includes('圆桌讨论规则'), 'rules should contain title');
  assert.ok(r.includes('@debate'), 'rules should mention @debate');
  assert.ok(r.includes('@summary @<你>'), 'rules should mention @summary @<who>');
  assert.ok(r.includes('@<你> 私聊'), 'rules should mention private chat syntax');
  assert.ok(!r.includes('LinDangAgent'), 'rules MUST NOT mention LinDangAgent (general, not 投研)');
  assert.ok(!r.includes('A 股'), 'rules MUST NOT mention 投研 specifics');
  assert.ok(!r.includes('tushare'), 'rules MUST NOT mention 投研 data source');
  console.log('  ✓ testRulesContent');
}

// === 写 prompt：空 covenant 仅写 rules ===
function testWriteWithEmptyCovenant() {
  const d = tmpDir();
  const fp = grm.writeGeneralRoundtablePromptFile(d, 'meeting-A', '');
  const content = fs.readFileSync(fp, 'utf-8');
  assert.ok(content === grm.GENERAL_ROUNDTABLE_RULES_TEMPLATE, 'empty covenant: only rules');
  assert.ok(!content.includes('---'), 'no separator when covenant empty');
  console.log('  ✓ testWriteWithEmptyCovenant');
}

// === 写 prompt：非空 covenant 拼接 ===
function testWriteWithCovenant() {
  const d = tmpDir();
  const fp = grm.writeGeneralRoundtablePromptFile(d, 'meeting-B', '## 我的偏好\n喜欢简洁回答');
  const content = fs.readFileSync(fp, 'utf-8');
  assert.ok(content.includes('圆桌讨论规则'), 'has rules');
  assert.ok(content.includes('---'), 'has separator');
  assert.ok(content.includes('我的偏好'), 'has covenant');
  console.log('  ✓ testWriteWithCovenant');
}

// === covenant 读写一致 ===
function testCovenantSnapshotRoundtrip() {
  const d = tmpDir();
  grm.writeCovenantSnapshot(d, 'meeting-C', '我的红线：禁止套模板');
  const r = grm.readCovenantSnapshot(d, 'meeting-C');
  assert.strictEqual(r, '我的红线：禁止套模板');
  console.log('  ✓ testCovenantSnapshotRoundtrip');
}

// === 读不存在的 covenant 返回 null ===
function testReadMissingCovenant() {
  const d = tmpDir();
  assert.strictEqual(grm.readCovenantSnapshot(d, 'never-existed'), null);
  console.log('  ✓ testReadMissingCovenant');
}

// === cleanup 清掉本会议室所有文件 ===
function testCleanup() {
  const d = tmpDir();
  grm.writeGeneralRoundtablePromptFile(d, 'meeting-D', 'x');
  grm.writeCovenantSnapshot(d, 'meeting-D', 'x');
  grps.appendPrivateTurn(d, 'meeting-D', 'claude', 'q', 'a');
  // 别的 meeting 不该被清掉
  grm.writeGeneralRoundtablePromptFile(d, 'meeting-E', 'y');

  grm.cleanupGeneralRoundtableFiles(d, 'meeting-D');

  const promptDir = path.join(d, 'arena-prompts');
  assert.ok(!fs.existsSync(path.join(promptDir, 'meeting-D-roundtable.md')));
  assert.ok(!fs.existsSync(path.join(promptDir, 'meeting-D-roundtable-covenant.md')));
  assert.ok(!fs.existsSync(path.join(promptDir, 'meeting-D-roundtable-private.json')));
  assert.ok(fs.existsSync(path.join(promptDir, 'meeting-E-roundtable.md')), 'sibling meeting untouched');
  console.log('  ✓ testCleanup');
}

// === 私聊存储：append + list ===
function testPrivateAppendList() {
  const d = tmpDir();
  grps.appendPrivateTurn(d, 'meeting-F', 'claude', 'hi', 'hello');
  grps.appendPrivateTurn(d, 'meeting-F', 'claude', 'q2', 'a2');
  grps.appendPrivateTurn(d, 'meeting-F', 'gemini', 'q3', 'a3');
  const all = grps.listPrivateTurns(d, 'meeting-F');
  assert.strictEqual(all.claude.length, 2);
  assert.strictEqual(all.gemini.length, 1);
  assert.strictEqual(all.codex.length, 0);
  assert.strictEqual(all.claude[0].userInput, 'hi');
  assert.strictEqual(all.claude[1].response, 'a2');
  console.log('  ✓ testPrivateAppendList');
}

// === 私聊存储：非法 kind 抛错 ===
function testPrivateInvalidKind() {
  const d = tmpDir();
  assert.throws(() => grps.appendPrivateTurn(d, 'm', 'unknown', 'q', 'a'), /invalid kind/);
  console.log('  ✓ testPrivateInvalidKind');
}

// === 私聊存储：超出软上限截断 ===
function testPrivateSoftCap() {
  const d = tmpDir();
  for (let i = 0; i < grps.MAX_PRIVATE_TURNS_PER_KIND + 5; i++) {
    grps.appendPrivateTurn(d, 'm', 'claude', `q${i}`, `a${i}`);
  }
  const list = grps.listPrivateTurns(d, 'm', 'claude');
  assert.strictEqual(list.length, grps.MAX_PRIVATE_TURNS_PER_KIND);
  // 最早的应被截断，最晚的保留
  assert.strictEqual(list[list.length - 1].userInput, `q${grps.MAX_PRIVATE_TURNS_PER_KIND + 4}`);
  console.log('  ✓ testPrivateSoftCap');
}

// === meeting-room: updateMeeting 三态互斥 loud-fail ===
function testUpdateMeetingMutexLoudFail() {
  const { MeetingRoomManager } = require('../core/meeting-room.js');
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();

  // 同时传两个 true → 应抛错
  assert.throws(
    () => mgr.updateMeeting(m.id, { roundtableMode: true, researchMode: true }),
    /Cannot set multiple modes to true simultaneously/
  );
  console.log('  ✓ testUpdateMeetingMutexLoudFail');
}

// === meeting-room: 单个 true 时互斥关闭另一个（合法路径） ===
function testUpdateMeetingMutexHappyPath() {
  const { MeetingRoomManager } = require('../core/meeting-room.js');
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();

  // 默认 roundtableMode=true
  assert.strictEqual(m.roundtableMode, true);
  assert.strictEqual(m.researchMode, false);

  // 切到 researchMode → 关掉 roundtableMode
  const r1 = mgr.updateMeeting(m.id, { researchMode: true });
  assert.strictEqual(r1.researchMode, true);
  assert.strictEqual(r1.roundtableMode, false);

  // 切回 roundtableMode → 关掉 researchMode
  const r2 = mgr.updateMeeting(m.id, { roundtableMode: true });
  assert.strictEqual(r2.roundtableMode, true);
  assert.strictEqual(r2.researchMode, false);

  console.log('  ✓ testUpdateMeetingMutexHappyPath');
}

console.log('Running general-roundtable unit tests...');
testRulesContent();
testWriteWithEmptyCovenant();
testWriteWithCovenant();
testCovenantSnapshotRoundtrip();
testReadMissingCovenant();
testCleanup();
testPrivateAppendList();
testPrivateInvalidKind();
testPrivateSoftCap();
testUpdateMeetingMutexLoudFail();
testUpdateMeetingMutexHappyPath();
console.log('All passed.');
