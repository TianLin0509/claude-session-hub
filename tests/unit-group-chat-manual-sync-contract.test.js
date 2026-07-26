const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
const dispatcherSrc = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const recoverySrc = fs.readFileSync(path.join(root, 'main', 'ipc', 'groupchat-recovery-handlers.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const cssSrc = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

// 2026-07-12 契约修正（字符串漂移，语义不变）：串行工作流引入 turnTimeoutMs 后，
//   普通群聊的"退出 5 分钟硬超时"由 `disableHardTimeout: !(Number(turnTimeoutMs) > 0)`
//   表达——turnTimeoutMs 未传（普通群聊）时仍为 true，不变量保持。
assert.ok(
  dispatcherSrc.includes('const disableHardTimeout = opts.disableHardTimeout === true;') &&
  dispatcherSrc.includes('if (!disableHardTimeout) {') &&
  dispatcherSrc.includes('disableHardTimeout: !(Number(turnTimeoutMs) > 0),'),
  'AI waits must opt out of the transitional 5-minute hard timeout unless an explicit turn timeout is requested',
);

const groupWaitIdx = dispatcherSrc.indexOf("mode: 'group', turnNum");
assert.ok(
  groupWaitIdx > 0 && dispatcherSrc.slice(groupWaitIdx, groupWaitIdx + 400).includes('disableHardTimeout: !(Number(turnTimeoutMs) > 0),'),
  'group chat waits must opt out of the transitional 5-minute hard timeout for normal (non-workflow) sends',
);

assert.ok(
  recoverySrc.includes('groupChatWatcher.extractStreamingText(sid, kind)') &&
  recoverySrc.includes("extractMode: 'pty_buffer_fallback'"),
  'manual extract must fall back to the visible PTY buffer when transcript extraction is not ready',
);

assert.ok(
  recoverySrc.includes('groupchat.getOrchestrator(getHubDataDir(), meetingId)') &&
  recoverySrc.includes("mode: 'patch_groupchat_turn'"),
  'manual extract must patch settled group-chat state',
);

assert.ok(
  rendererSrc.includes('data-gc-sync-answer') &&
  rendererSrc.includes("ipcRenderer.invoke('groupchat-manual-extract'") &&
  rendererSrc.includes('await refreshGroupChatPanel(meeting)'),
  'group chat AI bubbles must expose a manual sync button that refreshes the panel after extraction',
);

assert.ok(
  cssSrc.includes('.mr-gc-sync-btn'),
  'group chat sync button must have dedicated styling',
);

console.log('group chat manual sync contract ok');
