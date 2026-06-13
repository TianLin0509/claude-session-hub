'use strict';

function registerGroupchatTurnIpc(ipcMain, deps) {
  const {
    dispatchGroupChatTurn,
    committeeConductor = null,
    logger = console,
  } = deps;

  ipcMain.handle('groupchat:turn', async (_e, args = {}) => {
    try {
      // 投委会场景 + 股票/体检/对比意图 → 整场编排；其余照常单轮派发。
      if (committeeConductor && await committeeConductor.isCommitteeCommand(args.meetingId, args.userInput)) {
        return await committeeConductor.runCommitteeSession(args.meetingId, args.userInput);
      }
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
