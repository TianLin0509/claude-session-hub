'use strict';

function registerNightGuardIpc(ipcMain, deps = {}) {
  const controller = deps.controller;
  if (!ipcMain || !controller) throw new Error('night guard IPC requires ipcMain and controller');

  ipcMain.handle('night-guard:get', (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return { ok: false, error: 'missing-session-id' };
    return { ok: true, state: controller.getStatus(sessionId) };
  });

  ipcMain.handle('night-guard:set-enabled', (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return { ok: false, error: 'missing-session-id' };
    return controller.setEnabled(sessionId, payload.enabled === true, {
      source: 'manual',
      mode: 'manual',
    });
  });

  ipcMain.handle('night-guard:get-audit-path', () => ({
    ok: true,
    path: typeof deps.auditPath === 'string' ? deps.auditPath : null,
  }));

  return { controller };
}

module.exports = { registerNightGuardIpc };
