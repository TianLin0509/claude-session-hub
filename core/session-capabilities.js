'use strict';

const {
  isClaudeFamily,
  isCodexCliKind,
  isKimiCliKind,
} = require('./ai-kinds.js');
const { isStableSessionTitle } = require('./session-title-guards.js');
const {
  DEFAULT_MODEL_BY_KIND,
  isCodexConversationModelId,
  normalizeDeepSeekModel,
} = require('./model-options.js');

function baseKind(kind) {
  return String(kind || '').replace(/-resume$/, '');
}

// Public DeepSeek sessions keep kind="deepseek" across the 2026-08 Codex
// migration.  Persisted pre-migration sessions are distinguished by their
// native id so every caller reaches the correct provider runtime without
// inventing another UI kind.
function runtimeKindForSession(session) {
  if (!session || typeof session !== 'object') return '';
  if (session.transcriptKind) return String(session.transcriptKind);
  const kind = String(session.kind || '');
  if (baseKind(kind) === 'deepseek' && session.ccSessionId && !session.codexSid) {
    return kind.endsWith('-resume') ? 'deepseek-legacy-resume' : 'deepseek-legacy';
  }
  return kind;
}

function sessionProviderFamily(session) {
  const runtimeKind = runtimeKindForSession(session);
  if (isClaudeFamily(runtimeKind)) return 'claude';
  if (isCodexCliKind(runtimeKind)) return 'codex';
  const kind = baseKind(session && session.kind);
  if (kind === 'gemini') return 'gemini';
  if (isKimiCliKind(session && session.kind) || kind === 'kimi') return 'kimi';
  if (kind === 'powershell') return 'shell';
  return 'unknown';
}

function nativeSessionIdentity(session) {
  if (!session || typeof session !== 'object') return null;
  const family = sessionProviderFamily(session);
  const field = family === 'claude'
    ? 'ccSessionId'
    : family === 'codex'
      ? 'codexSid'
      : family === 'gemini'
        ? 'geminiChatId'
        : family === 'kimi'
          ? 'kimiSid'
          : null;
  if (!field) return null;
  const value = typeof session[field] === 'string' ? session[field].trim() : '';
  return value ? { family, field, value } : null;
}

function supportsRecoverableSession(session) {
  if (!session) return false;
  return ['claude', 'codex', 'gemini', 'kimi'].includes(sessionProviderFamily(session));
}

function supportsForkSession(session) {
  if (!session || session.purpose === 'chuxin-research') return false;
  return ['claude', 'codex'].includes(sessionProviderFamily(session));
}

function sessionModelId(session) {
  if (!session) return null;
  let candidate = null;
  if (session.currentModel && typeof session.currentModel === 'object') {
    candidate = session.currentModel.id || null;
  } else if (session.model && typeof session.model === 'object') {
    candidate = session.model.id || null;
  } else if (typeof session.model === 'string') {
    candidate = session.model;
  }
  if (!candidate) return null;
  const kind = baseKind(session.kind);
  if (kind === 'codex' && !isCodexConversationModelId(candidate)) {
    return DEFAULT_MODEL_BY_KIND.codex;
  }
  if (kind === 'deepseek' && sessionProviderFamily(session) === 'codex') {
    return normalizeDeepSeekModel(candidate);
  }
  return candidate;
}

// One authority for every operation that stops a PTY and recreates it against
// the same provider-native thread: dormant wake, user Restart and workspace
// archive/move.  Keeping this list shared is what prevents Codex-only metadata
// (profile, MCP policy, rollout root) from disappearing on one of those paths.
function buildSessionResumeMeta(session, overrides = {}) {
  if (!session || typeof session !== 'object') return null;
  const hubId = session.hubId || session.id;
  const meta = {
    hubId,
    kind: session.kind || 'claude',
    title: session.title || null,
    cwd: session.cwd || null,
    cwdFellBackFrom: session.cwdFellBackFrom || null,
    workspaceLabel: session.workspaceLabel || null,
    pinned: !!session.pinned,
    bottomed: !!session.bottomed && !session.pinned,
    ccSessionId: session.ccSessionId || null,
    transcriptPath: session.transcriptPath || null,
    meetingId: session.meetingId || null,
    completionNotificationEnabled: session.completionNotificationEnabled === true,
    lastMessageTime: session.lastMessageTime,
    lastOutputPreview: session.lastOutputPreview || '',
    model: sessionModelId(session),
    effort: session.effort || null,
    codexSid: session.codexSid || null,
    codexSessionsRoot: session.codexSessionsRoot || null,
    codexAllowMtimeFallback: !!session.codexAllowMtimeFallback,
    codexProfile: session.codexProfile || null,
    codexProfileLabel: session.codexProfileLabel || null,
    mcpProfile: session.mcpProfile || null,
    codexSpeedTier: session.codexSpeedTier || null,
    fastMode: session.fastMode === false ? false : null,
    geminiChatId: session.geminiChatId || null,
    geminiProjectHash: session.geminiProjectHash || null,
    geminiProjectRoot: session.geminiProjectRoot || null,
    kimiSid: session.kimiSid || null,
    kimiSessionDir: session.kimiSessionDir || null,
    userRenamed: !!session.userRenamed,
    // A meaningful persisted title must remain authoritative across every
    // stop/recreate path.  Pending fork placeholders are the one exception:
    // they still need the normal auto-title pass after resume.
    autoTitleGenerated: !session.branchAutoTitlePending
      && (!!session.autoTitleGenerated || isStableSessionTitle(session.title, session.kind)),
    branchSourceSessionId: session.branchSourceSessionId || null,
    branchIndex: Number.isInteger(Number(session.branchIndex)) && Number(session.branchIndex) > 0
      ? Number(session.branchIndex)
      : null,
    branchAutoTitlePending: !!session.branchAutoTitlePending,
    contextPct: typeof session.contextPct === 'number' ? session.contextPct : null,
    contextUsed: typeof session.contextUsed === 'number' ? session.contextUsed : null,
    contextMax: typeof session.contextMax === 'number' ? session.contextMax : null,
    contextEffectiveMax: typeof session.contextEffectiveMax === 'number' ? session.contextEffectiveMax : null,
    contextEffectiveObservedAt: typeof session.contextEffectiveObservedAt === 'number'
      ? session.contextEffectiveObservedAt
      : null,
    purpose: session.purpose || null,
    researchSessionId: session.researchSessionId || null,
    chuxinTaskId: session.chuxinTaskId || null,
    heroIds: Array.isArray(session.heroIds) ? session.heroIds.slice() : null,
    promptPolicyVersion: session.promptPolicyVersion || null,
    hiddenFromSidebar: !!session.hiddenFromSidebar,
  };
  return { ...meta, ...(overrides || {}) };
}

module.exports = {
  baseKind,
  runtimeKindForSession,
  sessionProviderFamily,
  nativeSessionIdentity,
  supportsRecoverableSession,
  supportsForkSession,
  sessionModelId,
  buildSessionResumeMeta,
};
