'use strict';

const AUTO_SUSPEND_IDLE_MS = 5 * 60 * 60 * 1000;
const AUTO_SUSPEND_CHECK_MS = 5 * 60 * 1000;
const AUTO_SUSPEND_REASON = 'idle-timeout';

function collectProtectedSessionIds({ groupChatDispatcher, loopEngine, meetingManager } = {}) {
  const protectedIds = new Set();

  try {
    const watchers = groupChatDispatcher
      && typeof groupChatDispatcher.getActiveWatchers === 'function'
      ? groupChatDispatcher.getActiveWatchers()
      : null;
    if (watchers && typeof watchers[Symbol.iterator] === 'function') {
      for (const [sessionId, watcher] of watchers) {
        const settled = watcher && typeof watcher.isSettled === 'function'
          ? watcher.isSettled()
          : false;
        if (!settled && sessionId) protectedIds.add(String(sessionId));
      }
    }
  } catch {}

  try {
    const meetings = meetingManager && typeof meetingManager.getAllMeetings === 'function'
      ? meetingManager.getAllMeetings()
      : [];
    for (const meeting of meetings || []) {
      if (!meeting || !meeting.id || !loopEngine || typeof loopEngine.isRunning !== 'function') continue;
      if (!loopEngine.isRunning(meeting.id)) continue;
      for (const sessionId of meeting.subSessions || []) {
        if (sessionId) protectedIds.add(String(sessionId));
      }
    }
  } catch {}

  return protectedIds;
}

function createSessionAutoSuspendScheduler(options = {}) {
  const sessionManager = options.sessionManager;
  if (!sessionManager || typeof sessionManager.suspendIdleSessions !== 'function') {
    throw new TypeError('sessionManager.suspendIdleSessions is required');
  }

  const logger = options.logger || console;
  const idleMs = Math.max(60 * 1000, Number(options.idleMs) || AUTO_SUSPEND_IDLE_MS);
  const checkIntervalMs = Math.max(10 * 1000, Number(options.checkIntervalMs) || AUTO_SUSPEND_CHECK_MS);
  const getProtectedSessionIds = typeof options.getProtectedSessionIds === 'function'
    ? options.getProtectedSessionIds
    : () => new Set();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let timer = null;

  function sweep() {
    const protectedIds = getProtectedSessionIds() || new Set();
    const result = sessionManager.suspendIdleSessions({
      idleMs,
      now: now(),
      excludePinned: true,
      excludeFocused: true,
      // 闲置群聊成员也应释放 PTY；真正运行中的 watcher / loop 成员由
      // excludeSessionIds 单独保护，避免把“属于群聊”和“仍在工作”混为一谈。
      excludeMeeting: false,
      excludeSessionIds: protectedIds,
      reason: AUTO_SUSPEND_REASON,
    });
    if (result && result.count > 0 && logger && typeof logger.log === 'function') {
      logger.log(`[session-auto-suspend] requested ${result.count} session(s) after ${idleMs}ms idle`);
    }
    return result;
  }

  function start() {
    if (timer) return timer;
    timer = setIntervalFn(() => {
      try { sweep(); }
      catch (error) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[session-auto-suspend] sweep failed:', error && error.message ? error.message : error);
        }
      }
    }, checkIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return {
    idleMs,
    checkIntervalMs,
    start,
    stop,
    sweep,
    isStarted: () => !!timer,
  };
}

module.exports = {
  AUTO_SUSPEND_CHECK_MS,
  AUTO_SUSPEND_IDLE_MS,
  AUTO_SUSPEND_REASON,
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
};
