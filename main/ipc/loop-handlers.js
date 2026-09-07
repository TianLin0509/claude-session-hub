'use strict';
/*
 * 循环工作流 IPC（Phase 2b 进阶，2026-06-29 道雪）
 * renderer 发起/停止/查询 main 进程驱动的循环。
 */
const { resumeWorkflowRun } = require('../groupchat/workflow-resume.js');

function registerLoopIpc(ipcMain, deps) {
  const { loopEngine, logger = console } = deps || {};
  if (!ipcMain || !loopEngine) return;

  // 立即返回 ok，循环在 main 后台跑（通过 'loop:progress' 推进度），不阻塞 renderer
  ipcMain.handle('loop:start', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const validation = typeof loopEngine.validateLoop === 'function'
        ? loopEngine.validateLoop(args.meetingId)
        : { ok: true };
      if (!validation.ok) return { ok: false, reason: validation.reason };
      loopEngine.runLoop(args.meetingId, args.userInput || '', null, { heroIdBySid: args.heroIdBySid || {} })
        .catch(err => logger.error('[loop:start] background run failed:', err));
      return { ok: true };
    } catch (err) { logger.error('[loop:start]', err); return { ok: false, reason: (err && err.message) || 'internal_error' }; }
  });

  ipcMain.handle('loop:stop', async (_e, args = {}) => {
    try { return { ok: loopEngine.stopLoop(args.meetingId, { interrupt: true }) }; }
    catch (err) { return { ok: false, reason: (err && err.message) }; }
  });

  ipcMain.handle('loop:status', async (_e, args = {}) => {
    try { return loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : { running: loopEngine.isRunning(args.meetingId) }; }
    catch (err) { return { running: false }; }
  });

  // 恢复统一走 workflow-resume：不清零重试计数、自己不发 prompt。
  //   派不派发由引擎的活状态闸门决定 —— 已经有可用回答的步骤会被直接推过去。
  ipcMain.handle('loop:resume', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const status = loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : null;
      const persisted = status && status.loopState;
      if (!persisted || !['running', 'paused'].includes(persisted.status)) {
        return { ok: false, reason: 'no_resumable_loop_run' };
      }
      // 讨论阶段不许恢复旧循环（会绕过「开工」的任务说明确认）。这一层是三道闸门之一，
      //   共享的 resumeWorkflowRun 里还会再问一次；这里留着是为了给前端精确原因。
      const phaseCheck = typeof loopEngine.validateResume === 'function' ? loopEngine.validateResume(args.meetingId) : { ok: true };
      if (!phaseCheck.ok) return { ok: false, reason: phaseCheck.reason };
      return resumeWorkflowRun(loopEngine, args.meetingId, { logger, heroIdBySid: args.heroIdBySid || {} });
    } catch (err) {
      logger.error('[loop:resume]', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });

  ipcMain.handle('serial:start', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const validation = typeof loopEngine.validateSerial === 'function'
        ? loopEngine.validateSerial(args.meetingId)
        : { ok: true };
      if (!validation.ok) return { ok: false, reason: validation.reason };
      loopEngine.runSerial(args.meetingId, args.userInput || '', null, { heroIdBySid: args.heroIdBySid || {} })
        .catch(err => logger.error('[serial:start] background run failed:', err));
      return { ok: true };
    } catch (err) {
      logger.error('[serial:start]', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });

  ipcMain.handle('serial:resume', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const status = loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : null;
      const persisted = status && status.serialRunState;
      if (!persisted || !['running', 'paused'].includes(persisted.status)) {
        return { ok: false, reason: 'no_resumable_serial_run' };
      }
      // 讨论阶段不许恢复旧循环（会绕过「开工」的任务说明确认）。这一层是三道闸门之一，
      //   共享的 resumeWorkflowRun 里还会再问一次；这里留着是为了给前端精确原因。
      const phaseCheck = typeof loopEngine.validateResume === 'function' ? loopEngine.validateResume(args.meetingId) : { ok: true };
      if (!phaseCheck.ok) return { ok: false, reason: phaseCheck.reason };
      return resumeWorkflowRun(loopEngine, args.meetingId, { logger, heroIdBySid: args.heroIdBySid || {} });
    } catch (err) {
      logger.error('[serial:resume]', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });

  ipcMain.handle('workflow:stop', async (_e, args = {}) => {
    try { return { ok: loopEngine.stopLoop(args.meetingId, { interrupt: true }) }; }
    catch (err) { return { ok: false, reason: (err && err.message) || 'internal_error' }; }
  });

  ipcMain.handle('workflow:status', async (_e, args = {}) => {
    try { return loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : { running: loopEngine.isRunning(args.meetingId) }; }
    catch { return { running: false }; }
  });
}

module.exports = { registerLoopIpc };
