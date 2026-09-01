'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { formatBeijingDateTime } = require('./beijing-time.js');

const PROVIDER = 'feishu-cli';
const DEFAULT_NOTIFICATION_CONFIG = Object.freeze({
  enabled: false,
  provider: PROVIDER,
  feishuTarget: '',
  feishuCliPath: '',
  includePreview: false,
  previewChars: 160,
  notifyGroupChats: true,
});

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000, 10_000, 60_000]);
const RECENT_EVENT_TTL_MS = 24 * 60 * 60_000;
const MAX_RECENT_EVENTS = 2_000;
const MAX_DELIVERED_EVENTS = 2_000;
const AUDIT_TAIL_BYTES = 512 * 1024;
const MAX_CLI_OUTPUT_CHARS = 128 * 1024;
const TERMINAL_GROUP_STATUSES = new Set([
  'completed', 'complete', 'success', 'manual', 'manual_extracted',
  'absent', 'skipped',
  'errored', 'error', 'failed',
  'interrupted', 'superseded',
]);

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

function resolveDefaultFeishuCliPath(env = process.env, platform = process.platform) {
  const configured = String(env.HUB_NOTIFY_FEISHU_CLI_PATH || '').trim();
  if (configured) return configured;
  if (platform === 'win32') {
    const stable = 'C:\\DevTools\\LarkCLI\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe';
    if (fs.existsSync(stable)) return stable;
    return 'lark-cli.exe';
  }
  return 'lark-cli';
}

function normalizeNotificationConfig(raw = {}, env = process.env) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const feishu = source.feishu && typeof source.feishu === 'object' ? source.feishu : {};
  const rawTarget = source.feishuTarget !== undefined
    ? source.feishuTarget
    : (feishu.target !== undefined ? feishu.target : feishu.receive_id);
  const rawCliPath = source.feishuCliPath !== undefined
    ? source.feishuCliPath
    : feishu.cli_path;
  const envTarget = String(env.HUB_NOTIFY_FEISHU_TARGET || '').trim();
  const envCliPath = String(env.HUB_NOTIFY_FEISHU_CLI_PATH || '').trim();
  const envEnabled = env.HUB_NOTIFY_ENABLED;

  return {
    enabled: normalizeBoolean(
      envEnabled !== undefined ? envEnabled : source.enabled,
      DEFAULT_NOTIFICATION_CONFIG.enabled,
    ),
    provider: PROVIDER,
    feishuTarget: envTarget || String(rawTarget || '').trim(),
    feishuCliPath: envCliPath || String(rawCliPath || '').trim() || resolveDefaultFeishuCliPath(env),
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

function isUsableFeishuTarget(target) {
  return /^(?:oc|ou)_[A-Za-z0-9_-]{6,256}$/.test(String(target || '').trim());
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
  try {
    return formatBeijingDateTime(Number(timestamp) || Date.now());
  } catch {
    return new Date(Number(timestamp) || Date.now()).toISOString();
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function normalizeEventTime(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Number(fallback) || Date.now();
  return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeTurnId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function readAuditRecords(logPath, onError = null) {
  if (!logPath) return [];
  let fd = null;
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile()) {
      if (typeof onError === 'function') {
        const error = new Error('notification audit path is not a file');
        error.code = 'EISDIR';
        try { onError(error); } catch {}
      }
      return [];
    }
    if (stat.size <= 0) return [];
    const length = Math.min(AUDIT_TAIL_BYTES, stat.size);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') records.push(parsed);
      } catch {}
    }
    return records;
  } catch (error) {
    if (error && error.code !== 'ENOENT' && typeof onError === 'function') {
      try { onError(error); } catch {}
    }
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readLastDeliveryAudit(logPath, onError = null) {
  const records = readAuditRecords(logPath, onError);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.provider !== PROVIDER) continue;
    if (record.status !== 'sent' && record.status !== 'failed') continue;
    const timestamp = Date.parse(record.ts);
    if (!Number.isFinite(timestamp)) continue;
    return {
      status: record.status,
      timestamp,
      attempt: Number(record.attempt) || 1,
      errorCode: record.errorCode || null,
      transient: record.transient === true,
      exitCode: Number.isFinite(Number(record.exitCode)) ? Number(record.exitCode) : null,
      providerCode: record.providerCode == null ? null : String(record.providerCode),
    };
  }
  return null;
}

function readDeliveredEventIds(logPath, onError = null) {
  const delivered = new Map();
  for (const record of readAuditRecords(logPath, onError)) {
    if (record.provider !== PROVIDER) continue;
    if (record.status !== 'sent' || typeof record.eventId !== 'string' || !record.eventId) continue;
    const timestamp = Date.parse(record.ts);
    delivered.set(record.eventId, Number.isFinite(timestamp) ? timestamp : 0);
    while (delivered.size > MAX_DELIVERED_EVENTS) {
      delivered.delete(delivered.keys().next().value);
    }
  }
  return delivered;
}

class NotificationDeliveryError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'NotificationDeliveryError';
    this.code = code;
    this.transient = !!options.transient;
    this.exitCode = Number.isFinite(Number(options.exitCode)) ? Number(options.exitCode) : null;
    this.providerCode = options.providerCode !== undefined && options.providerCode !== null
      ? String(options.providerCode).slice(0, 80)
      : null;
  }
}

function parseCliJson(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  const lastBrace = normalized.lastIndexOf('}');
  if (lastBrace >= 0) {
    for (let start = normalized.lastIndexOf('{', lastBrace); start >= 0; start = normalized.lastIndexOf('{', start - 1)) {
      try {
        const parsed = JSON.parse(normalized.slice(start, lastBrace + 1));
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
  }
  const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function appendCaptured(previous, chunk) {
  const next = previous + String(chunk || '');
  return next.length <= MAX_CLI_OUTPUT_CHARS ? next : next.slice(-MAX_CLI_OUTPUT_CHARS);
}

function buildFeishuMarkdown(payload = {}) {
  const title = cleanInlineText(payload.title || 'AI Hub 通知', 80) || 'AI Hub 通知';
  const body = String(payload.desp || '').trim();
  return [`#### ${title}`, '', body].filter((line, index, all) => line || index < all.length - 1).join('\n');
}

function buildFeishuCliArgs(payload = {}, prefixArgs = []) {
  const target = String(payload.target || '').trim();
  if (!isUsableFeishuTarget(target)) {
    throw new NotificationDeliveryError('invalid_target');
  }
  const targetArgs = target.startsWith('oc_')
    ? ['--chat-id', target]
    : ['--user-id', target];
  const idempotencyKey = `hub-${hashValue(payload.eventId || buildFeishuMarkdown(payload))}`;
  return [
    ...prefixArgs,
    'im', '+messages-send',
    ...targetArgs,
    '--markdown', buildFeishuMarkdown(payload),
    '--idempotency-key', idempotencyKey,
    '--as', 'bot',
  ];
}

function cliFailureError(exitCode, stdout, stderr) {
  const parsed = parseCliJson(stderr) || parseCliJson(stdout) || {};
  const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : {};
  const type = String(error.type || '').toLowerCase();
  const subtype = String(error.subtype || '').toLowerCase();
  const providerCode = error.code !== undefined && error.code !== null
    ? error.code
    : (subtype || exitCode);
  if (Number(exitCode) === 10 || subtype === 'confirmation_required') {
    return new NotificationDeliveryError('confirmation_required', { exitCode, providerCode });
  }
  if (subtype === 'missing_scope') {
    return new NotificationDeliveryError('missing_scope', { exitCode, providerCode });
  }
  if (type === 'authorization' || type === 'auth') {
    return new NotificationDeliveryError('authorization_error', { exitCode, providerCode });
  }
  if (type === 'configuration' || type === 'config' || subtype.includes('config')) {
    return new NotificationDeliveryError('cli_configuration_error', { exitCode, providerCode });
  }
  if (type === 'validation') {
    return new NotificationDeliveryError('cli_validation_error', { exitCode, providerCode });
  }
  const transient = type === 'network' || type === 'internal' || Number(exitCode) === 4 || Number(exitCode) === 5;
  return new NotificationDeliveryError(transient ? 'network_error' : 'cli_failed', {
    transient,
    exitCode,
    providerCode,
  });
}

async function sendFeishuCli(payload, options = {}) {
  if (!isUsableFeishuTarget(payload.target)) {
    throw new NotificationDeliveryError('invalid_target');
  }
  const cliPath = String(options.cliPath || payload.cliPath || resolveDefaultFeishuCliPath()).trim();
  if (!cliPath) throw new NotificationDeliveryError('cli_not_found');
  const configuredPrefix = Array.isArray(options.cliPrefixArgs) ? options.cliPrefixArgs : [];
  const isNodeScript = path.extname(cliPath).toLowerCase() === '.js';
  const nodeCommand = String(
    options.nodePath
    || process.env.HUB_NOTIFY_FEISHU_NODE_PATH
    || (process.versions && process.versions.electron ? 'node.exe' : process.execPath),
  ).trim();
  const command = isNodeScript ? nodeCommand : cliPath;
  const args = buildFeishuCliArgs(payload, isNodeScript ? [cliPath, ...configuredPrefix] : configuredPrefix);
  const spawnImpl = options.spawnImpl || childProcess.spawn;
  const timeoutMs = clampInteger(options.timeoutMs, 15_000, 1_000, 60_000);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const notFound = error && (error.code === 'ENOENT' || error.code === 'UNKNOWN');
      reject(new NotificationDeliveryError(notFound ? 'cli_not_found' : 'cli_spawn_error'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => reject(new NotificationDeliveryError('timeout', { transient: true })));
    }, timeoutMs);
    timeout.unref?.();

    if (child.stdout) {
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', chunk => { stdout = appendCaptured(stdout, chunk); });
    }
    if (child.stderr) {
      child.stderr.setEncoding?.('utf8');
      child.stderr.on('data', chunk => { stderr = appendCaptured(stderr, chunk); });
    }
    child.once('error', error => {
      const notFound = error && (error.code === 'ENOENT' || error.code === 'UNKNOWN');
      finish(() => reject(new NotificationDeliveryError(notFound ? 'cli_not_found' : 'cli_spawn_error')));
    });
    child.once('close', exitCode => {
      finish(() => {
        if (exitCode === null || exitCode === undefined) {
          reject(new NotificationDeliveryError('cli_terminated', { transient: true }));
          return;
        }
        if (Number(exitCode) !== 0) {
          reject(cliFailureError(exitCode, stdout, stderr));
          return;
        }
        const parsed = parseCliJson(stdout);
        const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        const compatibleRawSuccess = parsed && parsed.ok === undefined && data && data.message_id;
        if (!parsed || (parsed.ok !== true && !compatibleRawSuccess)) {
          reject(new NotificationDeliveryError('invalid_response', { transient: true, exitCode: 0 }));
          return;
        }
        const messageId = data && (data.message_id || data.messageId) || null;
        resolve({
          ok: true,
          exitCode: 0,
          providerCode: messageId,
          messageId,
          chatId: data && (data.chat_id || data.chatId) || null,
        });
      });
    });
  });
}

class CompletionNotifier {
  constructor(options = {}) {
    this.getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({});
    this.getLogPath = typeof options.getLogPath === 'function' ? options.getLogPath : () => null;
    this.deliveryImpl = typeof options.deliveryImpl === 'function' ? options.deliveryImpl : sendFeishuCli;
    this.spawnImpl = options.spawnImpl || childProcess.spawn;
    this.cliPath = typeof options.cliPath === 'string' ? options.cliPath : null;
    this.cliPrefixArgs = Array.isArray(options.cliPrefixArgs) ? [...options.cliPrefixArgs] : [];
    this.timeoutMs = clampInteger(options.timeoutMs, 15_000, 1_000, 60_000);
    this.retryDelaysMs = Array.isArray(options.retryDelaysMs)
      ? options.retryDelaysMs.map(value => Math.max(0, Number(value) || 0))
      : [...DEFAULT_RETRY_DELAYS_MS];
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.sessionTurns = new Map();
    this.recentEvents = new Map();
    this.auditReadError = null;
    this.auditWriteError = null;
    let auditReadReported = false;
    const reportAuditReadError = error => {
      this.auditReadError = error && (error.code || error.message) || 'audit_read_failed';
      if (auditReadReported) return;
      auditReadReported = true;
      try { this.logger.warn('[completion-notifier] audit log read failed:', this.auditReadError); } catch {}
    };
    this.deliveredEvents = readDeliveredEventIds(this.getLogPath(), reportAuditReadError);
    this.retryTimers = new Set();
    this.lastDelivery = readLastDeliveryAudit(this.getLogPath(), reportAuditReadError);
  }

  _newTurnState(sessionId, event = {}, at = this.now()) {
    const previous = this.sessionTurns.get(sessionId);
    return {
      generation: (Number(previous && previous.generation) || 0) + 1,
      turnId: normalizeTurnId(event.turnId),
      promptSignature: null,
      promptAt: 0,
      startedAt: at,
      completedAt: 0,
      terminalAt: 0,
      phase: 'running',
    };
  }

  notePromptSubmitted(event = {}) {
    const sessionId = String(event.hubSessionId || '');
    if (!sessionId) return { applied: false, reason: 'missing-session' };
    const at = normalizeEventTime(event.submittedAt, this.now());
    const turnId = normalizeTurnId(event.turnId);
    const promptSignature = turnId
      ? `turn:${turnId}`
      : `prompt:${at}:${hashValue(event.text || '')}`;
    const previous = this.sessionTurns.get(sessionId);
    const sameTurn = previous && previous.phase === 'running'
      && ((turnId && previous.turnId === turnId)
        || (!turnId && previous.promptSignature === promptSignature));
    const state = sameTurn ? previous : this._newTurnState(sessionId, event, at);
    state.turnId = turnId || state.turnId;
    state.promptSignature = promptSignature;
    state.promptAt = Math.max(Number(state.promptAt) || 0, at);
    state.startedAt = Math.min(Number(state.startedAt) || at, at);
    state.phase = 'running';
    this.sessionTurns.set(sessionId, state);
    return { applied: true, generation: state.generation, turnId: state.turnId };
  }

  noteTurnStarted(event = {}) {
    const sessionId = String(event.hubSessionId || '');
    if (!sessionId) return { applied: false, reason: 'missing-session' };
    const at = normalizeEventTime(event.startedAt, this.now());
    const turnId = normalizeTurnId(event.turnId);
    const previous = this.sessionTurns.get(sessionId);
    const sameTurn = previous && previous.phase === 'running'
      && (!turnId || !previous.turnId || previous.turnId === turnId);
    const state = sameTurn ? previous : this._newTurnState(sessionId, event, at);
    state.turnId = turnId || state.turnId;
    state.startedAt = Math.min(Number(state.startedAt) || at, at);
    state.phase = 'running';
    this.sessionTurns.set(sessionId, state);
    return { applied: true, generation: state.generation, turnId: state.turnId };
  }

  _noteNonCompletion(event, phase, timeField) {
    const sessionId = String(event.hubSessionId || '');
    if (!sessionId) return { applied: false, reason: 'missing-session' };
    const at = normalizeEventTime(event[timeField], this.now());
    const turnId = normalizeTurnId(event.turnId);
    let state = this.sessionTurns.get(sessionId);
    if (!state) {
      state = this._newTurnState(sessionId, event, at);
      state.startedAt = 0;
      state.phase = phase;
      state.terminalAt = at;
      this.sessionTurns.set(sessionId, state);
      return { applied: true, generation: state.generation, turnId: state.turnId };
    }
    if (turnId && state.turnId && turnId !== state.turnId) {
      return { applied: false, reason: 'stale-terminal-turn' };
    }
    if (at < Math.max(Number(state.promptAt) || 0, Number(state.startedAt) || 0)) {
      return { applied: false, reason: 'stale-terminal-time' };
    }
    state.turnId = turnId || state.turnId;
    state.phase = phase;
    state.terminalAt = at;
    this.sessionTurns.set(sessionId, state);
    return { applied: true, generation: state.generation, turnId: state.turnId };
  }

  noteTurnAborted(event = {}) {
    return this._noteNonCompletion(event, 'aborted', 'abortedAt');
  }

  noteTurnFailed(event = {}) {
    return this._noteNonCompletion(event, 'failed', 'completedAt');
  }

  noteSessionClosed(event = {}) {
    const sessionId = String(event.hubSessionId || event.sessionId || '');
    if (sessionId) this.sessionTurns.delete(sessionId);
  }

  _currentConfig() {
    const root = this.getConfig() || {};
    return normalizeNotificationConfig(root.notifications || root);
  }

  _durationFor(event = {}, state = null) {
    const explicit = Number(event.durationMs);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    const start = state
      ? (Number(state.promptAt) || Number(state.startedAt) || 0)
      : 0;
    const end = state ? (Number(state.completedAt) || this.now()) : this.now();
    return start > 0 ? Math.max(0, end - start) : null;
  }

  _pruneEventMaps() {
    const now = this.now();
    for (const [id, timestamp] of this.recentEvents) {
      if (now - timestamp > RECENT_EVENT_TTL_MS || this.recentEvents.size > MAX_RECENT_EVENTS) {
        this.recentEvents.delete(id);
      }
    }
    while (this.deliveredEvents.size > MAX_DELIVERED_EVENTS) {
      this.deliveredEvents.delete(this.deliveredEvents.keys().next().value);
    }
  }

  _claimEvent(eventId) {
    this._pruneEventMaps();
    if (this.deliveredEvents.has(eventId) || this.recentEvents.has(eventId)) return false;
    this.recentEvents.set(eventId, this.now());
    return true;
  }

  _completionContext(event = {}) {
    const sessionId = String(event.hubSessionId || '');
    const at = normalizeEventTime(event.completedAt, this.now());
    const turnId = normalizeTurnId(event.turnId);
    let state = this.sessionTurns.get(sessionId);
    if (!state) {
      state = this._newTurnState(sessionId, event, at);
      state.startedAt = 0;
      this.sessionTurns.set(sessionId, state);
    }
    const candidateTurnId = turnId || state.turnId;
    const candidateTurnKey = candidateTurnId
      ? `turn:${candidateTurnId}`
      : `generation:${state.generation}`;
    const candidateEventId = `session:${hashValue(`${sessionId}|${candidateTurnKey}`)}`;

    const startAt = Math.max(Number(state.promptAt) || 0, Number(state.startedAt) || 0);
    if (startAt > 0 && at < startAt) {
      return { ok: false, status: 'stale_completion_time', at, state, eventId: candidateEventId };
    }
    if (turnId && state.turnId && turnId !== state.turnId) {
      return { ok: false, status: 'stale_completion_turn', at, state, eventId: candidateEventId };
    }
    if (state.phase === 'aborted' || state.phase === 'failed') {
      return { ok: false, status: `${state.phase}_turn`, at, state, eventId: candidateEventId };
    }

    state.turnId = turnId || state.turnId;
    state.phase = 'completed';
    state.completedAt = Math.max(Number(state.completedAt) || 0, at);
    this.sessionTurns.set(sessionId, state);
    const turnKey = state.turnId ? `turn:${state.turnId}` : `generation:${state.generation}`;
    return {
      ok: true,
      at,
      state,
      turnKey,
      eventId: `session:${hashValue(`${sessionId}|${turnKey}`)}`,
    };
  }

  _groupEventId(event = {}) {
    return `group:${hashValue(`${event.meetingId || ''}|${event.turnNum || ''}`)}`;
  }

  _baseEligibility(config) {
    if (!isUsableFeishuTarget(config.feishuTarget)) {
      return { ok: false, status: 'configuration_missing', errorCode: 'invalid_target' };
    }
    if (!String(config.feishuCliPath || '').trim()) {
      return { ok: false, status: 'configuration_missing', errorCode: 'cli_not_found' };
    }
    return { ok: true };
  }

  async _auditSuppressed(eventId, reason) {
    await this._appendAudit({
      ts: new Date(this.now()).toISOString(),
      eventId: eventId || null,
      provider: PROVIDER,
      status: 'suppressed',
      reason,
    });
  }

  async handleTurnComplete(event = {}, session = null) {
    if (!event.hubSessionId) return { ok: false, status: 'missing_session' };
    if (!session) return { ok: false, status: 'missing_session' };
    if (session.meetingId) return { ok: false, status: 'meeting_member' };

    const completion = this._completionContext(event);
    if (!completion.ok) {
      await this._auditSuppressed(completion.eventId, completion.status);
      return { ok: false, status: completion.status };
    }
    if (session.completionNotificationEnabled !== true) {
      this._claimEvent(completion.eventId);
      return { ok: false, status: 'session_disabled' };
    }
    const config = this._currentConfig();
    const eligibility = this._baseEligibility(config);
    if (!eligibility.ok) {
      this._claimEvent(completion.eventId);
      return eligibility;
    }
    if (!this._claimEvent(completion.eventId)) return { ok: false, status: 'duplicate' };

    const durationMs = this._durationFor(event, completion.state);
    const sessionTitle = cleanInlineText(session.title || session.label || session.kind || 'AI 会话', 64) || 'AI 会话';
    const kind = cleanInlineText(session.kind || 'AI', 24) || 'AI';
    const lines = [
      `**会话**：${sessionTitle}`,
      `**AI**：${kind}`,
      `**耗时**：${formatDuration(durationMs)}`,
      `**完成时间**：${formatCompletedAt(completion.at)}`,
    ];
    if (config.includePreview) {
      const preview = cleanPreview(event.text, config.previewChars);
      if (preview) lines.push('', '**回复预览**', '', preview);
    }
    lines.push('', '打开 AI Hub 查看完整回复。');

    return this._deliver({
      eventId: completion.eventId,
      target: config.feishuTarget,
      cliPath: config.feishuCliPath,
      title: `AI Hub · ${sessionTitle} 完成`,
      desp: lines.join('\n\n'),
    });
  }

  async handleGroupChatComplete(event = {}, meeting = null) {
    if (!event.meetingId || !meeting) return { ok: false, status: 'missing_meeting' };
    if (event.superseded) return { ok: false, status: 'superseded' };
    if (event.interrupted) return { ok: false, status: 'interrupted' };

    const results = Array.isArray(event.results) ? event.results : [];
    if (results.length === 0) return { ok: false, status: 'empty_results' };
    const statuses = results.map(result => String(result && result.status || '').toLowerCase());
    if (statuses.some(status => !TERMINAL_GROUP_STATUSES.has(status))) {
      await this._auditSuppressed(this._groupEventId(event), 'unsettled_results');
      return { ok: false, status: 'unsettled_results' };
    }
    if (statuses.some(status => status === 'interrupted' || status === 'superseded')) {
      return { ok: false, status: 'interrupted' };
    }

    const eventId = this._groupEventId(event);
    if (meeting.completionNotificationEnabled !== true) {
      this._claimEvent(eventId);
      return { ok: false, status: 'meeting_disabled' };
    }
    const config = this._currentConfig();
    if (!config.notifyGroupChats) {
      this._claimEvent(eventId);
      return { ok: false, status: 'group_disabled' };
    }
    const eligibility = this._baseEligibility(config);
    if (!eligibility.ok) {
      this._claimEvent(eventId);
      return eligibility;
    }
    if (!this._claimEvent(eventId)) return { ok: false, status: 'duplicate' };

    const durationMs = Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null;
    const absentStatuses = new Set(['absent', 'skipped']);
    const failedStatuses = new Set(['errored', 'error', 'failed']);
    let completed = 0;
    let absent = 0;
    let failed = 0;
    for (const status of statuses) {
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
      target: config.feishuTarget,
      cliPath: config.feishuCliPath,
      title: `AI Hub · ${meetingTitle} 本轮完成`,
      desp: lines.join('\n\n'),
    });
  }

  async sendTest(options = {}) {
    const config = this._currentConfig();
    const target = String(options.target || config.feishuTarget || '').trim();
    if (!isUsableFeishuTarget(target)) {
      return { ok: false, status: 'configuration_missing', errorCode: 'invalid_target' };
    }
    const now = this.now();
    return this._deliver({
      eventId: `test:${hashValue(`${now}|${crypto.randomBytes(8).toString('hex')}`)}`,
      target,
      cliPath: config.feishuCliPath,
      title: 'AI Hub · 飞书通知测试成功',
      desp: `飞书 CLI 通知链路已打通。\n\n**测试时间**：${formatCompletedAt(now)}\n\n顶栏开关只控制当前会话；新会话默认关闭，需要时请手动开启。`,
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
      const result = await this.deliveryImpl(payload, {
        cliPath: this.cliPath || payload.cliPath,
        cliPrefixArgs: this.cliPrefixArgs,
        spawnImpl: this.spawnImpl,
        timeoutMs: this.timeoutMs,
      });
      await this._appendAudit({
        ts: new Date(this.now()).toISOString(),
        eventId: payload.eventId,
        provider: PROVIDER,
        status: 'sent',
        attempt,
        exitCode: result.exitCode,
        providerCode: result.providerCode,
      });
      this.deliveredEvents.set(payload.eventId, this.now());
      this._pruneEventMaps();
      this.lastDelivery = {
        status: 'sent',
        timestamp: this.now(),
        attempt,
        exitCode: result.exitCode,
        providerCode: result.providerCode,
      };
      return { ok: true, status: 'sent', attempt, messageId: result.messageId || null };
    } catch (error) {
      const safeError = error instanceof NotificationDeliveryError
        ? error
        : new NotificationDeliveryError('unknown_error');
      await this._appendAudit({
        ts: new Date(this.now()).toISOString(),
        eventId: payload.eventId,
        provider: PROVIDER,
        status: 'failed',
        attempt,
        errorCode: safeError.code,
        transient: safeError.transient,
        exitCode: safeError.exitCode,
        providerCode: safeError.providerCode,
      });
      this.lastDelivery = {
        status: 'failed',
        timestamp: this.now(),
        attempt,
        errorCode: safeError.code,
        transient: safeError.transient,
        exitCode: safeError.exitCode,
        providerCode: safeError.providerCode,
      };
      return {
        ok: false,
        status: 'failed',
        errorCode: safeError.code,
        transient: safeError.transient,
        exitCode: safeError.exitCode,
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
    if (!logPath) return false;
    try {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch (error) {
      this.auditWriteError = error && (error.code || error.message) || 'audit_write_failed';
      try { this.logger.warn('[completion-notifier] audit log write failed:', this.auditWriteError); } catch {}
      return false;
    }
  }

  dispose() {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.sessionTurns.clear();
    this.recentEvents.clear();
    this.deliveredEvents.clear();
  }

  getHealth() {
    return {
      provider: PROVIDER,
      lastDelivery: this.lastDelivery ? { ...this.lastDelivery } : null,
      retrying: this.retryTimers.size > 0,
      auditReadError: this.auditReadError,
      auditWriteError: this.auditWriteError,
    };
  }
}

module.exports = {
  CompletionNotifier,
  DEFAULT_NOTIFICATION_CONFIG,
  NotificationDeliveryError,
  buildFeishuCliArgs,
  buildFeishuMarkdown,
  isUsableFeishuTarget,
  normalizeNotificationConfig,
  parseCliJson,
  readDeliveredEventIds,
  readLastDeliveryAudit,
  resolveDefaultFeishuCliPath,
  sendFeishuCli,
};
