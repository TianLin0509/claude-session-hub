'use strict';
/**
 * 「把暂停的工作流接着跑下去」——唯一的唤醒入口（2026-09-07 Claude 1）。
 *
 * 抽出来的原因：状态栏的「同步回答」、手动粘贴弹窗的「采用回答并继续」、
 * 以及旧的 loop:resume / serial:resume 三个入口，以前各自拼一份 persisted state
 * 再调引擎。只要有一处忘了跟上（比如清零了重试计数），用户就会看到
 * 「点一下又把同一个成员问了一遍」。合并成一条之后，这类分叉在结构上就不存在了。
 *
 * 两条硬规矩写在这里，调用方不用各自记：
 *   ① **不清零重试计数**。清零等于把「这一步已经试过几次」抹掉，每点一次就白送一轮重试。
 *   ② **本函数自己不发 prompt**。它只是把引擎重新跑起来；派不派发由引擎的活状态闸门决定
 *      —— 已经有可用回答的步骤会被直接推过去。真要重发得走那个明确写着
 *      「重新让本成员回答」的入口。
 */

function resumeWorkflowRun(loopEngine, meetingId, options = {}) {
  const logger = options.logger || console;
  if (!loopEngine || !meetingId) return { ok: false, reason: 'no_meeting_id' };
  if (loopEngine.isRunning(meetingId)) {
    // 已经在跑就不是错误：说明有别的入口（或 watcher 结算）已经把它唤醒了。
    return { ok: true, alreadyRunning: true, kind: null };
  }
  const status = typeof loopEngine.getStatus === 'function' ? loopEngine.getStatus(meetingId) : null;
  const phaseCheck = typeof loopEngine.validateResume === 'function'
    ? loopEngine.validateResume(meetingId)
    : { ok: true };
  if (!phaseCheck.ok) return { ok: false, reason: phaseCheck.reason };

  const loopState = status && status.loopState;
  if (loopState && ['running', 'paused'].includes(loopState.status)) {
    const resumable = { ...loopState, status: 'running', lastError: null };
    loopEngine.runLoop(meetingId, null, resumable, { heroIdBySid: options.heroIdBySid || {} })
      .catch(err => logger.error('[workflow-resume] loop run failed:', err));
    return { ok: true, kind: 'loop' };
  }

  const serialState = status && status.serialRunState;
  if (serialState && ['running', 'paused'].includes(serialState.status)) {
    const resumable = {
      ...serialState,
      status: 'running',
      attemptsByStep: { ...(serialState.attemptsByStep || {}) },
      lastError: null,
    };
    loopEngine.runSerial(meetingId, null, resumable, { heroIdBySid: options.heroIdBySid || {} })
      .catch(err => logger.error('[workflow-resume] serial run failed:', err));
    return { ok: true, kind: 'serial' };
  }

  return { ok: false, reason: 'no_resumable_run' };
}

module.exports = { resumeWorkflowRun };
