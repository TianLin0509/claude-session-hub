const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dispatcherSrc = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const recoverySrc = fs.readFileSync(path.join(root, 'main', 'ipc', 'groupchat-recovery-handlers.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.css'), 'utf8');

assert.ok(
  dispatcherSrc.includes('const disableHardTimeout = opts.disableHardTimeout === true;') &&
  dispatcherSrc.includes('if (!disableHardTimeout) {') &&
  dispatcherSrc.includes('disableHardTimeout: true,'),
  'AI waits must opt out of the transitional 5-minute hard timeout',
);

const groupWaitIdx = dispatcherSrc.indexOf("mode: 'group', turnNum");
assert.ok(
  groupWaitIdx > 0 && dispatcherSrc.slice(groupWaitIdx, groupWaitIdx + 400).includes('disableHardTimeout: true,'),
  'group chat waits must opt out of the transitional 5-minute hard timeout',
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
