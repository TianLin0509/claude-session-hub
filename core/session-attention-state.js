'use strict';

const ATTENTION_NONE = 'none';
const ATTENTION_NEEDS_INPUT = 'needs-input';
const ATTENTION_REPLY_READY = 'reply-ready';
const VALID_ATTENTION_STATES = new Set([
  ATTENTION_NONE,
  ATTENTION_NEEDS_INPUT,
  ATTENTION_REPLY_READY,
]);

function normalizeEventTime(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) value = numeric;
    else {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (Number.isFinite(value)) {
    const numeric = Number(value);
    // Accept both epoch seconds and epoch milliseconds at the boundary.
    return numeric > 0 && numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }
  return Number.isFinite(fallback) ? Number(fallback) : Date.now();
}

function normalizeTurnId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function attentionStateOf(session) {
  if (!session || typeof session !== 'object') return ATTENTION_NONE;
  if (VALID_ATTENTION_STATES.has(session.attentionState)) return session.attentionState;
  if (session.needsUserInput === true) return ATTENTION_NEEDS_INPUT;
  if (session.replyReady === true) return ATTENTION_REPLY_READY;
  // Backward compatibility: older Hub versions used isWaiting for both a real
  // question and an ordinary completed reply. waitingReason disambiguates it.
  if (session.isWaiting) {
    return session.waitingReason === 'reply-ready'
      ? ATTENTION_REPLY_READY
      : ATTENTION_NEEDS_INPUT;
  }
  return ATTENTION_NONE;
}

function sessionNeedsUserInput(session) {
  return attentionStateOf(session) === ATTENTION_NEEDS_INPUT;
}

function sessionHasCompletedUnread(session) {
  if (!session || typeof session !== 'object') return false;
  return attentionStateOf(session) === ATTENTION_REPLY_READY
    || Math.max(0, Number(session.unreadCount) || 0) > 0;
}

function _clockFor(session) {
  if (!session._attentionClock || typeof session._attentionClock !== 'object') {
    session._attentionClock = {
      activeTurnId: null,
      lastCompletedTurnId: null,
      lastPromptAt: 0,
      lastCompletionAt: 0,
      lastCompletionKey: null,
      version: 0,
    };
  }
  return session._attentionClock;
}

function _applyAttentionState(session, state, { reason = null, text = null } = {}) {
  const preview = typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : null;
  session.attentionState = state;
  session.needsUserInput = state === ATTENTION_NEEDS_INPUT;
  session.replyReady = state === ATTENTION_REPLY_READY;

  // Keep isWaiting as a compatibility field, but restore its literal meaning:
  // it is true only when the CLI is actually blocked on user input.
  session.isWaiting = state === ATTENTION_NEEDS_INPUT;
  session.waitingReason = state === ATTENTION_NEEDS_INPUT ? (reason || 'needs-input') : null;
  session.waitingText = state === ATTENTION_NEEDS_INPUT ? preview : null;
  session.replyReadyText = state === ATTENTION_REPLY_READY ? preview : null;
}

function clearSessionAttention(session, { clearUnread = false } = {}) {
  if (!session || typeof session !== 'object') return false;
  const changed = attentionStateOf(session) !== ATTENTION_NONE
    || session.isWaiting === true
    || session.needsUserInput === true
    || session.replyReady === true
    || (clearUnread && Math.max(0, Number(session.unreadCount) || 0) > 0);
  _applyAttentionState(session, ATTENTION_NONE);
  if (clearUnread) session.unreadCount = 0;
  return changed;
}

function applyPromptSubmitted(session, event = {}) {
  if (!session || typeof session !== 'object') return { applied: false, reason: 'missing-session' };
  const wasRunning = session.status === 'running';
  const clock = _clockFor(session);
  const at = normalizeEventTime(event.submittedAt, Date.now());
  const turnId = normalizeTurnId(event.turnId);

  // An optimistic UI submit records the prompt before the transcript catches
  // up. Allow the later authoritative event to enrich that same active prompt
  // with a turn id, while still rejecting genuinely old prompt records.
  const enrichOptimisticTurn = !!turnId
    && !clock.activeTurnId
    && clock.lastPromptAt > 0
    && clock.lastCompletionAt < clock.lastPromptAt;
  if (at < clock.lastPromptAt && !enrichOptimisticTurn) {
    return { applied: false, reason: 'stale-prompt-time', at, turnId };
  }
  if (clock.lastCompletionAt > 0 && at <= clock.lastCompletionAt
      && (!turnId || turnId === clock.lastCompletedTurnId)) {
    return { applied: false, reason: 'completed-turn-prompt', at, turnId };
  }

  clock.lastPromptAt = Math.max(clock.lastPromptAt, at);
  if (turnId) clock.activeTurnId = turnId;
  clock.version += 1;
  // Operational timing belongs to the same ordered reducer as attention.
  // This prevents an older transcript event from resetting the timer of a
  // newer turn and gives the workbench a stable start time across renders.
  const previousRunStartedAt = Number(session.runStartedAt) || 0;
  if (!previousRunStartedAt || !wasRunning || clock.lastCompletionAt >= previousRunStartedAt) {
    session.runStartedAt = at;
  }
  // Submitting the next prompt acknowledges the previous completed reply.
  clearSessionAttention(session, { clearUnread: true });
  if (session.status !== 'dormant') session.status = 'running';
  return { applied: true, at, turnId, version: clock.version };
}

function applyReplyCompleted(session, event = {}) {
  if (!session || typeof session !== 'object') return { applied: false, reason: 'missing-session' };
  const clock = _clockFor(session);
  const at = normalizeEventTime(event.completedAt, Date.now());
  const turnId = normalizeTurnId(event.turnId);
  const text = typeof event.text === 'string' ? event.text : '';
  const completionKey = `${turnId || ''}:${at}:${text.slice(0, 160)}`;

  if (clock.lastCompletionKey === completionKey) {
    return { applied: false, reason: 'duplicate-completion', at, turnId };
  }
  if (clock.lastPromptAt > 0 && at < clock.lastPromptAt) {
    return { applied: false, reason: 'stale-completion-time', at, turnId };
  }
  if (turnId && clock.activeTurnId && turnId !== clock.activeTurnId) {
    return { applied: false, reason: 'stale-completion-turn', at, turnId };
  }
  if (clock.lastCompletionAt > 0 && at < clock.lastCompletionAt) {
    return { applied: false, reason: 'out-of-order-completion', at, turnId };
  }

  clock.lastCompletionAt = Math.max(clock.lastCompletionAt, at);
  clock.lastCompletionKey = completionKey;
  clock.lastCompletedTurnId = turnId || clock.activeTurnId || null;
  clock.version += 1;

  const runStartedAt = Number(session.runStartedAt) || Number(clock.lastPromptAt) || 0;
  session.lastCompletedAt = at;
  if (runStartedAt > 0 && at >= runStartedAt) {
    session.lastRunStartedAt = runStartedAt;
    session.lastRunDurationMs = at - runStartedAt;
  }
  if (!event.keepRunning) session.runStartedAt = null;

  if (session.status !== 'dormant') session.status = event.keepRunning ? 'running' : 'idle';
  if (event.needsUserInput) {
    _applyAttentionState(session, ATTENTION_NEEDS_INPUT, {
      reason: event.reason,
      text,
    });
  } else if (event.seenByUser) {
    _applyAttentionState(session, ATTENTION_NONE);
  } else {
    _applyAttentionState(session, ATTENTION_REPLY_READY, { text });
  }

  let unreadIncremented = false;
  if (!event.seenByUser && event.incrementUnread !== false) {
    session.unreadCount = Math.max(0, Number(session.unreadCount) || 0) + 1;
    unreadIncremented = true;
  }
  return {
    applied: true,
    at,
    turnId,
    version: clock.version,
    unreadIncremented,
    attentionState: attentionStateOf(session),
  };
}

module.exports = {
  ATTENTION_NONE,
  ATTENTION_NEEDS_INPUT,
  ATTENTION_REPLY_READY,
  applyPromptSubmitted,
  applyReplyCompleted,
  attentionStateOf,
  clearSessionAttention,
  normalizeEventTime,
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
};
