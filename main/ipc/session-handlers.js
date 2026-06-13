'use strict';

function registerSessionIpc(ipcMain, deps) {
  const {
    registerSessionForTap = () => {},
    sendToRenderer,
    sessionManager,
  } = deps;

  const lastResizeBySid = new Map();

  ipcMain.handle('create-session', (_e, arg) => {
    // Back-compat: legacy callers pass just a kind string; newer callers pass { kind, opts }.
    let kind;
    let opts;
    if (typeof arg === 'string') {
      kind = arg;
      opts = {};
    } else if (arg && typeof arg === 'object') {
      kind = arg.kind;
      opts = arg.opts || {};
    } else {
      kind = 'powershell';
      opts = {};
    }
    const session = sessionManager.createSession(kind, opts);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    return session;
  });

  ipcMain.handle('close-session', (_e, sessionId) => {
    lastResizeBySid.delete(sessionId);
    sessionManager.closeSession(sessionId);
  });

  ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows }) => {
    if (typeof sessionId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    if (cols <= 0 || rows <= 0) return;
    const last = lastResizeBySid.get(sessionId);
    if (last && last.cols === cols && last.rows === rows) return;
    lastResizeBySid.set(sessionId, { cols, rows });
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  ipcMain.on('focus-session', (_e, { sessionId }) => {
    sessionManager.setFocusedSession(sessionId);
    sessionManager.markRead(sessionId);
  });

  ipcMain.handle('rename-session', (_e, { sessionId, title, userRenamed }) => {
    const session = sessionManager.renameSession(sessionId, title, { userRenamed: !!userRenamed });
    if (session) sendToRenderer('session-updated', { session });
    return session;
  });

  ipcMain.handle('get-sessions', () => {
    return sessionManager.getAllSessions();
  });

  ipcMain.handle('debug:get-session-buffer', (_e, sessionId) => {
    return sessionManager.getSessionBuffer(sessionId);
  });

  ipcMain.handle('debug:get-last-session-write', () => {
    return typeof sessionManager.getLastWrite === 'function' ? sessionManager.getLastWrite() : null;
  });

  ipcMain.handle('restart-session', (_e, sessionId) => {
    const old = sessionManager.getSession(sessionId);
    if (!old) return null;
    sessionManager.closeSession(sessionId);
    const fresh = sessionManager.createSession(old.kind, {
      id: old.id,
      cwd: old.cwd,
      meetingId: old.meetingId || undefined,
    });
    registerSessionForTap(fresh);
    sendToRenderer('session-created', { session: fresh });
    return fresh;
  });

  return { lastResizeBySid };
}

module.exports = {
  registerSessionIpc,
};
