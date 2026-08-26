'use strict';

const { buildBranchSessionTitle, nextBranchIndex } = require('../../core/branch-session-titles.js');
const {
  buildSessionResumeMeta,
  nativeSessionIdentity,
  runtimeKindForSession,
  sessionModelId,
  sessionProviderFamily,
  supportsForkSession,
  supportsRecoverableSession,
} = require('../../core/session-capabilities.js');

const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSafeNativeSessionId(value) {
  return typeof value === 'string' && NATIVE_SESSION_ID_RE.test(value);
}

function registerSessionIpc(ipcMain, deps) {
  const {
    registerSessionForTap = () => {},
    sendToRenderer,
    sessionManager,
    meetingManager,
    workspaceService,
    resumeSession,
    getTerminalOutputBatchStats = () => null,
    getPersistedSessions = () => [],
  } = deps;

  const lastResizeBySid = new Map();

  ipcMain.handle('create-session', (_e, arg) => {
    // Back-compat: legacy callers pass just a kind string; newer callers pass { kind, opts }.
    let kind;
    let opts;
    if (typeof arg === 'string') {
      kind = arg;
      opts = {};
    } else if (arg && typeof arg === 'object') {
      kind = arg.kind;
      opts = { ...(arg.opts || {}) };
    } else {
      kind = 'powershell';
      opts = {};
    }
    const isResumePicker = typeof kind === 'string' && kind.endsWith('-resume');
    // Native resume pickers must start in their historical/default scope when
    // the caller has no known cwd. Creating a fresh scratch here makes the CLI
    // picker unable to see the sessions it is supposed to resume.
    if (workspaceService && !opts.meetingId && (!isResumePicker || opts.cwd)) {
      const workspaceMeta = { label: opts.workspaceLabel, select: false };
      if (typeof opts.workspaceDraft === 'boolean') workspaceMeta.draft = opts.workspaceDraft;
      const workspace = workspaceService.resolveForSession(opts.cwd, workspaceMeta);
      opts.cwd = workspace.path;
    }
    const session = sessionManager.createSession(kind, opts);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    return session;
  });

  ipcMain.handle('fork-session', (_e, request) => {
    const sourceSessionId = request && typeof request === 'object'
      ? request.sourceSessionId
      : request;
    const rendererTitle = request && typeof request === 'object'
      ? request.sourceTitle
      : null;
    const source = typeof sourceSessionId === 'string'
      ? sessionManager.getSession(sourceSessionId)
      : null;
    if (!source) {
      return { ok: false, error: 'session-not-found', message: '当前会话不存在或尚未启动' };
    }

    const isDeepSeek = source.kind === 'deepseek' || source.kind === 'deepseek-resume';
    const runtimeKind = runtimeKindForSession(source);
    const providerFamily = sessionProviderFamily(source);
    if (!supportsForkSession(source)) {
      return {
        ok: false,
        error: 'unsupported-kind',
        message: '仅支持 Claude Code、DeepSeek 和 Codex 会话创建分支（Kimi CLI 无 fork 能力）',
      };
    }

    const identity = nativeSessionIdentity(source);
    const nativeSessionId = identity && identity.value;
    if (!isSafeNativeSessionId(nativeSessionId)) {
      return {
        ok: false,
        error: 'native-session-id-missing',
        message: '当前会话尚未绑定原生会话 ID，请等待本轮回答完成后重试',
      };
    }

    const meeting = source.meetingId && meetingManager && typeof meetingManager.getMeeting === 'function'
      ? meetingManager.getMeeting(source.meetingId)
      : null;
    const persistedSessions = getPersistedSessions();
    const siblingPool = [
      ...(typeof sessionManager.getAllSessions === 'function' ? sessionManager.getAllSessions() : []),
      ...(Array.isArray(persistedSessions) ? persistedSessions : []),
    ];
    const branchIndex = nextBranchIndex(source.id, siblingPool);
    const resolvedTitle = buildBranchSessionTitle({ rendererTitle, source, meeting, branchIndex });
    const opts = {
      title: resolvedTitle.title,
      cwd: source.cwd,
      branchSourceSessionId: source.id,
      branchIndex,
      branchAutoTitlePending: resolvedTitle.branchAutoTitlePending,
      // Prefer the exact title visible to the user. A generic group member name
      // (for example Codex 2) inherits the owning meeting title; a truly unnamed
      // standalone parent stays pending and is named from the branch's first prompt.
      autoTitleGenerated: resolvedTitle.autoTitleGenerated,
    };
    const sourceModel = sessionModelId(source);
    if (sourceModel) opts.model = sourceModel;
    // 分支必须继承 effort，否则从 low/medium 会话拉分支会被打回默认 max。
    if (source.effort) opts.effort = source.effort;
    // 同理：MCP 档位和 fast 开关也要跟着分支走，否则从 Lean/关 fast 的会话
    // 拉出来的分支会被悄悄拉回 Full / 开 fast。
    if (source.mcpProfile) opts.mcpProfile = source.mcpProfile;
    if (source.fastMode === false) opts.fastMode = false;
    if (source.codexSpeedTier) opts.codexSpeedTier = source.codexSpeedTier;
    if (typeof source.contextMax === 'number') opts.contextMax = source.contextMax;

    let kind;
    if (providerFamily === 'claude') {
      kind = isDeepSeek ? 'deepseek' : 'claude';
      opts.forkCCSessionId = nativeSessionId;
      if (runtimeKind.startsWith('deepseek-legacy')) opts.deepseekLegacyClaude = true;
    } else {
      kind = isDeepSeek ? 'deepseek' : 'codex';
      if (source.codexProfile) opts.codexProfile = source.codexProfile;
      opts.codexForkSid = nativeSessionId;
    }

    const session = sessionManager.createSession(kind, opts);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    return { ok: true, session };
  });

  ipcMain.handle('close-session', (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    const result = sessionManager.closeSessionRecoverably(sessionId, { reason: 'user-close' });
    if (result && result.ok) lastResizeBySid.delete(sessionId);
    return result;
  });

  // “关闭”在用户语义上等同于可恢复休眠。真正移除卡片/历史入口必须走
  // 明确命名的永久删除，内部 restart/workspace 迁移仍可直接调用 closeSession。
  ipcMain.handle('delete-session', (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    lastResizeBySid.delete(sessionId);
    sessionManager.closeSession(sessionId);
    return { ok: true, sessionId, action: 'deleted' };
  });

  ipcMain.handle('suspend-session', (_e, arg) => {
    const sessionId = arg && typeof arg === 'object' ? arg.sessionId : arg;
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    const result = sessionManager.suspendSession(sessionId, { reason: 'user-suspend' });
    if (result && result.ok) lastResizeBySid.delete(sessionId);
    return result;
  });

  ipcMain.handle('suspend-idle-sessions', (_e, arg = {}) => {
    const idleMs = arg && typeof arg === 'object' ? arg.idleMs : undefined;
    const result = sessionManager.suspendIdleSessions({ idleMs });
    for (const sessionId of (result && result.requested) || []) lastResizeBySid.delete(sessionId);
    return result;
  });

  ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows, force }) => {
    if (typeof sessionId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    if (cols <= 0 || rows <= 0) return;
    const last = lastResizeBySid.get(sessionId);
    // Normal ResizeObserver chatter remains deduplicated. Snapshot hydration is
    // the one intentional exception: a same-size ConPTY resize asks a live TUI
    // to repaint a complete authoritative frame after historical ANSI replay.
    if (!force && last && last.cols === cols && last.rows === rows) return;
    lastResizeBySid.set(sessionId, { cols, rows });
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  ipcMain.on('focus-session', (_e, { sessionId }) => {
    sessionManager.setFocusedSession(sessionId);
    sessionManager.markRead(sessionId);
  });

  ipcMain.handle('rename-session', (_e, { sessionId, title, userRenamed }) => {
    const session = sessionManager.renameSession(sessionId, title, { userRenamed: !!userRenamed });
    if (session) sendToRenderer('session-updated', { session });
    return session;
  });

  ipcMain.handle('get-sessions', () => {
    return sessionManager.getAllSessions();
  });

  ipcMain.handle('debug:get-session-buffer', (_e, sessionId) => {
    return sessionManager.getSessionBuffer(sessionId);
  });

  ipcMain.handle('get-session-buffer-snapshot', (_e, sessionId) => {
    if (typeof sessionManager.getSessionBufferSnapshot === 'function') {
      return sessionManager.getSessionBufferSnapshot(sessionId);
    }
    return { text: sessionManager.getSessionBuffer(sessionId) || '', seq: 0 };
  });

  ipcMain.handle('debug:get-last-session-write', () => {
    return typeof sessionManager.getLastWrite === 'function' ? sessionManager.getLastWrite() : null;
  });

  ipcMain.handle('debug:get-terminal-output-batch-stats', () => getTerminalOutputBatchStats());

  ipcMain.handle('restart-session', (_e, sessionId) => {
    const old = sessionManager.getSession(sessionId);
    if (!old) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    if (old.purpose === 'chuxin-research') {
      return { ok: false, error: 'protected-session', message: '初心投研任务不能从这里重启' };
    }

    if (supportsRecoverableSession(old)) {
      const identity = nativeSessionIdentity(old);
      if (!identity) {
        return {
          ok: false,
          error: 'native-session-id-missing',
          message: '当前会话尚未绑定原生会话 ID，不能安全重启；请等待本轮回答完成后重试',
        };
      }
      if (typeof resumeSession !== 'function') {
        return { ok: false, error: 'resume-handler-unavailable', message: '会话恢复服务尚未就绪' };
      }

      const resumeMeta = buildSessionResumeMeta(old);
      lastResizeBySid.delete(sessionId);
      sessionManager.closeSession(sessionId);
      return Promise.resolve(resumeSession(resumeMeta)).then((fresh) => (
        fresh || { ok: false, error: 'resume-failed', message: '原生会话恢复失败' }
      )).catch((error) => ({
        ok: false,
        error: 'resume-failed',
        message: `会话重启失败：${error && error.message ? error.message : String(error)}`,
      }));
    }

    // PowerShell has no provider-native thread.  Restarting it intentionally
    // creates a fresh shell while retaining the Hub card's UX metadata.
    sessionManager.closeSession(sessionId);
    const fresh = sessionManager.createSession(old.kind, {
      id: old.id,
      ...(old.title ? { title: old.title } : {}),
      cwd: old.cwd,
      meetingId: old.meetingId || undefined,
      ...(old.workspaceLabel ? { workspaceLabel: old.workspaceLabel } : {}),
      ...(old.pinned ? { pinned: true } : {}),
      ...(typeof old.lastMessageTime === 'number' ? { lastMessageTime: old.lastMessageTime } : {}),
      ...(typeof old.lastOutputPreview === 'string' ? { lastOutputPreview: old.lastOutputPreview } : {}),
      ...(sessionModelId(old) ? { model: sessionModelId(old) } : {}),
      ...(old.effort ? { effort: old.effort } : {}),
      ...(old.codexProfile ? { codexProfile: old.codexProfile } : {}),
      ...(old.mcpProfile ? { mcpProfile: old.mcpProfile } : {}),
      ...(old.fastMode === false ? { fastMode: false } : {}),
      ...(old.codexSpeedTier ? { codexSpeedTier: old.codexSpeedTier } : {}),
      ...(typeof old.contextMax === 'number' ? { contextMax: old.contextMax } : {}),
      completionNotificationEnabled: old.completionNotificationEnabled === true,
    });
    registerSessionForTap(fresh);
    sendToRenderer('session-created', { session: fresh });
    return fresh;
  });

  return { lastResizeBySid };
}

module.exports = {
  isSafeNativeSessionId,
  registerSessionIpc,
};
