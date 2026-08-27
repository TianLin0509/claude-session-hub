'use strict';

const crypto = require('crypto');
const { appendStreamDisconnectChunk, detectStreamDisconnect } = require('./stream-disconnect.js');
const { createNightGuardState, sanitizeNightGuardState } = require('./night-guard-state.js');
const { nightGuardProvider, nightGuardProviderLabel } = require('./night-guard-provider.js');

const DEFAULT_RECOVERY_PROMPT = [
  '【夜间保护自动恢复】上一轮因网络中断而终止。',
  '请在不改变原目标的前提下，从当前会话和工作区的实际最新状态继续完成上一条未完成任务。',
  '先核对已经完成的步骤、文件和进程；不得重复已成功的写入、提交、上传或删除。',
  '若原任务其实已经完成，只验证并汇报；若缺少必须由用户授权的决定，停在等待输入状态。',
].join('\n');
const RECOVERY_PROMPT_MARKER = '【夜间保护自动恢复】';

const TERMINAL_INCIDENT_STATUSES = new Set(['completed', 'cancelled', 'blocked']);
const GOAL_TERMINAL_STATUSES = new Set(['completed', 'complete', 'achieved', 'blocked', 'cancelled', 'canceled']);

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizePromptForCompare(value) {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function meaningfulTerminalInput(value) {
  const text = String(value || '').replace(/\x1b\[(?:200|201)~/g, '');
  // Floating-input submission intentionally sends a second bare Enter as a
  // paste-mode safety net. It can arrive after the network error and must not
  // masquerade as human takeover. Real follow-up text is also confirmed later
  // by the authoritative rollout user_message event.
  return /[\x20-\x7e\u0080-\uFFFF]/.test(text);
}

function incidentKey(sessionId, turnId, signature, observedAt) {
  return crypto.createHash('sha256')
    .update([sessionId, turnId || '', signature || '', Math.floor(Number(observedAt || 0) / 1000)].join('|'))
    .digest('hex')
    .slice(0, 20);
}

class NightGuardController {
  constructor(options = {}) {
    this.getSession = options.getSession || (() => null);
    this.updateSession = options.updateSession || (() => null);
    this.getProxy = options.getProxy || (() => '');
    this.probeNetwork = options.probeNetwork || (async () => ({ ok: false, errorCode: 'probe-unavailable' }));
    this.inspectRuntime = options.inspectRuntime || (async () => ({ state: 'unknown' }));
    this.continueLiveSession = options.continueLiveSession || (async () => ({ ok: false, error: 'continue-unavailable' }));
    this.resumeInPlace = options.resumeInPlace || (async () => ({ ok: false, error: 'resume-in-place-unavailable' }));
    this.resumeDormant = options.resumeDormant || (async () => ({ ok: false, error: 'resume-dormant-unavailable' }));
    this.audit = options.audit || (() => {});
    this.logger = options.logger || console;
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.recoveryPrompt = normalizeText(options.recoveryPrompt || DEFAULT_RECOVERY_PROMPT);
    this.config = {
      graceMs: options.graceMs == null ? 10_000 : Math.max(0, Number(options.graceMs) || 0),
      healthyRoundsRequired: options.healthyRoundsRequired == null ? 3 : Math.max(1, Number(options.healthyRoundsRequired) || 1),
      healthyRoundIntervalMs: options.healthyRoundIntervalMs == null ? 10_000 : Math.max(0, Number(options.healthyRoundIntervalMs) || 0),
      quietMs: options.quietMs == null ? 30_000 : Math.max(0, Number(options.quietMs) || 0),
      failedProbeBackoffMs: Array.isArray(options.failedProbeBackoffMs) && options.failedProbeBackoffMs.length
        ? options.failedProbeBackoffMs.map(value => Math.max(0, Number(value) || 0))
        : [30_000, 60_000, 120_000, 300_000],
      maxNetworkWaitMs: options.maxNetworkWaitMs == null ? 30 * 60_000 : Math.max(1000, Number(options.maxNetworkWaitMs) || 0),
      runtimeRetryMs: options.runtimeRetryMs == null ? 5_000 : Math.max(0, Number(options.runtimeRetryMs) || 0),
      runtimeRetryMax: options.runtimeRetryMax == null ? 12 : Math.max(1, Number(options.runtimeRetryMax) || 1),
      submitAckMs: options.submitAckMs == null ? 25_000 : Math.max(1000, Number(options.submitAckMs) || 0),
      completionGraceMs: options.completionGraceMs == null ? 2_000 : Math.max(0, Number(options.completionGraceMs) || 0),
      goalCompletionFallbackMs: options.goalCompletionFallbackMs == null ? 15_000 : Math.max(0, Number(options.goalCompletionFallbackMs) || 0),
      attemptWindowMs: options.attemptWindowMs == null ? 6 * 60 * 60_000 : Math.max(1000, Number(options.attemptWindowMs) || 0),
      maxRecoveryAttempts: options.maxRecoveryAttempts == null ? 2 : Math.max(1, Number(options.maxRecoveryAttempts) || 1),
    };
    this.entries = new Map();
  }

  hydrateSession(session) {
    if (!session || !session.id && !session.hubId) return null;
    const sessionId = String(session.id || session.hubId);
    const persisted = sanitizeNightGuardState(session.nightGuard);
    if (!persisted) return null;
    const entry = this._makeEntry(sessionId, persisted);
    // A process restart cannot safely replay an in-flight timer. Keep protection
    // armed, but never auto-resume an incident whose exact PTY/turn boundary was
    // not observed by this process.
    if (entry.public.enabled && !['armed', 'off', 'completed'].includes(entry.public.status)) {
      entry.public = {
        ...entry.public,
        status: 'armed',
        incidentId: null,
        failedTurnId: null,
        failureAt: null,
        healthyRounds: 0,
        nextCheckAt: null,
        message: 'Hub 重启后已重新布防；旧故障不会被盲目重放',
        updatedAt: this.now(),
      };
      this._persist(entry);
    }
    return this.getStatus(sessionId);
  }

  _makeEntry(sessionId, state = null) {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const session = this.getSession(sessionId) || {};
    const publicState = sanitizeNightGuardState(state || session.nightGuard)
      || createNightGuardState({ enabled: false, now: this.now() });
    const entry = {
      sessionId,
      public: publicState,
      activeTurnId: publicState.activeTurnId || null,
      activeTurnStartedAt: null,
      turnOpen: false,
      streamTail: '',
      incident: null,
      timers: new Map(),
      expectedRecoveryPrompt: null,
      recoverySentAt: null,
      runtimeChecks: 0,
      pendingCompletion: null,
      sessionSnapshot: null,
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  _entry(sessionId) {
    if (!sessionId) return null;
    return this._makeEntry(String(sessionId));
  }

  _setTimer(entry, name, fn, delay) {
    this._clearTimer(entry, name);
    const timer = this.setTimer(() => {
      entry.timers.delete(name);
      Promise.resolve(fn()).catch(error => {
        this.logger.warn('[night-guard] timer failed:', error && error.message);
      });
    }, Math.max(0, Number(delay) || 0));
    if (timer && typeof timer.unref === 'function') timer.unref();
    entry.timers.set(name, timer);
    return timer;
  }

  _clearTimer(entry, name) {
    const timer = entry && entry.timers.get(name);
    if (!timer) return;
    try { this.clearTimer(timer); } catch {}
    entry.timers.delete(name);
  }

  _clearIncidentTimers(entry) {
    for (const name of ['grace', 'network', 'runtime', 'submit-ack']) this._clearTimer(entry, name);
  }

  _persist(entry, patch = {}) {
    const normalized = sanitizeNightGuardState({
      ...entry.public,
      ...patch,
      updatedAt: this.now(),
    });
    entry.public = normalized;
    try { this.updateSession(entry.sessionId, normalized); } catch (error) {
      this.logger.warn('[night-guard] session state update failed:', error && error.message);
    }
    return normalized;
  }

  _audit(entry, type, detail = {}) {
    const record = {
      ts: this.now(),
      type,
      sessionId: entry.sessionId,
      incidentId: entry.incident && entry.incident.id || entry.public.incidentId || null,
      turnId: entry.incident && entry.incident.failedTurnId || entry.activeTurnId || null,
      ...detail,
    };
    try { this.audit(record); } catch (error) {
      this.logger.warn('[night-guard] audit failed:', error && error.message);
    }
  }

  getStatus(sessionId) {
    const entry = this.entries.get(String(sessionId || ''));
    if (entry) return { ...entry.public, recoveryAttempts: [...entry.public.recoveryAttempts] };
    const session = this.getSession(sessionId);
    return sanitizeNightGuardState(session && session.nightGuard)
      || createNightGuardState({ enabled: false, now: this.now() });
  }

  canSubmitRecoveryInput(sessionId, incidentId) {
    const entry = this.entries.get(String(sessionId || ''));
    return !!(entry && entry.incident && entry.incident.id === incidentId
      && entry.public.enabled === true
      && ['resuming', 'recovering'].includes(entry.public.status));
  }

  setEnabled(sessionId, enabled, options = {}) {
    const session = this.getSession(sessionId);
    const provider = nightGuardProvider(session);
    if (!session || !provider) {
      return { ok: false, error: 'unsupported-session', message: '夜间保护当前仅支持 Claude Code 与 Codex 会话' };
    }
    const entry = this._entry(sessionId);
    this._clearIncidentTimers(entry);
    this._clearTimer(entry, 'complete');
    this._clearTimer(entry, 'goal-complete');
    entry.incident = null;
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    entry.runtimeChecks = 0;
    entry.sessionSnapshot = { ...session };

    if (!enabled) {
      this._persist(entry, {
        enabled: false,
        status: options.status || 'off',
        mode: entry.public.mode || 'manual',
        incidentId: null,
        failedTurnId: null,
        failureAt: null,
        healthyRounds: 0,
        nextCheckAt: null,
        message: options.message || '夜间保护已关闭',
      });
      this._audit(entry, 'disabled', { source: options.source || 'manual' });
      return { ok: true, state: this.getStatus(sessionId) };
    }

    const mode = options.mode === 'goal' ? 'goal' : 'manual';
    this._persist(entry, {
      enabled: true,
      mode,
      status: 'armed',
      armedAt: this.now(),
      activeTurnId: entry.activeTurnId,
      goalObjective: options.goalObjective || (mode === 'goal' ? entry.public.goalObjective : null),
      goalStatus: mode === 'goal' ? (options.goalStatus || 'active') : null,
      incidentId: null,
      failedTurnId: null,
      failureAt: null,
      healthyRounds: 0,
      nextCheckAt: null,
      lastError: null,
      message: mode === 'goal'
        ? '/goal 已自动开启夜间保护'
        : `${nightGuardProviderLabel(provider)} 夜间保护已开启，将保护下一轮任务`,
    });
    this._audit(entry, 'enabled', { source: options.source || mode, mode });
    return { ok: true, state: this.getStatus(sessionId) };
  }

  handlePromptSubmitted(event = {}) {
    const sessionId = event.hubSessionId || event.sessionId;
    if (!sessionId) return false;
    const entry = this._entry(sessionId);
    const text = normalizeText(event.text);
    const isGoal = event.signalSource === 'thread_goal_updated' || /^\/goal(?:\s+|$)/i.test(text);
    if (isGoal && !entry.public.enabled) {
      this.setEnabled(sessionId, true, {
        mode: 'goal',
        source: 'goal',
        goalObjective: text.replace(/^\/goal(?:\s+|$)/i, '').trim() || text,
        goalStatus: 'active',
      });
    }
    const submittedAt = Number(event.submittedAt) || this.now();
    entry.turnOpen = true;
    entry.activeTurnId = event.turnId || entry.activeTurnId || null;
    entry.activeTurnStartedAt = submittedAt;
    if (!entry.public.enabled) return false;

    this._clearTimer(entry, 'complete');
    this._clearTimer(entry, 'goal-complete');
    const isExpectedRecovery = !!(entry.expectedRecoveryPrompt
      && (normalizePromptForCompare(text) === normalizePromptForCompare(entry.expectedRecoveryPrompt)
        || normalizeText(text).startsWith(RECOVERY_PROMPT_MARKER))
      && submittedAt >= (entry.recoverySentAt || 0));

    if (entry.incident && !isExpectedRecovery) {
      this._cancelIncident(entry, 'human-takeover', '检测到人工输入，自动续跑已取消');
    }

    if (entry.incident && isExpectedRecovery) {
      entry.incident.recoveryTurnId = event.turnId || entry.incident.recoveryTurnId || null;
      entry.public.recoveryTurnId = entry.incident.recoveryTurnId;
      this._clearTimer(entry, 'submit-ack');
      this._persist(entry, {
        status: 'recovering',
        activeTurnId: entry.activeTurnId,
        recoveryTurnId: entry.incident.recoveryTurnId,
        nextCheckAt: null,
        message: '恢复指令已进入同一 AI 会话，正在继续任务',
      });
      this._audit(entry, 'recovery-prompt-accepted', { recoveryTurnId: entry.incident.recoveryTurnId });
    } else {
      this._persist(entry, {
        status: 'armed',
        activeTurnId: entry.activeTurnId,
        message: entry.public.mode === 'goal' ? '/goal 任务受保护' : '当前任务受夜间保护',
      });
    }
    return true;
  }

  handleTurnStarted(event = {}) {
    const sessionId = event.hubSessionId || event.sessionId;
    if (!sessionId) return false;
    const entry = this._entry(sessionId);
    const startedAt = Number(event.startedAt) || this.now();
    const turnId = event.turnId || null;
    entry.turnOpen = true;
    entry.activeTurnId = turnId || entry.activeTurnId;
    entry.activeTurnStartedAt = startedAt;
    if (!entry.public.enabled) return false;
    this._clearTimer(entry, 'complete');
    this._clearTimer(entry, 'goal-complete');

    if (entry.incident && !entry.recoverySentAt
        && entry.incident.failedTurnId && turnId
        && entry.incident.failedTurnId !== turnId) {
      // The provider itself began a new goal continuation before the guardian acted.
      // Treat that as provider recovery and never inject a duplicate prompt.
      this._cancelIncident(entry, 'native-continuation', 'AI 已自行开始后续 turn，未执行自动续跑');
    }

    if (entry.incident && entry.recoverySentAt && startedAt >= entry.recoverySentAt) {
      entry.incident.recoveryTurnId = turnId || entry.incident.recoveryTurnId || null;
      this._clearTimer(entry, 'submit-ack');
      this._persist(entry, {
        status: 'recovering',
        activeTurnId: entry.activeTurnId,
        recoveryTurnId: entry.incident.recoveryTurnId,
        nextCheckAt: null,
        message: '已观察到恢复 turn 开始执行',
      });
      this._audit(entry, 'recovery-turn-started', { recoveryTurnId: entry.incident.recoveryTurnId });
    } else if (entry.incident) {
      this._persist(entry, { activeTurnId: entry.activeTurnId });
    } else {
      this._persist(entry, { activeTurnId: entry.activeTurnId, status: 'armed' });
    }
    return true;
  }

  handleTurnComplete(event = {}) {
    const sessionId = event.hubSessionId || event.sessionId;
    if (!sessionId) return false;
    const entry = this._entry(sessionId);
    const completionIssue = entry.incident ? detectStreamDisconnect(event.text) : null;
    if (completionIssue) {
      // Claude records API failures as synthetic assistant entries. A Stop hook
      // may therefore surface the same error through the normal completion
      // parser after StopFailure/PTY already established the incident. Treat it
      // only as corroboration; it must never masquerade as late success.
      entry.turnOpen = false;
      entry.incident.corroborated = true;
      this._audit(entry, 'failure-corroborated', {
        source: event.signalSource || 'completion-error-text',
        message: completionIssue.message,
      });
      return true;
    }
    const completedAt = Number(event.completedAt) || this.now();
    const turnId = event.turnId || null;
    entry.turnOpen = false;
    if (!entry.public.enabled) return false;

    if (entry.incident) {
      const incident = entry.incident;
      const lateOriginalSuccess = !incident.recoverySentAt
        && (!incident.failedTurnId || !turnId || incident.failedTurnId === turnId);
      const recoverySuccess = !!incident.recoverySentAt
        && (incident.recoveryTurnId
          ? (!turnId || incident.recoveryTurnId === turnId)
          : completedAt >= incident.recoverySentAt);
      if (lateOriginalSuccess || recoverySuccess) {
        this._resolveSuccess(entry, {
          completedAt,
          turnId,
          reason: lateOriginalSuccess ? 'late-original-success' : 'recovery-success',
        });
        return true;
      }
    }

    if (entry.public.mode === 'goal') {
      this._setTimer(entry, 'goal-complete', () => {
        if (!entry.public.enabled || entry.turnOpen || entry.public.goalStatus === 'completed') return;
        this._finishProtection(entry, 'completed', '目标任务已完成，夜间保护自动关闭', completedAt);
      }, this.config.goalCompletionFallbackMs);
      this._persist(entry, { status: 'armed', message: '本轮完成，等待 /goal 最终状态确认' });
      return true;
    }

    if (entry.public.autoCloseOnSuccess) {
      this._setTimer(entry, 'complete', () => {
        if (!entry.turnOpen && entry.public.enabled) {
          this._finishProtection(entry, 'completed', '任务已完成，夜间保护自动关闭', completedAt);
        }
      }, this.config.completionGraceMs);
    }
    return true;
  }

  handleTurnAborted(event = {}) {
    const sessionId = event.hubSessionId || event.sessionId;
    if (!sessionId) return false;
    const entry = this._entry(sessionId);
    entry.turnOpen = false;
    if (!entry.public.enabled) return false;
    this._cancelIncident(entry, 'turn-aborted', '当前 turn 已被中断，未执行自动续跑');
    this._finishProtection(entry, 'cancelled', '任务已中断，夜间保护自动关闭', Number(event.abortedAt) || this.now());
    return true;
  }

  handleGoalUpdated(event = {}) {
    const sessionId = event.hubSessionId || event.sessionId;
    if (!sessionId) return false;
    const status = String(event.status || '').trim().toLowerCase();
    const objective = normalizeText(event.objective);
    const entry = this._entry(sessionId);
    if (status === 'active') {
      if (!entry.public.enabled) {
        this.setEnabled(sessionId, true, {
          mode: 'goal', source: 'goal', goalObjective: objective, goalStatus: status,
        });
      } else {
        this._persist(entry, {
          mode: 'goal', goalObjective: objective || entry.public.goalObjective,
          goalStatus: status, status: entry.incident ? entry.public.status : 'armed',
        });
      }
      return true;
    }
    if (!GOAL_TERMINAL_STATUSES.has(status) || !entry.public.enabled) return false;
    entry.turnOpen = false;
    if (entry.incident && (status === 'completed' || status === 'complete' || status === 'achieved')) {
      this._audit(entry, 'incident-resolved', {
        reason: 'goal-completed',
        completedAt: Number(event.observedAt) || this.now(),
      });
    }
    this._clearIncidentTimers(entry);
    entry.incident = null;
    const finalStatus = status === 'blocked' ? 'blocked' : (status.startsWith('cancel') ? 'cancelled' : 'completed');
    const message = status === 'blocked'
      ? '/goal 已阻塞，夜间保护停止并等待人工处理'
      : (status.startsWith('cancel') ? '/goal 已取消，夜间保护自动关闭' : '/goal 已完成，夜间保护自动关闭');
    entry.public = { ...entry.public, goalStatus: status };
    this._finishProtection(entry, finalStatus, message, Number(event.observedAt) || this.now());
    return true;
  }

  handleTurnFailed(event = {}) {
    const sessionId = event.hubSessionId || event.sessionId;
    if (!sessionId) return false;
    const message = normalizeText(event.message || event.error);
    const issue = detectStreamDisconnect(message);
    if (!issue) return false;
    const entry = this._entry(sessionId);
    const source = event.signalSource || 'rollout-task-error';
    if (!entry.public.enabled || !entry.turnOpen) return false;
    if (!entry.incident) {
      return this._startIncident(entry, issue, {
        observedAt: Number(event.failedAt || event.completedAt) || this.now(),
        turnId: event.turnId || entry.activeTurnId,
        source,
      });
    }
    entry.incident.corroborated = true;
    if (event.turnId) entry.incident.failedTurnId = event.turnId;
    this._persist(entry, { failedTurnId: entry.incident.failedTurnId });
    this._audit(entry, 'failure-corroborated', { source });
    return true;
  }

  handlePtyData(sessionId, data) {
    const entry = this._entry(sessionId);
    if (!entry || !entry.public.enabled || !entry.turnOpen) return false;
    const previousIssue = detectStreamDisconnect(entry.streamTail);
    const tracked = appendStreamDisconnectChunk(entry.streamTail, data);
    entry.streamTail = tracked.tail;
    if (!tracked.issue) return false;
    // Edge-trigger only. Once a final red line is in the bounded tail, ordinary
    // repaint/output chunks must not repeatedly re-fire that historical error.
    if (previousIssue && previousIssue.signature === tracked.issue.signature) return false;
    if (entry.incident) {
      if (entry.recoverySentAt && ['resuming', 'recovering'].includes(entry.public.status)) {
        this._restartAfterRecoveryFailure(entry, tracked.issue);
        return true;
      }
      return false;
    }
    return this._startIncident(entry, tracked.issue, {
      observedAt: this.now(),
      turnId: entry.activeTurnId,
      source: 'pty-final-stream-error',
    });
  }

  handleUserInput(sessionId, data) {
    const entry = this.entries.get(String(sessionId || ''));
    if (!entry || !entry.public.enabled || !entry.incident || !meaningfulTerminalInput(data)) return false;
    this._cancelIncident(entry, 'human-takeover', '检测到人工输入，自动续跑已取消');
    return true;
  }

  _startIncident(entry, issue, options = {}) {
    const observedAt = Number(options.observedAt) || this.now();
    const turnId = options.turnId || entry.activeTurnId || null;
    const id = incidentKey(entry.sessionId, turnId, issue.signature, observedAt);
    if (entry.public.incidentId === id && !TERMINAL_INCIDENT_STATUSES.has(entry.public.status)) return false;
    entry.sessionSnapshot = { ...(this.getSession(entry.sessionId) || entry.sessionSnapshot || {}) };
    const provider = nightGuardProvider(entry.sessionSnapshot);
    entry.incident = {
      id,
      failedTurnId: turnId,
      failureAt: observedAt,
      signature: issue.signature,
      message: issue.message,
      source: options.source || 'unknown',
      provider,
      healthyRounds: 0,
      failedProbeCount: 0,
      lastFailedProbeAt: observedAt,
      recoverySentAt: null,
      recoveryTurnId: null,
    };
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    entry.runtimeChecks = 0;
    this._persist(entry, {
      status: 'grace',
      incidentId: id,
      failedTurnId: turnId,
      failureAt: observedAt,
      healthyRounds: 0,
      nextCheckAt: observedAt + this.config.graceMs,
      lastError: issue.message,
      message: '确认最终断流，等待同一 turn 的迟到完成事件',
    });
    this._audit(entry, 'incident-detected', {
      source: entry.incident.source,
      provider,
      message: issue.message,
    });
    this._setTimer(entry, 'grace', () => this._beginNetworkWait(entry), this.config.graceMs);
    return true;
  }

  _beginNetworkWait(entry) {
    if (!entry.incident || !entry.public.enabled) return;
    this._persist(entry, {
      status: 'waiting-network',
      healthyRounds: entry.incident.healthyRounds,
      nextCheckAt: this.now(),
      message: '等待代理连续稳定，尚未发送恢复指令',
    });
    return this._probeRound(entry);
  }

  async _probeRound(entry) {
    const incident = entry.incident;
    if (!incident || !entry.public.enabled) return;
    if (this.now() - incident.failureAt > this.config.maxNetworkWaitMs) {
      this._block(entry, 'network-wait-timeout', '网络在保护窗口内未稳定，已熔断等待人工处理');
      return;
    }
    const proxy = this.getProxy(entry.sessionId, entry.sessionSnapshot);
    let result;
    try {
      result = await this.probeNetwork({
        proxy,
        provider: incident.provider,
        sessionId: entry.sessionId,
        incidentId: incident.id,
      });
    } catch (error) {
      result = { ok: false, errorCode: 'probe-threw', error: String(error && error.message || error) };
    }
    if (!entry.incident || entry.incident.id !== incident.id || !entry.public.enabled) return;
    this._audit(entry, 'network-probe', {
      ok: result && result.ok === true,
      provider: incident.provider,
      errorCode: result && result.errorCode || null,
      endpoints: Array.isArray(result && result.endpoints)
        ? result.endpoints.map(item => ({ name: item.name, ok: item.ok, httpCode: item.httpCode || 0 }))
        : [],
    });
    if (result && result.ok === true) {
      incident.healthyRounds += 1;
      const quietEnough = this.now() - Math.max(incident.failureAt, incident.lastFailedProbeAt || 0) >= this.config.quietMs;
      if (incident.healthyRounds >= this.config.healthyRoundsRequired && quietEnough) {
        this._persist(entry, {
          healthyRounds: incident.healthyRounds,
          nextCheckAt: null,
          message: '代理已连续稳定，正在确认 AI 运行态',
        });
        await this._recover(entry);
        return;
      }
      const next = this.now() + this.config.healthyRoundIntervalMs;
      this._persist(entry, {
        status: 'waiting-network',
        healthyRounds: incident.healthyRounds,
        nextCheckAt: next,
        message: `网络健康 ${incident.healthyRounds}/${this.config.healthyRoundsRequired}，继续观察`,
      });
      this._setTimer(entry, 'network', () => this._probeRound(entry), this.config.healthyRoundIntervalMs);
      return;
    }

    incident.healthyRounds = 0;
    incident.failedProbeCount += 1;
    incident.lastFailedProbeAt = this.now();
    const backoff = this.config.failedProbeBackoffMs[
      Math.min(incident.failedProbeCount - 1, this.config.failedProbeBackoffMs.length - 1)
    ];
    this._persist(entry, {
      status: 'waiting-network',
      healthyRounds: 0,
      nextCheckAt: this.now() + backoff,
      message: `代理仍不可用，${Math.ceil(backoff / 1000)} 秒后复核`,
    });
    this._setTimer(entry, 'network', () => this._probeRound(entry), backoff);
  }

  _recentAttempts(entry) {
    const cutoff = this.now() - this.config.attemptWindowMs;
    return (entry.public.recoveryAttempts || []).filter(ts => Number(ts) >= cutoff);
  }

  async _recover(entry) {
    const incident = entry.incident;
    if (!incident || !entry.public.enabled) return;
    const attempts = this._recentAttempts(entry);
    if (attempts.length >= this.config.maxRecoveryAttempts) {
      this._block(entry, 'attempt-limit', `6 小时内已自动续跑 ${attempts.length} 次，已熔断`);
      return;
    }

    let runtime;
    try { runtime = await this.inspectRuntime(entry.sessionId, entry.sessionSnapshot); }
    catch (error) { runtime = { state: 'unknown', error: String(error && error.message || error) }; }
    if (!entry.incident || entry.incident.id !== incident.id || !entry.public.enabled) return;
    const state = String(runtime && runtime.state || 'unknown');
    if (state === 'running') {
      entry.runtimeChecks += 1;
      if (entry.runtimeChecks > this.config.runtimeRetryMax) {
        this._block(entry, 'runtime-still-running', 'AI 仍显示运行中，拒绝注入重复任务');
        return;
      }
      this._persist(entry, {
        status: 'waiting-runtime',
        nextCheckAt: this.now() + this.config.runtimeRetryMs,
        message: 'AI 仍显示运行中，等待其自行收口',
      });
      this._setTimer(entry, 'runtime', () => this._recover(entry), this.config.runtimeRetryMs);
      return;
    }
    if (state === 'waiting') {
      this._block(entry, 'interactive-confirmation', 'AI 正在等待权限或用户确认，不能自动越权');
      return;
    }
    if (state === 'unknown') {
      entry.runtimeChecks += 1;
      if (entry.runtimeChecks > this.config.runtimeRetryMax) {
        this._block(entry, 'runtime-ambiguous', '无法确认 AI 输入框是否安全，未执行自动续跑');
        return;
      }
      this._persist(entry, {
        status: 'waiting-runtime',
        nextCheckAt: this.now() + this.config.runtimeRetryMs,
        message: 'AI 当前画面不明确，等待可验证的输入框',
      });
      this._setTimer(entry, 'runtime', () => this._recover(entry), this.config.runtimeRetryMs);
      return;
    }

    const attemptAt = this.now();
    const nextAttempts = [...attempts, attemptAt].slice(-8);
    incident.recoverySentAt = attemptAt;
    entry.recoverySentAt = attemptAt;
    entry.expectedRecoveryPrompt = this.recoveryPrompt;
    entry.streamTail = '';
    this._persist(entry, {
      status: 'resuming',
      recoveryAttempts: nextAttempts,
      lastRecoveryAt: attemptAt,
      healthyRounds: incident.healthyRounds,
      nextCheckAt: attemptAt + this.config.submitAckMs,
      message: state === 'host-shell' || state === 'missing'
        ? '正在精确恢复原生会话 ID 并提交续跑指令'
        : '正在向原 AI PTY 提交一次续跑指令',
    });

    let action;
    try {
      if (state === 'idle') {
        action = await this.continueLiveSession({
          sessionId: entry.sessionId, prompt: this.recoveryPrompt, incidentId: incident.id,
        });
      } else if (state === 'host-shell') {
        action = await this.resumeInPlace({
          sessionId: entry.sessionId, prompt: this.recoveryPrompt,
          incidentId: incident.id, session: entry.sessionSnapshot,
        });
      } else if (state === 'missing') {
        action = await this.resumeDormant({
          sessionId: entry.sessionId, prompt: this.recoveryPrompt,
          incidentId: incident.id, session: entry.sessionSnapshot,
        });
      } else {
        action = { ok: false, error: `unsupported-runtime-state:${state}` };
      }
    } catch (error) {
      action = { ok: false, error: String(error && error.message || error) };
    }
    if (!entry.incident || entry.incident.id !== incident.id || !entry.public.enabled) return;
    if (!action || action.ok !== true) {
      this._block(entry, 'recovery-action-failed', `恢复动作未执行：${String(action && action.error || 'unknown').slice(0, 160)}`);
      return;
    }
    this._audit(entry, 'recovery-action-sent', { route: state, attemptAt });
    this._setTimer(entry, 'submit-ack', () => {
      if (!entry.incident || entry.incident.id !== incident.id) return;
      if (entry.public.status === 'resuming') {
        this._block(entry, 'recovery-not-acknowledged', '恢复指令未产生新的 task_started，未重复发送');
      }
    }, this.config.submitAckMs);
  }

  _restartAfterRecoveryFailure(entry, issue) {
    if (!entry.incident) return;
    this._clearIncidentTimers(entry);
    entry.incident.message = issue.message;
    entry.incident.signature = issue.signature;
    entry.incident.healthyRounds = 0;
    entry.incident.failedProbeCount += 1;
    entry.incident.lastFailedProbeAt = this.now();
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    entry.incident.recoverySentAt = null;
    entry.incident.recoveryTurnId = null;
    this._persist(entry, {
      status: 'waiting-network',
      healthyRounds: 0,
      recoveryTurnId: null,
      nextCheckAt: this.now() + this.config.failedProbeBackoffMs[0],
      lastError: issue.message,
      message: '续跑时再次断流，退避后重新验证网络',
    });
    this._audit(entry, 'recovery-stream-disconnected', { message: issue.message });
    this._setTimer(entry, 'network', () => this._probeRound(entry), this.config.failedProbeBackoffMs[0]);
  }

  _resolveSuccess(entry, options = {}) {
    const completedAt = Number(options.completedAt) || this.now();
    this._audit(entry, 'incident-resolved', { reason: options.reason || 'success', completedAt });
    this._clearIncidentTimers(entry);
    entry.incident = null;
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    entry.streamTail = '';
    if (entry.public.mode === 'goal' && entry.public.goalStatus === 'active') {
      this._persist(entry, {
        status: 'armed',
        incidentId: null,
        failedTurnId: null,
        failureAt: null,
        healthyRounds: 0,
        nextCheckAt: null,
        recoveryTurnId: null,
        lastSuccessAt: completedAt,
        lastError: null,
        message: '本轮已恢复完成，继续保护 /goal 后续执行',
      });
      return;
    }
    this._finishProtection(entry, 'completed', '任务已恢复并完成，夜间保护自动关闭', completedAt);
  }

  _finishProtection(entry, status, message, completedAt) {
    this._clearIncidentTimers(entry);
    this._clearTimer(entry, 'complete');
    this._clearTimer(entry, 'goal-complete');
    entry.incident = null;
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    entry.activeTurnId = null;
    entry.turnOpen = false;
    this._persist(entry, {
      enabled: false,
      status,
      activeTurnId: null,
      incidentId: null,
      failedTurnId: null,
      failureAt: null,
      healthyRounds: 0,
      nextCheckAt: null,
      recoveryTurnId: null,
      lastSuccessAt: status === 'completed' ? completedAt : entry.public.lastSuccessAt,
      lastError: status === 'completed' ? null : entry.public.lastError,
      message,
    });
    this._audit(entry, 'protection-finished', { status, message });
  }

  _cancelIncident(entry, reason, message) {
    if (!entry.incident) return false;
    this._audit(entry, 'incident-cancelled', { reason });
    this._clearIncidentTimers(entry);
    entry.incident = null;
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    entry.runtimeChecks = 0;
    entry.streamTail = '';
    this._persist(entry, {
      status: entry.public.enabled ? 'armed' : 'cancelled',
      incidentId: null,
      failedTurnId: null,
      failureAt: null,
      healthyRounds: 0,
      nextCheckAt: null,
      recoveryTurnId: null,
      message,
    });
    return true;
  }

  _block(entry, reason, message) {
    this._audit(entry, 'incident-blocked', { reason, message });
    this._clearIncidentTimers(entry);
    entry.expectedRecoveryPrompt = null;
    entry.recoverySentAt = null;
    this._persist(entry, {
      enabled: false,
      status: 'blocked',
      healthyRounds: entry.incident && entry.incident.healthyRounds || 0,
      nextCheckAt: null,
      message,
    });
    entry.incident = null;
  }

  dispose() {
    for (const entry of this.entries.values()) {
      for (const name of [...entry.timers.keys()]) this._clearTimer(entry, name);
    }
    this.entries.clear();
  }
}

function createNightGuardController(options) {
  return new NightGuardController(options);
}

module.exports = {
  DEFAULT_RECOVERY_PROMPT,
  RECOVERY_PROMPT_MARKER,
  NightGuardController,
  createNightGuardController,
  meaningfulTerminalInput,
  normalizePromptForCompare,
  normalizeText,
};
