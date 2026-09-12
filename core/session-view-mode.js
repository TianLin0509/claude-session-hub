'use strict';

/**
 * 卡片 / PTY 视图模式的按会话记忆。
 *
 * 2026-08-27：这两个视图原来只有 renderer.js 里的一个全局 `currentView`，
 * 而 selectSession 从不调 applyViewMode——于是在 A 会话切到卡片、再点开 B 会话，
 * B 也跟着变成卡片。用户的本意是「每个会话记住自己的视图」。
 *
 * 只记住**处于卡片视图**的会话 id：PTY 是默认值，不入集合。这样 1000+ 会话也不会
 * 把 localStorage 撑大（实测该用户有 1056 个会话），LIMIT 只是防御异常增长。
 *
 * 放在 core/ 而不是塞在 renderer.js 里，是为了能单测——renderer.js 是个几千行的
 * 非模块化文件，里面的东西测不到。
 */

const STORAGE_KEY = 'hub.cardViewSessions';
const CARD = 'card';
const PTY = 'pty';
const LIMIT = 300;

function readCardViewSessions(store, storageKey = STORAGE_KEY) {
  if (!store || typeof store.getItem !== 'function') return new Set();
  try {
    const raw = JSON.parse(store.getItem(storageKey) || '[]');
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter(id => typeof id === 'string' && id));
  } catch {
    return new Set();
  }
}

function writeCardViewSessions(store, set, storageKey = STORAGE_KEY) {
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    // 超上限时丢**最早**加入的，保留最近用过的那些。
    store.setItem(storageKey, JSON.stringify([...set].slice(-LIMIT)));
    return true;
  } catch {
    // 存不下只影响下次启动时的视图记忆，不该拦住这次切换。
    return false;
  }
}

function normalizeViewMode(mode) {
  return mode === CARD ? CARD : PTY;
}

function viewModeFor(set, sessionId) {
  return sessionId && set && set.has(sessionId) ? CARD : PTY;
}

/** 返回集合是否真的变了，调用方据此决定要不要落盘。 */
function rememberViewMode(set, sessionId, mode) {
  if (!set || !sessionId) return false;
  const had = set.has(sessionId);
  if (normalizeViewMode(mode) === CARD) set.add(sessionId);
  else set.delete(sessionId);
  return set.has(sessionId) !== had;
}

function forgetViewMode(set, sessionId) {
  return !!(set && sessionId && set.delete(sessionId));
}

/**
 * 点开一个会话时该用哪个视图。
 *
 * 2026-09-06：「已完成未读」的会话点进去默认走卡片视图 —— 这时你要看的是刚写完的那段
 * 答复，PTY 里得自己往回滚。只影响这一次打开，不写进记忆（调用方传 remember:false），
 * 所以你手动切回 PTY 之后，读完未读再点开还是你自己选的那个视图。
 */
function selectionViewModeFor(set, sessionId, { completedUnread = false } = {}) {
  return completedUnread ? CARD : viewModeFor(set, sessionId);
}

module.exports = {
  CARD,
  PTY,
  LIMIT,
  STORAGE_KEY,
  forgetViewMode,
  normalizeViewMode,
  readCardViewSessions,
  rememberViewMode,
  selectionViewModeFor,
  viewModeFor,
  writeCardViewSessions,
};
