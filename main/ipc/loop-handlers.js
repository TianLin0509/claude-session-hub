'use strict';
/*
 * 循环工作流 IPC（Phase 2b 进阶，2026-06-29 道雪）
 * renderer 发起/停止/查询 main 进程驱动的循环。
 */
function registerLoopIpc(ipcMain, deps) {
  const { loopEngine, logger = console } = deps || {};
  if (!ipcMain || !loopEngine) return;

  // 停止意图是落盘的（引擎里 stopRequested），所以只有用户**明确要求继续**才能清掉它。
  // 下面每个入口都是用户亲手点的：不清的话，停过一次的群聊就再也起不来了。
  const resumeByUser = (meetingId) => {
    try { if (typeof loopEngine.clearStopIntent === 'function') loopEngine.clearStopIntent(meetingId); }
    catch (err) { logger.warn('[loop-ipc] clear stop intent failed:', err && err.message); }
  };

  // 立即返回 ok，循环在 main 后台跑（通过 'loop:progress' 推进度），不阻塞 renderer
  ipcMain.handle('loop:start', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      resumeByUser(args.meetingId);
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

  // 开题：只给指定执笔者派一次任务书，报告改名交付后自动开工。
  // 双击 / 重复 IPC 由引擎的 running map 挡住 —— 不会出现两个同阶段执行。
  ipcMain.handle('dev:kickoff', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      resumeByUser(args.meetingId);
      if (typeof loopEngine.runKickoff !== 'function') return { ok: false, reason: 'kickoff_unavailable' };
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      // 不 await：开题要等 agent 写完报告，可能几分钟到几十分钟，
      // 阻塞 renderer 会让整个窗口看起来卡死。进度走 loop:progress。
      loopEngine.runKickoff(args.meetingId, {
        authorMemberId: args.authorMemberId || null,
        heroIdBySid: args.heroIdBySid || {},
      }).catch(err => logger.error('[dev:kickoff] background run failed:', err));
      return { ok: true };
    } catch (err) {
      logger.error('[dev:kickoff]', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });

  // 「重发本轮」：不重置任务、不重开轮次，只对当前阶段再核对一次现场。
  // 开题阶段 → 重新派给原执笔者；实现/审查阶段 → 走 loop:resume 那条持久检查点路径。
  ipcMain.handle('dev:redispatch', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      resumeByUser(args.meetingId);
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const status = loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : null;
      const kickoff = status && status.kickoff;
      if (kickoff && ['running', 'awaiting_report', 'failed'].includes(kickoff.status)) {
        loopEngine.runKickoff(args.meetingId, { authorMemberId: kickoff.authorMemberId || null })
          .catch(err => logger.error('[dev:redispatch] kickoff failed:', err));
        return { ok: true, stage: 'kickoff' };
      }
      const persisted = status && status.loopState;
      if (!persisted || !['running', 'paused'].includes(persisted.status)) {
        return { ok: false, reason: 'no_resumable_run' };
      }
      const phaseCheck = typeof loopEngine.validateResume === 'function' ? loopEngine.validateResume(args.meetingId) : { ok: true };
      if (!phaseCheck.ok) return { ok: false, reason: phaseCheck.reason };
      loopEngine.runLoop(args.meetingId, null, { ...persisted, status: 'running', stepAttempt: 0, lastError: null }, {})
        .catch(err => logger.error('[dev:redispatch] loop failed:', err));
      return { ok: true, stage: persisted.currentStep || 'loop' };
    } catch (err) {
      logger.error('[dev:redispatch]', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });

  ipcMain.handle('loop:stop', async (_e, args = {}) => {
    try { return { ok: loopEngine.stopLoop(args.meetingId, { interrupt: true }) }; }
    catch (err) { return { ok: false, reason: (err && err.message) }; }
  });

  ipcMain.handle('loop:status', async (_e, args = {}) => {
    try { return loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : { running: loopEngine.isRunning(args.meetingId) }; }
    catch (err) { return { running: false }; }
  });

  ipcMain.handle('loop:resume', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      resumeByUser(args.meetingId);
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const status = loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : null;
      const persisted = status && status.loopState;
      if (!persisted || !['running', 'paused'].includes(persisted.status)) {
        return { ok: false, reason: 'no_resumable_loop_run' };
      }
      // 开发群聊讨论阶段不许恢复旧循环（会绕过「开工」的任务说明确认）；引擎内部也拦，这里让前端拿到明确原因
      const phaseCheck = typeof loopEngine.validateResume === 'function' ? loopEngine.validateResume(args.meetingId) : { ok: true };
      if (!phaseCheck.ok) return { ok: false, reason: phaseCheck.reason };
      loopEngine.runLoop(args.meetingId, null, { ...persisted, status: 'running', stepAttempt: 0, lastError: null }, { heroIdBySid: args.heroIdBySid || {} })
        .catch(err => logger.error('[loop:resume] background run failed:', err));
      return { ok: true };
    } catch (err) {
      logger.error('[loop:resume]', err);
      return { ok: false, reason: (err && err.message) || 'internal_error' };
    }
  });

  ipcMain.handle('serial:start', async (_e, args = {}) => {
    try {
      if (!args.meetingId) return { ok: false, reason: 'no_meeting_id' };
      resumeByUser(args.meetingId);
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
      resumeByUser(args.meetingId);
      if (loopEngine.isRunning(args.meetingId)) return { ok: false, reason: 'already_running' };
      const status = loopEngine.getStatus ? loopEngine.getStatus(args.meetingId) : null;
      const persisted = status && status.serialRunState;
      if (!persisted || !['running', 'paused'].includes(persisted.status)) {
        return { ok: false, reason: 'no_resumable_serial_run' };
      }
      const attemptsByStep = { ...(persisted.attemptsByStep || {}) };
      const resumeIndex = persisted.currentStepIndex !== null && persisted.currentStepIndex !== undefined
        ? Number(persisted.currentStepIndex)
        : Number(persisted.nextStepIndex);
      if (Number.isFinite(resumeIndex)) attemptsByStep[resumeIndex] = 0;
      const resumable = { ...persisted, status: 'running', attemptsByStep, lastError: null };
      loopEngine.runSerial(args.meetingId, null, resumable, { heroIdBySid: args.heroIdBySid || {} })
        .catch(err => logger.error('[serial:resume] background run failed:', err));
      return { ok: true };
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
