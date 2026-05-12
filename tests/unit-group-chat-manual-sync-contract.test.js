const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.css'), 'utf8');

assert.ok(
  mainSrc.includes('const disableHardTimeout = opts.disableHardTimeout === true;') &&
  mainSrc.includes('if (!disableHardTimeout) {') &&
  mainSrc.includes('disableHardTimeout: true,'),
  'AI waits must opt out of the transitional 5-minute hard timeout',
);

const roundtableWaitIdx = mainSrc.indexOf('console.log(`[roundtable] turn ${turnNum} waiting');
const groupWaitIdx = mainSrc.indexOf("mode: 'group', turnNum");
assert.ok(roundtableWaitIdx > 0, 'roundtable wait block must exist');
assert.ok(groupWaitIdx > roundtableWaitIdx, 'group chat wait block must follow roundtable wait block');
assert.ok(
  mainSrc.slice(roundtableWaitIdx, groupWaitIdx).includes('disableHardTimeout: true,'),
  'roundtable waits must also opt out of the transitional 5-minute hard timeout',
);

assert.ok(
  mainSrc.includes('rtWatcher.extractStreamingText(sid, kind)') &&
  mainSrc.includes("extractMode: 'pty_buffer_fallback'"),
  'manual extract must fall back to the visible PTY buffer when transcript extraction is not ready',
);

assert.ok(
  mainSrc.includes('meeting && meeting.groupChat') &&
  mainSrc.includes('groupchat.getOrchestrator(getHubDataDir(), meetingId)') &&
  mainSrc.includes("mode: 'patch_groupchat_turn'"),
  'manual extract must patch settled group-chat state instead of roundtable state',
);

assert.ok(
  rendererSrc.includes('data-gc-sync-answer') &&
  rendererSrc.includes("ipcRenderer.invoke('roundtable-manual-extract'") &&
  rendererSrc.includes('await refreshRoundtablePanel(meeting)'),
  'group chat AI bubbles must expose a manual sync button that refreshes the panel after extraction',
);

assert.ok(
  cssSrc.includes('.mr-gc-sync-btn'),
  'group chat sync button must have dedicated styling',
);

console.log('group chat manual sync contract ok');
