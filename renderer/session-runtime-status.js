'use strict';

const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_COMPLETED,
  RUNTIME_IDLE,
  RUNTIME_FAILED,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  getSessionRuntimeTruth,
  runtimeConfidenceLabel,
  runtimeLabel,
  runtimeSourceLabel,
} = require('../core/session-runtime-truth.js');
const { sessionNeedsUserInput } = require('../core/session-attention-state.js');
const { hasStreamDisconnectIssue } = require('../core/stream-disconnect.js');
const { normalizeQuestionSummary } = require('./card-question-navigator.js');

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

function legacyRunningStartedAt(session) {
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
  let truth = getSessionRuntimeTruth(session, { now });
  if (options.isRunning === true && [RUNTIME_IDLE, RUNTIME_COMPLETED, RUNTIME_UNKNOWN].includes(truth.state)) {
    truth = {
      ...truth,
      state: RUNTIME_RUNNING,
      source: session && (session.cardWorkingSource || session._runSource) || 'legacy-card-working',
      startedAt: legacyRunningStartedAt(session) || now,
      evidence: session && session._ptyRuntimeEvidence || truth.evidence || null,
    };
  }
  const state = truth.state;
  const label = runtimeLabel(state);
  let meta = '';
  let detail = '';

  if (state === RUNTIME_DORMANT) {
    detail = '点击会话可恢复原生 CLI';
  } else if (state === RUNTIME_FAILED) {
    detail = String(truth.evidence || session && (session.lastError || session.error) || '').trim();
  } else if (state === RUNTIME_WAITING) {
    meta = '需要操作';
    detail = String(truth.evidence || session && session.waitingText || '').trim();
  } else if (state === RUNTIME_STARTING || state === RUNTIME_RUNNING) {
    const startedAt = Number(truth.startedAt) || legacyRunningStartedAt(session);
    if (startedAt > 0 && now >= startedAt) meta = formatRuntimeDuration(now - startedAt);
    detail = String(
      session && session.currentCardActivity && session.currentCardActivity.label
      || truth.evidence
      || session && session._ptyRuntimeEvidence
      || '',
    ).trim();
  } else if (state === RUNTIME_COMPLETED) {
    const completedAt = Number(truth.completedAt) || Number(session && session.lastCompletedAt) || 0;
    meta = formatCompletionAge(completedAt, now);
    const durationMs = Number(session && session.lastRunDurationMs) || 0;
    detail = durationMs > 0 ? `本轮用时 ${formatRuntimeDuration(durationMs)}` : '';
  } else if (state === RUNTIME_UNKNOWN) {
    detail = truth.reason === 'observation-expired'
      ? '最近的运行信号已过期，等待新的语义事件或 PTY 证据'
      : String(truth.evidence || '').trim();
  }

  const visibleText = meta ? `${label} · ${meta}` : label;
  const visibleDetail = [RUNTIME_STARTING, RUNTIME_RUNNING, RUNTIME_WAITING, RUNTIME_FAILED, RUNTIME_UNKNOWN].includes(state)
    ? detail.replace(/\s+/g, ' ').slice(0, 180)
    : '';
  const ariaLabel = `${provider} ${label}`;
  const titleParts = [ariaLabel];
  if (meta) titleParts.push(meta);
  if (detail) titleParts.push(detail);
  if (truth.source) {
    titleParts.push(`判断依据：${runtimeSourceLabel(truth.source)} · ${runtimeConfidenceLabel(truth.confidence)}`);
  }
  if (Array.isArray(truth.corroborations) && truth.corroborations.length) {
    titleParts.push(`交叉验证：${truth.corroborations.map(item => runtimeSourceLabel(item.source)).join('、')}`);
  }

  return {
    state,
    label,
    meta,
    detail,
    visibleDetail,
    provider,
    source: truth.source,
    confidence: truth.confidence,
    observedAt: truth.observedAt,
    visibleText,
    ariaLabel,
    title: titleParts.join('\n'),
  };
}


// ── Composer 状态行（T1 冷杉 v2）──────────────────────────────────────────
// 舞台头部的状态徽章和 composer 状态行说的是同一件事，所以它们共用
// deriveSessionRuntimeStatus 的**同一个结论**，只是把它折成四档展示态。
// 复制一份判据 = 两个地方迟早说出互相矛盾的话，这里刻意不那么做。

const COMPOSER_STATUS_READY = 'ready';
const COMPOSER_STATUS_WORKING = 'working';
const COMPOSER_STATUS_WAITING = 'waiting';
const COMPOSER_STATUS_DEAD = 'dead';

// 状态行要的是「38s」这种口语时长，不是头部徽章的 mm:ss 计时器。
function formatRuntimeSeconds(value) {
  const totalSeconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

// CLI 把选项摆成编号行时（「1. 是，继续 / 2. 先看 diff」）解析成快捷答复。
// 解析不出来就返回空数组 —— 宁可不给 chip，也不要造一个用户点了会答错的按钮。
// 只有一条候选不算选择题，同样不渲染。
function parseQuickReplyOptions(text, { max = 4, maxLength = 18 } = {}) {
  const seen = new Set();
  const options = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:[>›❯▶*-]\s*)?(\d{1,2})\s*[.)、．]\s*(.+?)\s*$/);
    if (!match) continue;
    const label = String(match[2])
      .replace(/\s*\(default\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || label.length > maxLength) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
    if (options.length >= max) break;
  }
  return options.length >= 2 ? options : [];
}

// 把编号选项行从问题正文里摘掉，剩下的才是「AI 到底在问什么」。
function stripQuickReplyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[>›❯▶*-]\s*)?\d{1,2}\s*[.)、．]\s+\S/.test(line))
    .join('\n')
    .trim();
}

function composerStateFor(runtimeState, { needsRespond = false, disconnected = false } = {}) {
  // 断开优先于一切：休眠会话上残留的 waitingText 不该冒充「在等你回答」，
  // 那会让用户对着一个收不到消息的会话打字。
  if (disconnected || runtimeState === RUNTIME_DORMANT || runtimeState === RUNTIME_FAILED) {
    return COMPOSER_STATUS_DEAD;
  }
  if (needsRespond || runtimeState === RUNTIME_WAITING) return COMPOSER_STATUS_WAITING;
  if (runtimeState === RUNTIME_STARTING || runtimeState === RUNTIME_RUNNING) return COMPOSER_STATUS_WORKING;
  return COMPOSER_STATUS_READY;
}

/**
 * Composer 状态行的展示模型。纯函数：同一个 session + now 永远给同一个结果。
 * @returns {{ state: string, text: string, detail: string, quickReplies: string[],
 *   action: { kind: string, label: string }|null, canStop: boolean, runtime: object }}
 */
function buildComposerStatusModel(session, options = {}) {
  const now = Number(options.now) || Date.now();
  const runtime = options.runtime || deriveSessionRuntimeStatus(session, { ...options, now });
  // 「等你响应」的判据与 respond-pill 完全一致（sessionNeedsUserInput），
  // 区别只在 pill 会跳过当前会话 —— composer 说的就是当前会话，所以不跳过。
  const needsRespond = sessionNeedsUserInput(session);
  const disconnected = hasStreamDisconnectIssue(session);
  const state = composerStateFor(runtime.state, { needsRespond, disconnected });
  const provider = runtime.provider || 'AI';

  if (state === COMPOSER_STATUS_WORKING) {
    const startedAt = Number(session && session.runStartedAt) || legacyRunningStartedAt(session);
    const elapsed = startedAt > 0 && now >= startedAt ? formatRuntimeSeconds(now - startedAt) : '';
    return {
      state,
      text: elapsed ? `${provider} 正在工作 · ${elapsed}` : `${provider} 正在工作`,
      detail: runtime.visibleDetail || '',
      quickReplies: [],
      action: null,
      canStop: true,
      runtime,
    };
  }

  if (state === COMPOSER_STATUS_WAITING) {
    const raw = String((session && session.waitingText) || runtime.detail || '').trim();
    const quickReplies = parseQuickReplyOptions(raw);
    // 选项行属于「快捷答复」那一行，不该再挤进问题摘要里念一遍。
    const question = quickReplies.length ? stripQuickReplyLines(raw) : raw;
    const summary = question ? normalizeQuestionSummary(question, 48) : '';
    return {
      state,
      text: summary ? `${provider} 在等你回答：「${summary}」` : `${provider} 在等你回答`,
      detail: '',
      quickReplies,
      action: null,
      canStop: false,
      runtime,
    };
  }

  if (state === COMPOSER_STATUS_DEAD) {
    const issue = session && session.connectionIssue;
    const reason = String(
      (disconnected && issue && (issue.reason || issue.detail))
      // 休眠不是故障，它的 detail 是一句操作提示（「点击会话可恢复原生 CLI」），
      // 拿来当断开原因念出来是答非所问。
      || (runtime.state === RUNTIME_DORMANT ? '会话已休眠' : '')
      || runtime.detail
      || (session && (session.lastError || session.error || session.spawnError)),
    ).replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      state,
      text: reason
        ? `会话已断开（${reason}）· 输入会在重连后发送`
        : '会话已断开 · 输入会在重连后发送',
      detail: '',
      quickReplies: [],
      action: { kind: 'reconnect', label: '重连' },
      canStop: false,
      runtime,
    };
  }

  // 就绪：runtime.meta 在 COMPLETED 下就是 formatCompletionAge 的结果（「2 分钟前」）。
  const age = runtime.state === RUNTIME_COMPLETED ? String(runtime.meta || '').trim() : '';
  return {
    state: COMPOSER_STATUS_READY,
    text: age ? `已就绪 · ${age}完成上一轮` : '已就绪',
    detail: '',
    quickReplies: [],
    action: age ? { kind: 'scroll-latest', label: '查看上一轮 ↑' } : null,
    canStop: false,
    runtime,
  };
}

module.exports = {
  COMPOSER_STATUS_DEAD,
  COMPOSER_STATUS_READY,
  COMPOSER_STATUS_WAITING,
  COMPOSER_STATUS_WORKING,
  RUNTIME_STATUS_STARTING: RUNTIME_STARTING,
  RUNTIME_STATUS_RUNNING: RUNTIME_RUNNING,
  RUNTIME_STATUS_WAITING: RUNTIME_WAITING,
  RUNTIME_STATUS_COMPLETED: RUNTIME_COMPLETED,
  RUNTIME_STATUS_IDLE: RUNTIME_IDLE,
  RUNTIME_STATUS_FAILED: RUNTIME_FAILED,
  RUNTIME_STATUS_DORMANT: RUNTIME_DORMANT,
  RUNTIME_STATUS_UNKNOWN: RUNTIME_UNKNOWN,
  buildComposerStatusModel,
  composerStateFor,
  deriveSessionRuntimeStatus,
  formatCompletionAge,
  formatRuntimeDuration,
  formatRuntimeSeconds,
  parseQuickReplyOptions,
  providerLabel,
};
