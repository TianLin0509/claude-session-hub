'use strict';
/*
 * 循环工作流 IPC（Phase 2b 进阶，2026-06-29 道雪）
 * renderer 发起/停止/查询 main 进程驱动的循环。
 */
function registerLoopIpc(ipcMain, deps) {
  const { loopEngine, logger = console } = deps || {};
  if (!ipcMain || !loopEngine) return;

  // 立即返回 ok，循环在 main 后台跑（通过 'loop:progress' 推进度），不阻塞 renderer
  ipcMain.handle('loop:start', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      loopEngine.runLoop(args.meetingId, args.userInput || '', null, {
        clientGeneration: args.clientGeneration,
      }).catch((err) => logger.error('[loop:start] background run rejected', err));
      return { ok: true };
    } catch (err) { logger.error('[loop:start]', err); return { ok: false, reason: (err && err.message) || 'internal_error' }; }
  });

  ipcMain.handle('loop:stop', async (_e, args = {}) => {
    try { return { ok: loopEngine.stopLoop(args.meetingId) }; }
    catch (err) { return { ok: false, reason: (err && err.message) }; }
  });

  ipcMain.handle('loop:status', async (_e, args = {}) => {
    try { return { running: loopEngine.isRunning(args.meetingId) }; }
    catch (err) { return { running: false }; }
  });
}

module.exports = { registerLoopIpc };
