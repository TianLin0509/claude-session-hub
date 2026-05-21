'use strict';

function registerGroupchatRecoveryIpc(ipcMain, deps) {
  const {
    getActiveWatchers,
  } = deps;

  ipcMain.handle('groupchat-skip-participant', async (_e, { sid } = {}) => {
    if (!sid) return { ok: false, reason: 'missing sid' };
    const watcher = getActiveWatchers().get(sid);
    if (!watcher) return { ok: false, reason: 'not_active' };
    watcher.skip();
    return { ok: true };
  });

  ipcMain.handle('groupchat-resend-participant', async () => {
    return {
      ok: false,
      reason: 'unsupported',
      detail: 'group chat uses resend-prompt, manual extract, and skip recovery actions',
    };
  });
}

module.exports = {
  registerGroupchatRecoveryIpc,
};
