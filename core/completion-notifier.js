'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_NOTIFICATION_CONFIG = Object.freeze({
  enabled: false,
  provider: 'serverchan',
  serverchanSendKey: '',
  includePreview: false,
  previewChars: 160,
  notifyGroupChats: true,
});

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000, 10_000, 60_000]);
const DEDUPE_WINDOW_MS = 30_000;
const RECENT_EVENT_TTL_MS = 30 * 60_000;
const MAX_RECENT_EVENTS = 500;
const AUDIT_TAIL_BYTES = 64 * 1024;

function readLastDeliveryAudit(logPath) {
  if (!logPath) return null;
  let fd = null;
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const length = Math.min(AUDIT_TAIL_BYTES, stat.size);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || (record.status !== 'sent' && record.status !== 'failed')) continue;
      const timestamp = Date.parse(record.ts);
      if (!Number.isFinite(timestamp)) continue;
      return {
        status: record.status,
        timestamp,
        attempt: Number(record.attempt) || 1,
        errorCode: record.errorCode || null,
        transient: record.transient === true,
        statusCode: Number.isFinite(Number(record.statusCode)) ? Number(record.statusCode) : null,
        providerCode: record.providerCode == null ? null : String(record.providerCode),
      };
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return !!value;
}

function normalizeNotificationConfig(raw = {}, env = process.env) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const serverchan = source.serverchan && typeof source.serverchan === 'object'
    ? source.serverchan
    : {};
  const envSendKey = String(env.HUB_NOTIFY_SERVERCHAN_SENDKEY || '').trim();
  const rawSendKey = source.serverchanSendKey !== undefined
    ? source.serverchanSendKey
    : serverchan.send_key;
  const envEnabled = env.HUB_NOTIFY_ENABLED;

  return {
    enabled: normalizeBoolean(
      envEnabled !== undefined ? envEnabled : source.enabled,
      DEFAULT_NOTIFICATION_CONFIG.enabled,
    ),
    provider: 'serverchan',
    serverchanSendKey: envSendKey || String(rawSendKey || '').trim(),
    includePreview: normalizeBoolean(
      source.includePreview !== undefined ? source.includePreview : source.include_preview,
      DEFAULT_NOTIFICATION_CONFIG.includePreview,
    ),
    previewChars: clampInteger(
      source.previewChars !== undefined ? source.previewChars : source.preview_chars,
      DEFAULT_NOTIFICATION_CONFIG.previewChars,
      40,
      400,
    ),
    notifyGroupChats: normalizeBoolean(
      source.notifyGroupChats !== undefined ? source.notifyGroupChats : source.notify_group_chats,
      DEFAULT_NOTIFICATION_CONFIG.notifyGroupChats,
    ),
  };
}

function maskSecret(secret) {
  const value = String(secret || '');
  return value ? `***${value.slice(-4)}` : '';
}

function isUsableSendKey(sendKey) {
  const value = String(sendKey || '').trim();
  return value.length >= 8 && !/[\s/\\]/.test(value);
}

function cleanInlineText(value, maxLength = 80) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function cleanPreview(value, maxLength) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '未记录';
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function formatCompletedAt(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  try {
    return date.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return date.toISOString();
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

class NotificationDeliveryError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'NotificationDeliveryError';
    this.code = code;
    this.transient = !!options.transient;
    this.statusCode = Number.isFinite(options.statusCode) ? options.statusCode : null;
    this.providerCode = options.providerCode !== undefined && options.providerCode !== null
      ? String(options.providerCode).slice(0, 40)
      : null;
  }
}

async function sendServerChan(payload, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new NotificationDeliveryError('fetch_unavailable');
  }
  if (!isUsableSendKey(payload.sendKey)) {
    throw new NotificationDeliveryError('invalid_sendkey');
  }

  const endpointBuilder = options.endpointBuilder
    || (sendKey => `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`);
  const timeoutMs = clampInteger(options.timeoutMs, 7_000, 1_000, 30_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  let response;
  try {
    response = await fetchImpl(endpointBuilder(payload.sendKey), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        title: cleanInlineText(payload.title, 32),
        desp: String(payload.desp || ''),
      }).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    const timeoutLike = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    throw new NotificationDeliveryError(timeoutLike ? 'timeout' : 'network_error', { transient: true });
  } finally {
    clearTimeout(timeout);
  }

  let responseText = '';
  try { responseText = await response.text(); } catch {}
  let responseJson = null;
  try { responseJson = responseText ? JSON.parse(responseText) : null; } catch {}

  if (!response.ok) {
    const statusCode = Number(response.status) || null;
    throw new NotificationDeliveryError('http_error', {
      transient: statusCode === 408 || statusCode === 429 || statusCode >= 500,
      statusCode,
      providerCode: responseJson && responseJson.code,
    });
  }

  if (!responseJson || Number(responseJson.code) !== 0) {
    throw new NotificationDeliveryError(responseJson ? 'provider_rejected' : 'invalid_response', {
      transient: !responseJson,
      statusCode: Number(response.status) || null,
      providerCode: responseJson && responseJson.code,
    });
  }

  return {
    ok: true,
    statusCode: Number(response.status) || 200,
    providerCode: String(responseJson.code),
  };
}

class CompletionNotifier {
  constructor(options = {}) {
    this.getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({});
    this.getLogPath = typeof options.getLogPath === 'function' ? options.getLogPath : () => null;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.endpointBuilder = options.endpointBuilder;
    this.timeoutMs = clampInteger(options.timeoutMs, 7_000, 1_000, 30_000);
    this.retryDelaysMs = Array.isArray(options.retryDelaysMs)
      ? options.retryDelaysMs.map(value => Math.max(0, Number(value) || 0))
      : [...DEFAULT_RETRY_DELAYS_MS];
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.promptSubmittedAt = new Map();
    this.recentEvents = new Map();
    this.retryTimers = new Set();
    this.lastDelivery = readLastDeliveryAudit(this.getLogPath());
  }

  notePromptSubmitted(event = {}) {
    if (!event.hubSessionId) return;
    this.promptSubmittedAt.set(
      String(event.hubSessionId),
      Number(event.submittedAt) || this.now(),
    );
  }

  _currentConfig() {
    const root = this.getConfig() || {};
    return normalizeNotificationConfig(root.notifications || root);
  }

  _durationFor(event = {}) {
    const hasExplicit = event.durationMs !== undefined && event.durationMs !== null;
    const explicit = hasExplicit ? Number(event.durationMs) : NaN;
    const sessionId = event.hubSessionId ? String(event.hubSessionId) : '';
    const submittedAt = sessionId ? this.promptSubmittedAt.get(sessionId) : null;
    if (sessionId) this.promptSubmittedAt.delete(sessionId);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    if (Number.isFinite(submittedAt)) return Math.max(0, this.now() - submittedAt);
    return null;
  }

  _claimEvent(eventId) {
    const now = this.now();
    const previous = this.recentEvents.get(eventId);
    if (Number.isFinite(previous) && now - previous < DEDUPE_WINDOW_MS) return false;
    this.recentEvents.set(eventId, now);

    if (this.recentEvents.size > MAX_RECENT_EVENTS) {
      for (const [id, timestamp] of this.recentEvents) {
        if (now - timestamp > RECENT_EVENT_TTL_MS || this.recentEvents.size > MAX_RECENT_EVENTS) {
          this.recentEvents.delete(id);
        }
      }
    }
    return true;
  }

  _sessionEventId(event = {}) {
    return `session:${hashValue(`${event.hubSessionId || ''}|${hashValue(event.text || '')}`)}`;
  }

  _groupEventId(event = {}) {
    return `group:${hashValue(`${event.meetingId || ''}|${event.turnNum || ''}`)}`;
  }

  _baseEligibility(config) {
    if (!config.enabled) return { ok: false, status: 'disabled' };
    if (!isUsableSendKey(config.serverchanSendKey)) {
      return { ok: false, status: 'configuration_missing' };
    }
    return { ok: true };
  }

  async handleTurnComplete(event = {}, session = null) {
    if (!event.hubSessionId) return { ok: false, status: 'missing_session' };
    if (!session) {
      this._durationFor(event);
      return { ok: false, status: 'missing_session' };
    }
    if (session.meetingId) {
      this._durationFor(event);
      return { ok: false, status: 'meeting_member' };
    }

    const completedAt = Number(event.completedAt) || this.now();
    const eventId = this._sessionEventId({ ...event, completedAt });
    if (!this._claimEvent(eventId)) return { ok: false, status: 'duplicate' };

    const durationMs = this._durationFor(event);
    const config = this._currentConfig();
    const eligibility = this._baseEligibility(config);
    if (!eligibility.ok) return eligibility;

    const sessionTitle = cleanInlineText(session.title || session.label || session.kind || 'AI 会话', 64) || 'AI 会话';
    const kind = cleanInlineText(session.kind || 'AI', 24) || 'AI';
    const lines = [
      `**会话**：${sessionTitle}`,
      `**AI**：${kind}`,
      `**耗时**：${formatDuration(durationMs)}`,
      `**完成时间**：${formatCompletedAt(completedAt)}`,
    ];
    if (config.includePreview) {
      const preview = cleanPreview(event.text, config.previewChars);
      if (preview) lines.push('', '**回复预览**', '', preview);
    }
    lines.push('', '打开 AI Hub 查看完整回复。');

    return this._deliver({
      eventId,
      sendKey: config.serverchanSendKey,
      title: `AI Hub · ${sessionTitle} 完成`,
      desp: lines.join('\n\n'),
    });
  }

  async handleGroupChatComplete(event = {}, meeting = null) {
    if (!event.meetingId || !meeting) return { ok: false, status: 'missing_meeting' };
    if (event.superseded) return { ok: false, status: 'superseded' };
    if (event.interrupted) return { ok: false, status: 'interrupted' };

    const eventId = this._groupEventId(event);
    if (!this._claimEvent(eventId)) return { ok: false, status: 'duplicate' };

    const config = this._currentConfig();
    if (!config.notifyGroupChats) return { ok: false, status: 'group_disabled' };
    const eligibility = this._baseEligibility(config);
    if (!eligibility.ok) return eligibility;

    const durationMs = Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null;
    const results = Array.isArray(event.results) ? event.results : [];
    const absentStatuses = new Set(['absent', 'skipped']);
    const failedStatuses = new Set(['errored', 'error', 'failed']);
    let completed = 0;
    let absent = 0;
    let failed = 0;
    for (const result of results) {
      const status = String(result && result.status || '').toLowerCase();
      if (absentStatuses.has(status)) absent += 1;
      else if (failedStatuses.has(status)) failed += 1;
      else completed += 1;
    }

    const meetingTitle = cleanInlineText(meeting.title || 'AI 群聊', 64) || 'AI 群聊';
    const summary = [`完成 ${completed}`];
    if (failed) summary.push(`失败 ${failed}`);
    if (absent) summary.push(`缺席 ${absent}`);
    const lines = [
      `**群聊**：${meetingTitle}`,
      `**轮次**：${event.turnNum || '—'}`,
      `**结果**：${summary.join(' · ')}`,
      `**耗时**：${formatDuration(durationMs)}`,
      `**完成时间**：${formatCompletedAt(this.now())}`,
    ];
    if (config.includePreview) {
      const first = results.find(result => result && result.text);
      const preview = first ? cleanPreview(first.text, config.previewChars) : '';
      if (preview) lines.push('', `**${cleanInlineText(first.label || '首位成员', 24)} 回复预览**`, '', preview);
    }
    lines.push('', '打开 AI Hub 查看本轮全部回复。');

    return this._deliver({
      eventId,
      sendKey: config.serverchanSendKey,
      title: `AI Hub · ${meetingTitle} 本轮完成`,
      desp: lines.join('\n\n'),
    });
  }

  async sendTest(options = {}) {
    const config = this._currentConfig();
    const sendKey = String(options.sendKey || config.serverchanSendKey || '').trim();
    if (!isUsableSendKey(sendKey)) {
      return { ok: false, status: 'configuration_missing', errorCode: 'invalid_sendkey' };
    }
    const now = this.now();
    return this._deliver({
      eventId: `test:${hashValue(`${now}|${crypto.randomBytes(8).toString('hex')}`)}`,
      sendKey,
      title: 'AI Hub · 通知测试成功',
      desp: `Server酱通知链路已打通。\n\n**测试时间**：${formatCompletedAt(now)}\n\n顶栏“通知开”时，AI 回答完成后会推送；“通知关”时不会推送。`,
    }, { allowRetry: false });
  }

  async _deliver(payload, options = {}) {
    const outcome = await this._attempt(payload, 1);
    if (!outcome.ok && outcome.transient && options.allowRetry !== false && this.retryDelaysMs.length) {
      this._scheduleRetry(payload, 0);
      return { ...outcome, retryScheduled: true };
    }
    return outcome;
  }

  async _attempt(payload, attempt) {
    try {
      const result = await sendServerChan(payload, {
        fetchImpl: this.fetchImpl,
        endpointBuilder: this.endpointBuilder,
        timeoutMs: this.timeoutMs,
      });
      await this._appendAudit({
        ts: new Date(this.now()).toISOString(),
        eventId: payload.eventId,
        provider: 'serverchan',
        status: 'sent',
        attempt,
        statusCode: result.statusCode,
        providerCode: result.providerCode,
      });
      this.lastDelivery = {
        status: 'sent',
        timestamp: this.now(),
        attempt,
        statusCode: result.statusCode,
        providerCode: result.providerCode,
      };
      return { ok: true, status: 'sent', attempt };
    } catch (error) {
      const safeError = error instanceof NotificationDeliveryError
        ? error
        : new NotificationDeliveryError('unknown_error');
      await this._appendAudit({
        ts: new Date(this.now()).toISOString(),
        eventId: payload.eventId,
        provider: 'serverchan',
        status: 'failed',
        attempt,
        errorCode: safeError.code,
        transient: safeError.transient,
        statusCode: safeError.statusCode,
        providerCode: safeError.providerCode,
      });
      this.lastDelivery = {
        status: 'failed',
        timestamp: this.now(),
        attempt,
        errorCode: safeError.code,
        transient: safeError.transient,
        statusCode: safeError.statusCode,
        providerCode: safeError.providerCode,
      };
      return {
        ok: false,
        status: 'failed',
        errorCode: safeError.code,
        transient: safeError.transient,
        statusCode: safeError.statusCode,
        providerCode: safeError.providerCode,
        attempt,
      };
    }
  }

  _scheduleRetry(payload, retryIndex) {
    if (retryIndex >= this.retryDelaysMs.length) return;
    const delay = this.retryDelaysMs[retryIndex];
    const timer = setTimeout(async () => {
      this.retryTimers.delete(timer);
      const outcome = await this._attempt(payload, retryIndex + 2);
      if (!outcome.ok && outcome.transient) this._scheduleRetry(payload, retryIndex + 1);
    }, delay);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  async _appendAudit(record) {
    const logPath = this.getLogPath();
    if (!logPath) return;
    try {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      try { this.logger.warn('[completion-notifier] audit log write failed:', error && error.code); } catch {}
    }
  }

  dispose() {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.promptSubmittedAt.clear();
    this.recentEvents.clear();
  }

  getHealth() {
    return {
      lastDelivery: this.lastDelivery ? { ...this.lastDelivery } : null,
      retrying: this.retryTimers.size > 0,
    };
  }
}

module.exports = {
  CompletionNotifier,
  DEFAULT_NOTIFICATION_CONFIG,
  NotificationDeliveryError,
  isUsableSendKey,
  maskSecret,
  normalizeNotificationConfig,
  readLastDeliveryAudit,
  sendServerChan,
};
