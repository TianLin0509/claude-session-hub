'use strict';

const {
  ATTENTION_NEEDS_INPUT,
  ATTENTION_REPLY_READY,
  attentionStateOf,
} = require('../core/session-attention-state.js');

const RUNTIME_STATUS_RUNNING = 'running';
const RUNTIME_STATUS_WAITING = 'waiting';
const RUNTIME_STATUS_COMPLETE = 'complete';
const RUNTIME_STATUS_IDLE = 'idle';
const RUNTIME_STATUS_DORMANT = 'dormant';
const RUNTIME_STATUS_ERROR = 'error';

function providerLabel(session) {
  const kind = String(session && session.kind || '').replace(/-resume$/i, '').toLowerCase();
  if (kind === 'codex' || kind === 'deepseek') return kind === 'codex' ? 'Codex' : 'DeepSeek';
  if (kind === 'claude') return 'Claude';
  if (kind === 'kimi') return 'Kimi';
  if (kind === 'gemini') return 'Gemini';
  if (kind === 'powershell') return 'PowerShell';
  return 'AI';
}

function formatRuntimeDuration(value) {
  const totalSeconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = number => String(number).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(totalMinutes)}:${pad(seconds)}`;
}

function formatCompletionAge(completedAt, now = Date.now()) {
  const ageMs = Math.max(0, (Number(now) || Date.now()) - (Number(completedAt) || 0));
  if (!completedAt || ageMs < 60_000) return '刚刚';
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} 分钟前`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))} 小时前`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))} 天前`;
}

function runningStartedAt(session) {
  for (const value of [
    session && session.runStartedAt,
    session && session.cardWorkingSince,
    session && session._ptyFallbackArmedAt,
    session && session._ptyRuntimeObservedAt,
  ]) {
    const numeric = Number(value) || 0;
    if (numeric > 0) return numeric;
  }
  return 0;
}

function deriveSessionRuntimeStatus(session, options = {}) {
  const now = Number(options.now) || Date.now();
  const provider = providerLabel(session);
  const status = String(session && session.status || 'idle').toLowerCase();
  const attention = attentionStateOf(session);
  const isRunning = typeof options.isRunning === 'boolean'
    ? options.isRunning
    : status === 'running';
  const lastCompletedAt = Number(session && session.lastCompletedAt) || 0;
  const latestPromptAt = Number(session && session._attentionClock && session._attentionClock.lastPromptAt) || 0;
  const completionIsLatest = lastCompletedAt > 0 && (!latestPromptAt || lastCompletedAt >= latestPromptAt);

  let state = RUNTIME_STATUS_IDLE;
  let label = '已就绪';
  let meta = '';
  let detail = '';

  if (status === 'dormant') {
    state = RUNTIME_STATUS_DORMANT;
    label = '休眠中';
    detail = '点击会话可恢复原生 CLI';
  } else if (status === 'errored' || status === 'error') {
    state = RUNTIME_STATUS_ERROR;
    label = '运行异常';
    detail = String(session && (session.lastError || session.error) || '').trim();
  } else if (attention === ATTENTION_NEEDS_INPUT) {
    state = RUNTIME_STATUS_WAITING;
    label = '等待输入';
    meta = '需要操作';
    detail = String(session && session.waitingText || '').trim();
  } else if (isRunning) {
    state = RUNTIME_STATUS_RUNNING;
    label = '工作中';
    const startedAt = runningStartedAt(session);
    if (startedAt > 0 && now >= startedAt) meta = formatRuntimeDuration(now - startedAt);
    detail = String(session && session._ptyRuntimeEvidence || '').trim();
  } else if (attention === ATTENTION_REPLY_READY || completionIsLatest) {
    state = RUNTIME_STATUS_COMPLETE;
    label = '已完成';
    meta = formatCompletionAge(lastCompletedAt, now);
    const durationMs = Number(session && session.lastRunDurationMs) || 0;
    detail = durationMs > 0 ? `本轮用时 ${formatRuntimeDuration(durationMs)}` : '';
  }

  const visibleText = meta ? `${label} · ${meta}` : label;
  const ariaLabel = `${provider} ${label}`;
  const titleParts = [ariaLabel];
  if (meta) titleParts.push(meta);
  if (detail) titleParts.push(detail);

  return {
    state,
    label,
    meta,
    detail,
    provider,
    visibleText,
    ariaLabel,
    title: titleParts.join('\n'),
  };
}

module.exports = {
  RUNTIME_STATUS_RUNNING,
  RUNTIME_STATUS_WAITING,
  RUNTIME_STATUS_COMPLETE,
  RUNTIME_STATUS_IDLE,
  RUNTIME_STATUS_DORMANT,
  RUNTIME_STATUS_ERROR,
  deriveSessionRuntimeStatus,
  formatCompletionAge,
  formatRuntimeDuration,
  providerLabel,
};
