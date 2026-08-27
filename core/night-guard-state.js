'use strict';

const NIGHT_GUARD_MODES = new Set(['manual', 'goal']);
const NIGHT_GUARD_STATUSES = new Set([
  'off',
  'armed',
  'grace',
  'waiting-network',
  'waiting-runtime',
  'resuming',
  'recovering',
  'completed',
  'cancelled',
  'blocked',
]);

function finiteTime(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function shortText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function shortId(value) {
  const normalized = shortText(value, 160);
  return normalized || null;
}

function sanitizeRecoveryAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(finiteTime)
    .filter(Boolean)
    .slice(-8);
}

function sanitizeNightGuardState(value) {
  if (!value || typeof value !== 'object') return null;
  const enabled = value.enabled === true;
  const mode = NIGHT_GUARD_MODES.has(value.mode) ? value.mode : (enabled ? 'manual' : null);
  const fallbackStatus = enabled ? 'armed' : 'off';
  const status = NIGHT_GUARD_STATUSES.has(value.status) ? value.status : fallbackStatus;
  return {
    enabled,
    mode,
    autoCloseOnSuccess: value.autoCloseOnSuccess !== false,
    status,
    armedAt: finiteTime(value.armedAt),
    activeTurnId: shortId(value.activeTurnId),
    goalObjective: shortText(value.goalObjective, 300) || null,
    goalStatus: shortText(value.goalStatus, 40) || null,
    incidentId: shortId(value.incidentId),
    failedTurnId: shortId(value.failedTurnId),
    failureAt: finiteTime(value.failureAt),
    healthyRounds: Math.max(0, Math.min(9, Number(value.healthyRounds) || 0)),
    nextCheckAt: finiteTime(value.nextCheckAt),
    recoveryAttempts: sanitizeRecoveryAttempts(value.recoveryAttempts),
    recoveryTurnId: shortId(value.recoveryTurnId),
    lastRecoveryAt: finiteTime(value.lastRecoveryAt),
    lastSuccessAt: finiteTime(value.lastSuccessAt),
    lastError: shortText(value.lastError, 500) || null,
    message: shortText(value.message, 300) || null,
    updatedAt: finiteTime(value.updatedAt),
  };
}

function createNightGuardState(options = {}) {
  const now = finiteTime(options.now) || Date.now();
  return sanitizeNightGuardState({
    enabled: options.enabled === true,
    mode: NIGHT_GUARD_MODES.has(options.mode) ? options.mode : 'manual',
    autoCloseOnSuccess: options.autoCloseOnSuccess !== false,
    status: options.enabled === true ? 'armed' : 'off',
    armedAt: options.enabled === true ? now : null,
    activeTurnId: options.activeTurnId || null,
    recoveryAttempts: options.recoveryAttempts || [],
    updatedAt: now,
  });
}

function nightGuardEnabled(value) {
  const normalized = sanitizeNightGuardState(value);
  return !!(normalized && normalized.enabled);
}

module.exports = {
  NIGHT_GUARD_MODES,
  NIGHT_GUARD_STATUSES,
  createNightGuardState,
  nightGuardEnabled,
  sanitizeNightGuardState,
};
