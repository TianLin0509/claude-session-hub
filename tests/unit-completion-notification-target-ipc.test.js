'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notification-target-ipc-'));
process.env.CLAUDE_HUB_DATA_DIR = tempDir;
fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
  notifications: {
    enabled: true,
    feishu: { target: 'oc_1234567890' },
  },
}), 'utf8');

const { registerConfigIpc } = require('../main/ipc/config-handlers.js');

function createIpc() {
  return {
    handlers: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
  };
}

try {
  const ipcMain = createIpc();
  const sessions = new Map([
    ['s1', { id: 's1', title: 'Important', completionNotificationEnabled: false }],
    ['s2', { id: 's2', title: 'Other', completionNotificationEnabled: false }],
  ]);
  const meetings = new Map([
    ['m1', { id: 'm1', title: 'Roundtable', completionNotificationEnabled: false }],
  ]);
  const events = [];

  registerConfigIpc(ipcMain, {
    attachCodexUsageScope: value => value,
    clearCodexJsonlCache() {},
    clearSessionManagerConfigCache() {},
    currentCodexUsageScope: () => null,
    meetingManager: {
      updateMeeting(id, fields) {
        if (!meetings.has(id)) return null;
        const next = { ...meetings.get(id), ...fields };
        meetings.set(id, next);
        return next;
      },
    },
    scanAgentSessions: async () => {},
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sessionManager: {
      updateSessionMeta(id, fields) {
        if (!sessions.has(id)) return null;
        const next = { ...sessions.get(id), ...fields };
        sessions.set(id, next);
        return next;
      },
    },
    testCompletionNotification: async () => ({ ok: true }),
  });

  const setEnabled = ipcMain.handlers.get('set-completion-notification-enabled');
  assert.equal(typeof setEnabled, 'function');

  const sessionResult = setEnabled(null, { sessionId: 's1', enabled: true });
  assert.deepEqual(sessionResult, {
    ok: true,
    status: 'saved',
    enabled: true,
    configured: true,
    targetType: 'session',
    targetId: 's1',
  });
  assert.equal(sessions.get('s1').completionNotificationEnabled, true);
  assert.equal(sessions.get('s2').completionNotificationEnabled, false,
    'toggling one session must not affect another');

  const meetingResult = setEnabled(null, { meetingId: 'm1', enabled: true });
  assert.equal(meetingResult.ok, true);
  assert.equal(meetingResult.targetType, 'meeting');
  assert.equal(meetings.get('m1').completionNotificationEnabled, true);

  const missing = setEnabled(null, { enabled: true });
  assert.equal(missing.status, 'missing_target');
  assert.ok(events.some(event => event.channel === 'session-updated'));
  assert.ok(events.some(event => event.channel === 'meeting-updated'));

  const stored = JSON.parse(fs.readFileSync(path.join(tempDir, 'config.json'), 'utf8'));
  assert.equal(stored.notifications.enabled, true,
    'the legacy global setting must not be rewritten by a session toggle');

  console.log('unit-completion-notification-target-ipc.test.js OK');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
