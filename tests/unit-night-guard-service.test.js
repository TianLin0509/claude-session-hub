'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNightGuardService } = require('../main/night-guard-service.js');

test('main night guard service wires IPC, persistence and manual enable without touching other sessions', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-guard-service-unit-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = { handle(name, fn) { handlers.set(name, fn); } };
  const sessions = new Map([
    ['codex', { id: 'codex', kind: 'codex', codexSid: '11111111-1111-4111-8111-111111111111' }],
    ['claude', { id: 'claude', kind: 'claude' }],
  ]);
  const writes = [];
  const persisted = [];
  const service = createNightGuardService({
    env: {
      CLAUDE_HUB_E2E: '1',
      CLAUDE_HUB_NIGHT_GUARD_FAST: '1',
      CLAUDE_HUB_NIGHT_GUARD_FIXTURE: JSON.stringify({ default: { ok: true } }),
    },
    getConfig: () => ({ proxy: 'http://127.0.0.1:7890' }),
    getDataDir: () => tempDir,
    getPersistedSessions: () => persisted,
    ipcMain,
    resumeSession: async () => null,
    sendToRenderer(channel, payload) { writes.push({ channel, payload }); },
    sessionManager: {
      getSession: id => sessions.get(id) || null,
      updateSessionMeta(id, patch) {
        const current = sessions.get(id);
        if (!current) return null;
        Object.assign(current, patch);
        return { ...current };
      },
      getSessionBuffer: () => '',
      getSessionBufferSnapshot: async () => ({ text: '' }),
      writeToSession() {},
      relaunchCli() { return false; },
    },
    sessionStore: {
      loadSessionFile: () => null,
      markDirtyImmediate: async () => {},
    },
    logger: { warn() {} },
  });
  const enabled = service.controller.setEnabled('codex', true);
  assert.equal(enabled.ok, true);
  assert.equal(sessions.get('codex').nightGuard.enabled, true);
  assert.equal(sessions.get('claude').nightGuard, undefined);
  assert.equal(handlers.has('night-guard:get'), true);
  assert.equal(writes.some(item => item.channel === 'night-guard-status'), true);
  service.controller.dispose();
});
