'use strict';
// pilot redesign 单元测试（2026-05-02）—— dispatchMode + pilot redesign 契约
//
// 覆盖：
//   1. meeting 默认字段：dispatchMode='all'
//   2. setPilotSlot 自动 reset dispatchMode='all'
//   3. setDispatchMode 校验：mode ∈ {all,pilot,observer}；非 'all' 要求 pilotSlot !== null
//   4. 旧数据迁移：restoreMeeting 无 dispatchMode + pilotSlot=2 → 'pilot'；pilotSlot=null → 'all'
//   5. meeting-store 持久化往返：dispatchMode 序列化/反序列化
//   6. core/roundtable-orchestrator.js 不再 export findLatestPilotRecap / _maybePilotRecapPrefix
//   7. main.js 不再 require general-roundtable-private-store / pilot-recap-builder

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { MeetingRoomManager } = require('../core/meeting-room');
const meetingStore = require('../core/meeting-store');

let passed = 0;
function ok(label) { console.log('  ✓ ' + label); passed++; }

function testDefaultDispatchMode() {
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();
  assert.strictEqual(m.pilotSlot, null, 'default pilotSlot null');
  assert.strictEqual(m.dispatchMode, 'all', "default dispatchMode 'all'");
  ok('createMeeting defaults: pilotSlot=null, dispatchMode=all');
}

function testSetPilotSlotResetsDispatchMode() {
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();
  // 先选定主驾 + 切到 pilot 模式
  mgr.setPilotSlot(m.id, 1);
  mgr.setDispatchMode(m.id, 'pilot');
  let cur = mgr.getMeeting(m.id);
  assert.strictEqual(cur.pilotSlot, 1, 'pilotSlot=1');
  assert.strictEqual(cur.dispatchMode, 'pilot', 'dispatchMode=pilot');
  // 切主驾（1 → 2）→ dispatchMode 自动 reset 'all'
  mgr.setPilotSlot(m.id, 2);
  cur = mgr.getMeeting(m.id);
  assert.strictEqual(cur.pilotSlot, 2, 'pilotSlot=2 after switch');
  assert.strictEqual(cur.dispatchMode, 'all', 'dispatchMode reset to all on slot switch');
  // 取消主驾 → dispatchMode 仍 'all'
  mgr.setPilotSlot(m.id, null);
  cur = mgr.getMeeting(m.id);
  assert.strictEqual(cur.pilotSlot, null, 'pilotSlot=null');
  assert.strictEqual(cur.dispatchMode, 'all', 'dispatchMode all on cancel');
  ok('setPilotSlot resets dispatchMode to all (switch + cancel)');
}

function testSetDispatchModeValidation() {
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();
  // 无主驾时 dispatchMode='pilot' / 'observer' 应抛错
  assert.throws(() => mgr.setDispatchMode(m.id, 'pilot'), /requires pilotSlot/);
  assert.throws(() => mgr.setDispatchMode(m.id, 'observer'), /requires pilotSlot/);
  // 'all' 在无主驾时也允许
  mgr.setDispatchMode(m.id, 'all');
  // 选主驾后 'pilot' / 'observer' 都允许
  mgr.setPilotSlot(m.id, 0);
  mgr.setDispatchMode(m.id, 'pilot');
  assert.strictEqual(mgr.getMeeting(m.id).dispatchMode, 'pilot');
  mgr.setDispatchMode(m.id, 'observer');
  assert.strictEqual(mgr.getMeeting(m.id).dispatchMode, 'observer');
  // 非法 mode 抛错
  assert.throws(() => mgr.setDispatchMode(m.id, 'random'), /Invalid dispatchMode/);
  ok('setDispatchMode validation (no-pilot reject + valid + invalid mode)');
}

function testRestoreMeetingMigration() {
  const mgr = new MeetingRoomManager();
  // 旧数据：pilotSlot=2，无 dispatchMode 字段 → 推断 'pilot'
  mgr.restoreMeeting({
    id: 'old-1', title: 'old1', pilotSlot: 2, scene: 'general',
  });
  const r1 = mgr.getMeeting('old-1');
  assert.strictEqual(r1.pilotSlot, 2);
  assert.strictEqual(r1.dispatchMode, 'pilot', "old pilotSlot=2 → dispatchMode='pilot'");
  // 旧数据：pilotSlot=null（或缺失），无 dispatchMode → 'all'
  mgr.restoreMeeting({ id: 'old-2', title: 'old2', scene: 'general' });
  const r2 = mgr.getMeeting('old-2');
  assert.strictEqual(r2.pilotSlot, null);
  assert.strictEqual(r2.dispatchMode, 'all', 'no pilotSlot → all');
  // 新数据：dispatchMode 字段直接生效
  mgr.restoreMeeting({
    id: 'new-1', title: 'new1', pilotSlot: 1, dispatchMode: 'observer', scene: 'general',
  });
  const r3 = mgr.getMeeting('new-1');
  assert.strictEqual(r3.dispatchMode, 'observer', 'explicit dispatchMode preserved');
  ok('restoreMeeting migration (legacy pilotSlot → pilot + new field preserved)');
}

function testMeetingStorePersistence() {
  // saveMeetingFile + loadMeetingFile 往返
  const tmpDir = path.join(require('os').tmpdir(), `hub-test-dispatch-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.CLAUDE_HUB_DATA_DIR_OVERRIDE = tmpDir;
  // saveMeetingFile 用 getHubDataDir，但模块缓存了——直接调内部接口
  // 简化：调 saveMeetingFile + loadMeetingFile，内部走 getHubDataDir
  // 这里只验签：序列化对象包含 dispatchMode 字段
  const data = {
    _timeline: [],
    _cursors: {},
    _nextIdx: 0,
    slotSpecs: null,
    pilotSlot: 1,
    dispatchMode: 'observer',
  };
  // 使用一个独立 id 避免污染 hubDataDir
  const id = 'test-dispatch-' + Date.now();
  meetingStore.saveMeetingFile(id, data);
  const loaded = meetingStore.loadMeetingFile(id);
  assert.ok(loaded, 'meeting file loaded');
  assert.strictEqual(loaded.pilotSlot, 1);
  assert.strictEqual(loaded.dispatchMode, 'observer');
  meetingStore.deleteMeetingFile(id);
  // 默认值兜底：data 缺 dispatchMode → 落盘默认 'all'
  meetingStore.saveMeetingFile(id, { _timeline: [], _cursors: {}, _nextIdx: 0, slotSpecs: null, pilotSlot: null });
  const loaded2 = meetingStore.loadMeetingFile(id);
  assert.strictEqual(loaded2.dispatchMode, 'all', "missing dispatchMode → default 'all'");
  meetingStore.deleteMeetingFile(id);
  ok('meetingStore persists dispatchMode (round-trip + default fallback)');
}

function testNoDeadExportsInOrchestrator() {
  // core/roundtable-orchestrator.js 不应再 export findLatestPilotRecap / _maybePilotRecapPrefix
  const orch = require('../core/roundtable-orchestrator');
  assert.strictEqual(orch.findLatestPilotRecap, undefined, 'findLatestPilotRecap not exported');
  assert.strictEqual(orch._maybePilotRecapPrefix, undefined, '_maybePilotRecapPrefix not exported');
  // 而 RoundtableOrchestrator 类必须仍然 export
  assert.strictEqual(typeof orch.RoundtableOrchestrator, 'function');
  ok('roundtable-orchestrator: pilot-recap exports cleaned, RoundtableOrchestrator preserved');
}

function testNoPilotInfraInMain() {
  // main.js 不应再引用已删除的 module / 函数
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const forbidden = [
    "require('./core/general-roundtable-private-store')",
    "require('./core/pilot-recap-builder')",
    'appendPrivateTurnBySid',
    'listPrivateTurnsBySid',
    'clearPrivateTurnsBySid',
    "ipcMain.handle('roundtable-private:append'",
    "ipcMain.handle('roundtable-private:list'",
    "ipcMain.handle('roundtable:pilot-segment-mode'",
  ];
  for (const f of forbidden) {
    assert.ok(!mainSrc.includes(f), `main.js must not contain "${f}"`);
  }
  // 必须包含新 IPC + dispatchMode 路由
  assert.ok(mainSrc.includes("ipcMain.handle('roundtable:dispatch-mode-set'"),
    'main.js must register dispatch-mode-set IPC');
  assert.ok(mainSrc.includes('dispatchModeByMeeting'),
    'main.js must persist dispatchModeByMeeting');
  ok('main.js cleaned (no pilot infra) + dispatch-mode IPC wired');
}

function testNoPilotPrivateUiInRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf-8');
  const forbidden = [
    'rt-private',
    "ipcRenderer.invoke('roundtable-private:list'",
    "ipcRenderer.invoke('roundtable-private:append'",
    'function _renderPilotRecapsHtml',
    'function _renderPilotRecapEntry',
    'function _bindPilotRecapEvents',
    'function _updatePilotPlaceholder',
    '主驾对话进行中',
    'pilot-locked',
    'pilot-observer',
  ];
  for (const f of forbidden) {
    // 排除注释里的提及（注释里说"已废弃"是允许的）
    const codeOnly = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!codeOnly.includes(f), `renderer code must not contain "${f}"`);
  }
  // 必须包含新 segmented control + 状态行 + dispatchMode IPC 调用
  assert.ok(src.includes('mr-rt-dispatch-group'), 'segmented control present');
  assert.ok(src.includes('mr-status-line'), 'status line present');
  assert.ok(src.includes("ipcRenderer.invoke('roundtable:dispatch-mode-set'"),
    'dispatch-mode-set IPC invoke present');
  assert.ok(src.includes('pilot-role'), 'pilot-role visual class present');
  assert.ok(src.includes('dispatch-active'), 'dispatch-active visual class present');
  ok('renderer cleaned (no pilot recap UI) + new dispatch UI wired');
}

console.log('Running pilot-redesign / dispatchMode tests...');
testDefaultDispatchMode();
testSetPilotSlotResetsDispatchMode();
testSetDispatchModeValidation();
testRestoreMeetingMigration();
testMeetingStorePersistence();
testNoDeadExportsInOrchestrator();
testNoPilotInfraInMain();
testNoPilotPrivateUiInRenderer();
console.log(`\nAll passed (${passed}/8).`);
