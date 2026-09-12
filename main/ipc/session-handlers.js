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
const {
  isClaudeModelSelection,
  isCodexConversationModelId,
} = require('../../core/model-options.js');
const {
  captureClaudeModelPreference,
  restoreClaudeModelPreference,
} = require('../../core/claude-model-preference-guard.js');

const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

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
  const claudeModelPreferenceGuards = new Map();

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
    if (source.codexApprovalPolicy) opts.approvalPolicy = source.codexApprovalPolicy;
    if (source.codexSandbox) opts.sandbox = source.codexSandbox;
    // 同理：MCP 档位和 fast 开关也要跟着分支走，否则从 Lean/关 fast 的会话
    // 拉出来的分支会被悄悄拉回 Full / 开 fast。
    if (source.mcpProfile) opts.mcpProfile = source.mcpProfile;
    if (source.fastMode === false) opts.fastMode = false;
    if (source.codexSpeedTier) opts.codexSpeedTier = source.codexSpeedTier;
    if (typeof source.contextMax === 'number') opts.contextMax = source.contextMax;

    let kind;
    const createFork=()=>{
      const session=sessionManager.createSession(kind,opts);
      registerSessionForTap(session);sendToRenderer('session-created',{session});
      return {ok:true,session};
    };
    if (providerFamily === 'acp') {
      kind = source.kind.replace(/-resume$/, '');
      return sessionManager.getNativeSession(source.id).fork().then(fork=>{opts.acpFork=fork;return createFork();})
        .catch(error=>({ok:false,error:'acp-fork-failed',message:error.message}));
    } else if (providerFamily === 'claude') {
      kind = isDeepSeek ? 'deepseek' : 'claude';
      opts.forkCCSessionId = nativeSessionId;
      if (runtimeKind.startsWith('deepseek-legacy')) opts.deepseekLegacyClaude = true;
    } else {
      kind = isDeepSeek ? 'deepseek' : 'codex';
      if (source.codexProfile) opts.codexProfile = source.codexProfile;
      opts.codexForkSid = nativeSessionId;
    }

    return createFork();
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

  ipcMain.handle('codex:native-action', async (_event, payload = {}) => {
    const native = (sessionManager.getNativeSession?.(payload.sessionId) || sessionManager.getNativeCodex?.(payload.sessionId));
    if (!native) return {ok:false,message:'该 Codex 会话尚未接管'};
    try {
      let result;
      if (payload.action === 'reply') result = await native.reply(payload.requestId,payload.result,payload.epoch);
      else if (payload.action === 'choose-thread') result = await native.chooseThread(payload.threadId);
      else if (payload.action === 'reconnect') result = await native.reconnect();
      else if (payload.action === 'restart-empty') result = await native.restartEmpty(payload);
      else if (payload.action === 'interrupt') result = await native.interrupt();
      else if (payload.action === 'configure') result = await native.configure(payload);
      else if (payload.action === 'snapshot') result = native.runtime;
      else if (payload.action === 'review-submission') result = native.reviewUnknownSubmission(payload.submissionId,payload.epoch);
      else return {ok:false,message:'不支持的 Codex 操作'};
      return {ok:true,result};
    } catch (error) {
      return {ok:false,message:error.message};
    }
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

  // 侧栏「全部已读」。刻意不复用 focus-session：那条会顺带改 focusedSessionId，
  // 而批量标已读不该把焦点挪到列表里最后一个会话上（焦点还决定谁不被批量休眠）。
  ipcMain.on('mark-sessions-read', (_e, payload = {}) => {
    const ids = Array.isArray(payload && payload.sessionIds) ? payload.sessionIds : [];
    for (const sessionId of ids) {
      if (typeof sessionId === 'string' && sessionId) sessionManager.markRead(sessionId);
    }
  });

  ipcMain.handle('prepare-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const targetModel = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    const kind = String(session && session.kind || '').replace(/-resume$/, '').toLowerCase();
    if (!session || kind !== 'claude' || !isClaudeModelSelection(targetModel)) {
      return { ok: false, error: 'invalid-claude-switch', message: '无法为当前会话准备 Claude 模型切换' };
    }
    try {
      if (claudeModelPreferenceGuards.has(sessionId)) {
        await restoreClaudePreferenceGuard(sessionId, { waitForWrite: false });
      }
      const snapshot = captureClaudeModelPreference(targetModel);
      const timer = setTimeout(() => {
        void restoreClaudePreferenceGuard(sessionId).then(restored => {
          if (restored && restored.status === 'restore-failed') {
            console.warn('[model-switch] timed Claude default restoration failed:', restored.error);
          }
        });
      }, 20_000);
      timer.unref?.();
      claudeModelPreferenceGuards.set(sessionId, { snapshot, timer });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'preference-snapshot-failed', message: `无法保护 Claude 默认模型：${error.message}` };
    }
  });

  async function restoreClaudePreferenceGuard(sessionId, options = {}) {
    const entry = claudeModelPreferenceGuards.get(sessionId);
    if (!entry) return { restored: false, status: 'missing-snapshot' };
    if (entry.timer) clearTimeout(entry.timer);
    const waitForWrite = options.waitForWrite !== false;
    const deadline = Date.now() + (waitForWrite ? 2500 : 0);
    while (true) {
      let result;
      try { result = restoreClaudeModelPreference(entry.snapshot); }
      catch (error) {
        claudeModelPreferenceGuards.delete(sessionId);
        return { restored: false, status: 'restore-failed', error: error.message };
      }
      if (result.restored || result.status !== 'changed-externally') {
        claudeModelPreferenceGuards.delete(sessionId);
        return result;
      }
      const original = entry.snapshot.hadModel ? entry.snapshot.previousModel : undefined;
      if (result.currentModel !== original) {
        claudeModelPreferenceGuards.delete(sessionId);
        return result;
      }
      if (!waitForWrite || Date.now() >= deadline) {
        claudeModelPreferenceGuards.delete(sessionId);
        return { restored: true, status: 'unchanged' };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  ipcMain.handle('cancel-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    return { ok: true, preference: await restoreClaudePreferenceGuard(sessionId, { waitForWrite: false }) };
  });

  // Renderer calls this only after the provider-owned TUI confirms the switch.
  // Keeping metadata confirmation separate from terminal-input prevents a
  // failed picker interaction from making Hub claim a model that never became active.
  ipcMain.handle('confirm-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (!session) return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    if (['codex-app-server','acp'].includes(session.runtimeBackend)) {
      const current = session.currentModel || {};
      if (current.id !== modelId || (payload.effort && payload.effort !== session.effort)) {
        return {ok:false,message:'原生 Codex 尚未确认该模型或思考档'};
      }
      return {ok:true,model:current,effort:session.effort};
    }
    const kind = String(session.kind || '').replace(/-resume$/, '').toLowerCase();
    const valid = kind === 'codex'
      ? isCodexConversationModelId(modelId)
      : kind === 'claude'
        ? isClaudeModelSelection(modelId)
        : false;
    if (!valid) return { ok: false, error: 'invalid-model', message: '该模型不属于当前 CLI 的会话模型目录' };

    const displayName = String(payload.displayName || modelId)
      .replace(/[\0\r\n]+/g, ' ')
      .trim()
      .slice(0, 120) || modelId;
    const fields = { currentModel: { id: modelId, displayName } };
    const effort = String(payload.effort || '').toLowerCase();
    if (kind === 'codex' && CODEX_MODEL_EFFORTS.has(effort)) fields.effort = effort;
    const updated = sessionManager.updateSessionMeta(sessionId, fields);
    if (!updated) {
      if (kind === 'claude') await restoreClaudePreferenceGuard(sessionId);
      return { ok: false, error: 'update-failed', message: '模型已切换，但 Hub 元数据更新失败' };
    }
    sendToRenderer('session-updated', { session: updated });
    const preference = kind === 'claude' ? await restoreClaudePreferenceGuard(sessionId) : null;
    return {
      ok: true,
      model: fields.currentModel,
      effort: fields.effort || updated.effort || null,
      ...(preference ? { preference } : {}),
    };
  });

  // Sidebar placement lives in renderer state for dormant cards, but a live
  // SessionManager must learn it immediately too. Restart and the bulk-idle
  // guard read this authority before the debounced state.json write completes.
  ipcMain.on('update-session-placement', (_e, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId || typeof sessionManager.updateSessionMeta !== 'function') return;
    const pinned = payload.pinned === true;
    sessionManager.updateSessionMeta(sessionId, {
      pinned,
      bottomed: payload.bottomed === true && !pinned,
    });
  });

  ipcMain.handle('rename-session', (_e, { sessionId, title, userRenamed }) => {
    const session = sessionManager.renameSession(sessionId, title, { userRenamed: !!userRenamed });
    if (session) sendToRenderer('session-updated', { session });
    return session;
  });

  // Only explicit history navigation calls this. Previewing search results
  // must not manufacture activity or a completed model response.
  ipcMain.handle('session:record-history-open', (_e, { sessionId } = {}) => {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, message: '会话不存在或未成功恢复' };
    const at = Math.max(Date.now(), Number(session.lastMessageTime) || 0);
    const updated = sessionManager.updateSessionMeta(sessionId, { lastMessageTime: at, hiddenFromSidebar: false });
    if (!updated) return { ok: false, message: '侧栏活动时间更新失败' };
    return { ok: true, at };
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
    if (old.purpose !== 'chuxin-research' && (old.kind === 'codex' || old.kind === 'codex-resume')) {
      const native = (sessionManager.getNativeSession?.(sessionId) || sessionManager.getNativeCodex?.(sessionId));
      if (!native) return {ok:false,error:'unmanaged-codex',message:'旧 Codex 进程尚未接管；请先在原会话结束工作并关闭，再恢复'};
      return native.reconnect().then(()=>sessionManager.getSession(sessionId))
        .catch(error=>({ok:false,message:error.message}));
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
      ...(old.bottomed ? { bottomed: true } : {}),
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
