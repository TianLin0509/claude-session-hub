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

  // 2026-09-07 合并位 B5：不清零重试计数还不够。当前步骤根本没有回答时把引擎
  //   重新跑起来，它照样会把原成员再问一遍 —— 用户点的是「继续」，得到的却是重发。
  //   所以恢复必须先过同一个判断：有答案才继续；没有就明确拒绝，把重发交给那个
  //   写着「重新让本成员回答」的入口去授权。
  //   allowWithoutResult=true 只留给那个显式重发动作。
  if (options.allowWithoutResult !== true && typeof options.describeStep === 'function') {
    let context = null;
    try { context = options.describeStep(meetingId); }
    catch (error) { logger.error('[workflow-resume] step context failed:', error); }
    if (context && context.ok && context.active) {
      if (context.decision && context.decision.action === 'blocked') {
        return { ok: false, reason: context.decision.why || 'blocked', context };
      }
      if (context.decision && context.decision.action !== 'advance') {
        return {
          ok: false,
          reason: 'awaiting_result',
          detail: (context.chip && context.chip.hint)
            || '当前步骤还没有可用回答；继续等，或用「手动提供回答」，需要重问请用「重新让本成员回答」',
          context,
        };
      }
    }
  }

  const loopState = status && status.loopState;
  if (loopState && ['running', 'paused'].includes(loopState.status)) {
    const resumable = { ...loopState, status: 'running', lastError: null };
    loopEngine.runLoop(meetingId, null, resumable, {
      heroIdBySid: options.heroIdBySid || {},
      // 引擎侧的兜底闸门：恢复时**只**守当前这一步 —— 它没有可用回答就明确暂停，
      //   绝不重发。放在引擎里是因为调用方可能忘了注入读取器（合并位实测到了这个洞），
      //   而引擎手里一定有判断所需的全部数据。
      noRedispatch: options.allowWithoutResult !== true,
    })
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
    loopEngine.runSerial(meetingId, null, resumable, {
      heroIdBySid: options.heroIdBySid || {},
      noRedispatch: options.allowWithoutResult !== true,
    })
      .catch(err => logger.error('[workflow-resume] serial run failed:', err));
    return { ok: true, kind: 'serial' };
  }

  return { ok: false, reason: 'no_resumable_run' };
}

module.exports = { resumeWorkflowRun };
