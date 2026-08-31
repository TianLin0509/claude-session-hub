'use strict';
// AI 群聊「运行中也能操作」契约测试（2026-07-29 道雪）
//
// 行为在 unit-groupchat-live-ops.test.js 里真跑；这里锁住**不能被悄悄改回去**的几条源码契约：
//   1. 运行中不得禁用成员勾选（用户血泪：一位 AI 在思考，整排头像全灰）
//   2. 运行中不得拦截发送（追加提问是能力，不是错误）
//   3. 必须有明确的「停止本轮」入口，且走 groupchat:interrupt IPC
//   4. 'interrupted' 必须进"已结算"判定，且不进 patch 窗口（防永久思考中 / 迟到内容回填）
//   5. 串行 / 循环工作流被接管时必须停，不得继续往下一步跑

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const rendererSrc = read('renderer', 'meeting-room.js');
const dispatcherSrc = read('main', 'groupchat', 'dispatcher.js');
const watcherSrc = read('core', 'turn-completion-watcher.js');
const loopSrc = read('main', 'groupchat', 'loop-engine.js');
const turnIpcSrc = read('main', 'ipc', 'groupchat-turn-handlers.js');
const mainSrc = read('main.js');
const cssSrc = read('renderer', 'styles', 'meeting-room-toolbar-input.css');

// --- 1. 运行中不禁用成员勾选 -------------------------------------------------
assert.ok(!/const disabledAttr = \(inProgress \|\| isDormant0\) \? 'disabled' : ''/.test(rendererSrc),
  '成员勾选不得再因「本轮进行中」而禁用（这正是用户说的"UI 都是灰的"）');
assert.ok(/const disabledAttr = isDormant0 \? 'disabled' : ''/.test(rendererSrc),
  '成员勾选只对休眠成员禁用（后端本就跳过 dormant）');
assert.ok(/改选只影响下一轮/.test(rendererSrc),
  '运行中勾选应给出「只影响下一轮」的提示，而不是禁用');

// --- 2. 运行中不拦截发送 -----------------------------------------------------
const doSendBody = rendererSrc.slice(rendererSrc.indexOf('const doSend = () => {'));
const doSendSlice = doSendBody.slice(0, doSendBody.indexOf('sendBtn.addEventListener'));
assert.ok(doSendSlice.length > 200, 'doSend 片段定位失败');
assert.ok(!/_isGroupTurnBusy\s*\(/.test(doSendSlice),
  'doSend 不得用 _isGroupTurnBusy 拦截运行中的追加提问');
assert.ok(!/_isGroupTurnRunning\s*\([\s\S]{0,80}\)\s*\)\s*\{[\s\S]{0,120}return;/.test(doSendSlice),
  'doSend 不得因"本轮进行中"提前 return');
// sendBtn.disabled 只允许被时光机 / 0 人勾选两种场景设置
const disabledAssignments = rendererSrc.match(/sendBtn\.disabled\s*=\s*[^;]+;/g) || [];
assert.ok(disabledAssignments.length > 0, '应存在 sendBtn.disabled 赋值');
for (const line of disabledAssignments) {
  assert.ok(/isTT|true|false/.test(line),
    `sendBtn.disabled 赋值只允许来自时光机 / 0 人勾选保护，发现可疑赋值：${line}`);
  assert.ok(!/inProgress|currentMode|busy|Running/i.test(line),
    `sendBtn.disabled 不得跟"运行中"绑定：${line}`);
}

// --- 3. 「停止本轮」入口 -----------------------------------------------------
assert.ok(/data-gc-stop-turn="1"/.test(rendererSrc), '作战面板必须渲染「停止本轮」入口 chip');
assert.ok(/function _isGroupTurnRunning\(meeting\)/.test(rendererSrc), '需要 _isGroupTurnRunning 判定入口显隐');
assert.ok(/_isGroupTurnRunning\(current\)/.test(rendererSrc), '停止入口应按本轮是否在跑显隐');
assert.ok(/async function _handleGcStopTurn\(meeting\)/.test(rendererSrc), '需要 _handleGcStopTurn 处理停止');
assert.ok(/ipcRenderer\.invoke\('groupchat:interrupt',\s*\{\s*meetingId:\s*m\.id\s*\}\)/.test(rendererSrc),
  '停止本轮必须走 groupchat:interrupt IPC');
assert.ok(/querySelector\('\[data-gc-stop-turn\]'\)/.test(rendererSrc), '停止 chip 必须真正绑定 click');
assert.ok(/\.mr-input-preflight-chip\.stop\s*\{/.test(cssSrc), '停止 chip 需要独立视觉样式');

// --- 4. interrupted 状态语义 -------------------------------------------------
assert.ok(/interrupt\(text = '', reason = 'user_interrupt'\)/.test(watcherSrc),
  'watcher 必须提供 interrupt(text, reason) —— 中断保留已生成的半截文本');
assert.ok(/status: 'interrupted'/.test(watcherSrc), 'interrupt 应结算为 interrupted 状态');
const patchableLine = (watcherSrc.match(/const PATCHABLE_STATUSES = new Set\(\[[^\]]*\]\)/) || [''])[0];
assert.ok(patchableLine && !/interrupted/.test(patchableLine),
  'interrupted 不得进 patch 窗口（否则 CLI 迟到的收尾内容会回填已被叫停的记录）');

assert.ok(/const _GC_SETTLED_NO_ANSWER = new Set\(\[[^\]]*'interrupted'[^\]]*\]\)/.test(rendererSrc),
  'renderer 的"已结算"集合必须包含 interrupted');
assert.ok(/function _isGcSettledStatus\(status\)/.test(rendererSrc), '需要集中的 _isGcSettledStatus 判定');
// pending 判定必须走集中判定，不许再散落硬编码列表（漏一个就是永久思考中）
assert.ok(!/const settledPending = status === 'errored' \|\| status === 'absent' \|\| status === 'superseded';/.test(rendererSrc),
  'pending 判定不得再硬编码状态列表，必须用 _isGcSettledStatus');
assert.ok((rendererSrc.match(/const settledPending = _isGcSettledStatus\(status\);/g) || []).length >= 2,
  '两处 pending 渲染路径（整体渲染 + 局部 patch）都要用集中判定');
assert.ok(/} else if \(partial\.status === 'interrupted'\) \{/.test(rendererSrc),
  '卡片渲染必须显式处理 partial.status === interrupted（否则会落进 else 被当成 completed）');
assert.ok(/} else if \(lastStatus === 'interrupted'\) \{/.test(rendererSrc),
  '历史轮渲染必须显式处理 byStatus === interrupted');
assert.ok(/_SETTLED_STATUSES = new Set\(\[[^\]]*'interrupted'[^\]]*\]\)/.test(rendererSrc),
  '推进解锁判定同样要认 interrupted');

// --- 5. dispatcher / IPC / 工作流 --------------------------------------------
assert.ok(/const INTERRUPT_KEY = '\\x1b'/.test(dispatcherSrc),
  '中断键必须是 ESC —— 与用户在单 session 终端里按 ESC 完全同一条路径');
assert.ok(/function interruptMeetingTurn\(meetingId, opts = \{\}\)/.test(dispatcherSrc),
  'dispatcher 必须提供 interruptMeetingTurn');
assert.ok(/watcher\.interrupt\(partialText, reason\)/.test(dispatcherSrc),
  '中断应先结算 watcher（状态先收敛，不依赖 CLI 是否回吐 stop 信号）');
assert.ok(/sessionManager\.writeToSession\(sid, INTERRUPT_KEY\)/.test(dispatcherSrc),
  '中断应真的向 PTY 写 ESC，让 CLI 停下别继续烧 token');
assert.ok(/const meetingInterruptSeq = new Map\(\)/.test(dispatcherSrc)
  && /interruptedSinceStart\(\)/.test(dispatcherSrc),
  '必须有中断代际，关掉「sendToPty 期间点停止」的竞态窗口（否则又是永久思考中）');
assert.ok(/orch\.clearTurnInProgress\(turnNum\)/.test(dispatcherSrc),
  '没有 watcher 可停时也要把 orchestrator 收回 idle（兜底收敛）');
assert.ok(/return \{ status: 'completed', turnNum, results, meta, superseded: wasSuperseded, interrupted: wasInterrupted \};/.test(dispatcherSrc),
  'dispatchGroupChatTurn 返回值必须带 superseded / interrupted，供工作流判定用户接管');
assert.ok(/interruptMeetingTurn,/.test(dispatcherSrc), 'dispatcher 必须导出 interruptMeetingTurn');

assert.ok(/ipcMain\.handle\('groupchat:interrupt'/.test(turnIpcSrc), '必须注册 groupchat:interrupt IPC');
assert.ok(/stopLoop\(args\.meetingId, \{ interrupt: false \}\)/.test(turnIpcSrc), '停止本轮应先标记工作流停止，再由统一群聊中断路径发 ESC');
assert.ok(/interruptGroupChatTurn: groupChatDispatcher\.interruptMeetingTurn/.test(mainSrc),
  'main.js 必须把 dispatcher 的中断能力接进 IPC');
assert.ok(/stopLoop: \(meetingId, options\) => \(global\.__loopEngine \? global\.__loopEngine\.stopLoop\(meetingId, options\) : false\)/.test(mainSrc),
  'main.js 必须把 loopEngine.stopLoop 接进中断 IPC');

assert.ok(/if \(bRes\.interrupted \|\| bRes\.superseded\)/.test(loopSrc)
  && /if \(rRes\.interrupted \|\| rRes\.superseded\)/.test(loopSrc),
  'loop-engine 的 builder / reviewer 两步都要检测用户接管');
assert.ok((loopSrc.match(/state\.status = 'stopped_user';/g) || []).length >= 3,
  'loop-engine 被接管后必须停在 stopped_user（abort + builder + reviewer 三处）');
assert.ok(/if \(checked\.takenOver\) \{[\s\S]{0,120}state\.status = 'stopped_user'/.test(loopSrc),
  'main 串行工作流被接管后必须停在 stopped_user，不继续跑下一步');

console.log('All passed.');
