'use strict';

function registerGroupchatTurnIpc(ipcMain, deps) {
  const {
    dispatchGroupChatTurn,
    interruptGroupChatTurn = null,
    committeeConductor = null,
    logger = console,
  } = deps;

  ipcMain.handle('groupchat:turn', async (_e, args = {}) => {
    try {
      // 新的 renderer 用户轮次先废止同 meeting 的旧投委会编排。尤其旧流程正处在
      // Python 备料/落盘等“没有 watcher”的幕间时，若不先置 superseded，它下一幕
      // 会反向抢占并覆盖这个新问题。投委会内部幕次直调 dispatcher，不经过本 IPC，
      // 因而不会自我取消。
      if (committeeConductor && typeof committeeConductor.cancelCommitteeSession === 'function') {
        committeeConductor.cancelCommitteeSession(args.meetingId, 'superseded');
      }
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

  ipcMain.handle('groupchat:interrupt', async (_e, args = {}) => {
    try {
      const committeeInterrupted = !!(
        committeeConductor &&
        typeof committeeConductor.cancelCommitteeSession === 'function' &&
        committeeConductor.cancelCommitteeSession(args.meetingId, 'interrupted')
      );
      if (typeof interruptGroupChatTurn !== 'function' && !committeeInterrupted) {
        return { ok: false, status: 'idle', reason: 'interrupt_unavailable', interruptedSids: [] };
      }
      const watcherResult = typeof interruptGroupChatTurn === 'function'
        ? await interruptGroupChatTurn(args.meetingId)
        : { ok: false, status: 'idle', reason: 'no_active_turn', interruptedSids: [] };
      if (!committeeInterrupted) return watcherResult;
      return {
        ...watcherResult,
        ok: true,
        status: 'interrupted',
        committeeInterrupted: true,
      };
    } catch (err) {
      logger.error('[groupchat:interrupt] unhandled throw, returning error to renderer:', err);
      return { ok: false, status: 'error', reason: (err && err.message) || 'internal_error', interruptedSids: [] };
    }
  });
}

module.exports = {
  registerGroupchatTurnIpc,
};
