'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerNightGuardIpc } = require('../main/ipc/night-guard-handlers.js');

test('night guard IPC exposes per-session state and manual toggle', async () => {
  const handlers = new Map();
  const calls = [];
  const ipcMain = { handle(name, fn) { handlers.set(name, fn); } };
  const controller = {
    getStatus(id) { return { enabled: id === 's1', status: 'armed' }; },
    setEnabled(id, enabled, options) { calls.push({ id, enabled, options }); return { ok: true, state: { enabled } }; },
  };
  registerNightGuardIpc(ipcMain, { controller, auditPath: 'C:\\audit.jsonl' });
  assert.deepEqual(await handlers.get('night-guard:get')({}, { sessionId: 's1' }), {
    ok: true, state: { enabled: true, status: 'armed' },
  });
  const toggled = await handlers.get('night-guard:set-enabled')({}, { sessionId: 's1', enabled: false });
  assert.equal(toggled.ok, true);
  assert.deepEqual(calls[0], { id: 's1', enabled: false, options: { source: 'manual', mode: 'manual' } });
  assert.equal((await handlers.get('night-guard:get-audit-path')()).path, 'C:\\audit.jsonl');
});
