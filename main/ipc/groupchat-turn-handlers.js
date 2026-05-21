'use strict';

function registerGroupchatTurnIpc(ipcMain, deps) {
  const {
    dispatchGroupChatTurn,
    logger = console,
  } = deps;

  ipcMain.handle('groupchat:turn', async (_e, args = {}) => {
    try {
      return await dispatchGroupChatTurn(args.meetingId, args);
    } catch (err) {
      logger.error('[groupchat:turn] unhandled throw, returning error to renderer:', err);
      return { status: 'error', reason: (err && err.message) || 'internal_error', turnNum: null };
    }
  });
}

module.exports = {
  registerGroupchatTurnIpc,
};
