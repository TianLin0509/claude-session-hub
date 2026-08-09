'use strict';

const { isCodexCliKind } = require('../../core/ai-kinds');
const { buildBranchSessionTitle } = require('../../core/branch-session-titles.js');

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
    getTerminalOutputBatchStats = () => null,
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

    const isClaude = source.kind === 'claude' || source.kind === 'claude-resume';
    // DeepSeek 跑的就是 claude CLI，--fork-session 同样可用。
    // Kimi 不在此列：它的 CLI 只有 --session/--continue，没有任何 fork 能力。
    const isDeepSeek = source.kind === 'deepseek' || source.kind === 'deepseek-resume';
    const isCodex = isCodexCliKind(source.kind);
    const isClaudeCli = isClaude || isDeepSeek;
    if (!isClaudeCli && !isCodex) {
      return {
        ok: false,
        error: 'unsupported-kind',
        message: '仅支持 Claude Code、DeepSeek 和 Codex 会话创建分支（Kimi CLI 无 fork 能力）',
      };
    }

    const nativeSessionId = isClaudeCli ? source.ccSessionId : source.codexSid;
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
    const resolvedTitle = buildBranchSessionTitle({ rendererTitle, source, meeting });
    const opts = {
      title: resolvedTitle.title,
      cwd: source.cwd,
      branchSourceSessionId: source.id,
      branchAutoTitlePending: resolvedTitle.branchAutoTitlePending,
      // Prefer the exact title visible to the user. A generic group member name
      // (for example Codex 2) inherits the owning meeting title; a truly unnamed
      // standalone parent stays pending and is named from the branch's first prompt.
      autoTitleGenerated: resolvedTitle.autoTitleGenerated,
    };
    if (source.currentModel && source.currentModel.id) opts.model = source.currentModel.id;
    // 分支必须继承 effort，否则从 low/medium 会话拉分支会被打回默认 max。
    if (source.effort) opts.effort = source.effort;

    let kind;
    if (isClaudeCli) {
      kind = isDeepSeek ? 'deepseek' : 'claude';
      opts.forkCCSessionId = nativeSessionId;
    } else {
      kind = 'codex';
      if (source.codexProfile) opts.codexProfile = source.codexProfile;
      if (source.mcpProfile) opts.mcpProfile = source.mcpProfile;
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
    if (!old) return null;
    sessionManager.closeSession(sessionId);
    const fresh = sessionManager.createSession(old.kind, {
      id: old.id,
      cwd: old.cwd,
      meetingId: old.meetingId || undefined,
      ...(old.currentModel && old.currentModel.id ? { model: old.currentModel.id } : {}),
      ...(old.effort ? { effort: old.effort } : {}),
      ...(old.codexProfile ? { codexProfile: old.codexProfile } : {}),
      ...(old.mcpProfile ? { mcpProfile: old.mcpProfile } : {}),
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
