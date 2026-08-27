'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canSubmitRecoveryEnter, createNightGuardService } = require('../main/night-guard-service.js');

test('delayed recovery Enter is suppressed after takeover, completion, or incident replacement', () => {
  let state = { enabled: true, status: 'resuming', incidentId: 'incident-1' };
  const controller = {
    canSubmitRecoveryInput(_sessionId, incidentId) {
      return state.enabled === true && state.incidentId === incidentId
        && ['resuming', 'recovering'].includes(state.status);
    },
  };
  assert.equal(canSubmitRecoveryEnter(controller, 'session-1', 'incident-1'), true);
  state = { enabled: true, status: 'recovering', incidentId: 'incident-1' };
  assert.equal(canSubmitRecoveryEnter(controller, 'session-1', 'incident-1'), true);
  state = { enabled: true, status: 'armed', incidentId: null };
  assert.equal(canSubmitRecoveryEnter(controller, 'session-1', 'incident-1'), false);
  state = { enabled: false, status: 'completed', incidentId: null };
  assert.equal(canSubmitRecoveryEnter(controller, 'session-1', 'incident-1'), false);
  state = { enabled: true, status: 'resuming', incidentId: 'incident-2' };
  assert.equal(canSubmitRecoveryEnter(controller, 'session-1', 'incident-1'), false);
});

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
  const codexStateBeforeClaude = { ...sessions.get('codex').nightGuard };
  const claudeEnabled = service.controller.setEnabled('claude', true);
  assert.equal(claudeEnabled.ok, true);
  assert.equal(sessions.get('claude').nightGuard.enabled, true);
  assert.deepEqual(sessions.get('codex').nightGuard, codexStateBeforeClaude);
  assert.equal(handlers.has('night-guard:get'), true);
  assert.equal(writes.some(item => item.channel === 'night-guard-status'), true);
  service.controller.dispose();
});
