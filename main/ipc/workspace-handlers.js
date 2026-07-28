'use strict';

const path = require('path');
const { normalizeKey } = require('../../core/workspace-service.js');
const { migrateTranscriptsForCwdChange } = require('../../core/claude-transcript-locator.js');
const { migrateKimiSession } = require('../../core/kimi-session-migrator.js');

// claude CLI 的 --resume 按 cwd 分桶查找 transcript，deepseek 走同一套本地存储。
// codex 的 rollout 按日期存放、gemini 按 project root 记录，都不受目录搬迁影响。
const CWD_BOUND_TRANSCRIPT_KINDS = new Set(['claude', 'deepseek']);

function baseKind(kind) {
  return String(kind || '').replace(/-resume$/, '');
}

function registerWorkspaceIpc(ipcMain, deps) {
  const {
    dialog,
    meetingManager,
    sendToRenderer,
    sessionManager,
    shell,
    resumeSession,
    allowFallbackResume = false,
    workspaceMigrationSessionIds = new Set(),
    workspaceService,
    getLastPersistedSessions = () => [],
  } = deps;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function entityContext(args = {}) {
    if (args.scope === 'meeting') {
      const meeting = meetingManager && meetingManager.getMeeting(args.id);
      if (!meeting) throw new Error('AI 群聊不存在或已经关闭');
      return {
        scope: 'meeting',
        id: meeting.id,
        title: meeting.title,
        source: meeting.workspace,
        label: meeting.workspaceLabel || meeting.title,
        meeting,
      };
    }
    const session = sessionManager.getSession(args.id);
    if (!session || session.meetingId) throw new Error('普通会话不存在或已经关闭');
    return {
      scope: 'session',
      id: session.id,
      title: session.title,
      source: session.cwd,
      label: session.workspaceLabel || session.title,
      session,
    };
  }

  function toResumeMeta(session, cwd, workspaceLabel) {
    const model = session.currentModel && typeof session.currentModel === 'object'
      ? session.currentModel.id
      : session.currentModel;
    const isGemini = typeof session.kind === 'string' && session.kind.replace(/-resume$/, '') === 'gemini';
    return {
      hubId: session.id,
      kind: session.kind,
      title: session.title,
      cwd,
      workspaceLabel,
      ccSessionId: session.ccSessionId || null,
      transcriptPath: session.transcriptPath || null,
      meetingId: session.meetingId || null,
      lastMessageTime: session.lastMessageTime,
      lastOutputPreview: session.lastOutputPreview,
      model: model || null,
      effort: session.effort || null,
      codexSid: session.codexSid || null,
      codexSessionsRoot: session.codexSessionsRoot || null,
      codexAllowMtimeFallback: !!session.codexAllowMtimeFallback,
      codexProfile: session.codexProfile || null,
      geminiChatId: session.geminiChatId || null,
      geminiProjectHash: session.geminiProjectHash || null,
      geminiProjectRoot: isGemini ? cwd : (session.geminiProjectRoot || null),
      kimiSid: session.kimiSid || null,
      kimiSessionDir: session.kimiSessionDir || null,
      userRenamed: !!session.userRenamed,
      autoTitleGenerated: !!session.autoTitleGenerated,
      pinned: !!session.pinned,
    };
  }

  function preciseResumeIssue(session) {
    if (allowFallbackResume) return null;
    const kind = String(session && session.kind || '').replace(/-resume$/, '');
    if (kind === 'claude' || kind === 'deepseek') return session.ccSessionId ? null : `${session.title || kind} 尚未绑定 Claude session ID`;
    if (kind === 'codex') return session.codexSid ? null : `${session.title || kind} 尚未绑定 Codex session ID`;
    if (kind === 'gemini') return session.geminiChatId ? null : `${session.title || kind} 尚未绑定 Gemini chat ID`;
    if (kind === 'kimi') return session.kimiSid ? null : `${session.title || kind} 尚未绑定 Kimi session ID`;
    return `${session && session.title || kind || '当前终端'} 不支持保留上下文迁移`;
  }

  function sessionsForEntity(entity) {
    if (entity.scope === 'meeting') {
      return (entity.meeting.subSessions || []).map(id => sessionManager.getSession(id)).filter(Boolean);
    }
    if (!entity.session) return [];
    // 分支会话（fork）继承源会话的 cwd，普通会话也可能被手动开在同一目录。
    // 只关掉 entity.id 的话，剩下的进程仍占着目录，rename 在 Windows 上会 EBUSY；
    // 就算侥幸移动成功，兄弟会话的 cwd 也会指向一个不存在的路径。
    return sessionManager.getAllSessions()
      .filter(session => session
        && !session.meetingId
        && session.cwd
        && normalizeKey(session.cwd) === normalizeKey(entity.source));
  }

  async function waitForSessionsClosed(ids, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (ids.some(id => sessionManager.getSession(id))) {
      if (Date.now() >= deadline) {
        const stillOpen = ids.filter(id => sessionManager.getSession(id));
        throw new Error(`CLI 未能及时退出：${stillOpen.map(id => id.slice(0, 8)).join(', ')}`);
      }
      await wait(50);
    }
  }

  async function resumeAll(snapshots, cwd, workspaceLabel) {
    const resumed = [];
    const failures = [];
    for (const snapshot of snapshots) {
      try {
        const session = await resumeSession(toResumeMeta(snapshot, cwd, workspaceLabel));
        if (session) resumed.push(session);
        else failures.push(`${snapshot.title || snapshot.id}: 返回空会话`);
      } catch (error) {
        failures.push(`${snapshot.title || snapshot.id}: ${error && error.message ? error.message : String(error)}`);
      }
    }
    return { resumed, failures };
  }

  async function archiveDraftAfterExit(source, opts) {
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { return workspaceService.archiveDraft(source, opts); } catch (error) {
        lastError = error;
        if (!error || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        await wait(100);
      }
    }
    throw lastError || new Error('workspace move failed after CLI exit');
  }

  function activePaths() {
    const sessionPaths = sessionManager.getAllSessions()
      .filter(session => session && session.cwd)
      .map(session => session.cwd);
    const meetingPaths = meetingManager && typeof meetingManager.getAllMeetings === 'function'
      ? meetingManager.getAllMeetings().map(meeting => meeting && meeting.workspace).filter(Boolean)
      : [];
    return [...sessionPaths, ...meetingPaths];
  }

  ipcMain.handle('workspace:list', () => workspaceService.listWorkspaces(activePaths()));

  ipcMain.handle('workspace:create-scratch', (_event, opts = {}) => {
    const workspace = workspaceService.createScratchWorkspace({ ...opts, select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:select', (_event, cwd) => {
    const workspace = workspaceService.touchWorkspace(cwd, { select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 AI Hub workspace',
      defaultPath: workspaceService.getWorkspaceRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此文件夹',
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const workspace = workspaceService.touchWorkspace(result.filePaths[0], { select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:pick-archive-parent', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择正式项目所在文件夹',
      defaultPath: workspaceService.getWorkspaceRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '在这里新建项目目录',
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    return { path: path.resolve(result.filePaths[0]) };
  });

  ipcMain.handle('workspace:dismiss-archive', (_event, args = {}) => {
    const workspace = workspaceService.dismissArchive(args && args.path);
    if (workspace) sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:archive-context', (_event, args = {}) => {
    const entity = entityContext(args);
    const context = workspaceService.getArchiveContext(entity.source);
    const entitySessions = sessionsForEntity(entity);
    const resumeIssues = entitySessions.map(preciseResumeIssue).filter(Boolean);
    if (entity.scope === 'meeting' && entitySessions.length !== (entity.meeting.subSessions || []).length) {
      resumeIssues.push('部分群聊成员当前未运行');
    }
    if (entity.scope === 'session' && entitySessions.length === 0) {
      resumeIssues.push('当前会话未在运行');
    }
    return {
      ...context,
      scope: entity.scope,
      id: entity.id,
      title: entity.title,
      source: entity.source,
      label: entity.label,
      resumeReady: resumeIssues.length === 0,
      resumeIssues,
    };
  });

  ipcMain.handle('workspace:archive-and-restart', async (_event, args = {}) => {
    if (typeof resumeSession !== 'function') throw new Error('Hub resume service is unavailable');
    const entity = entityContext(args);
    const plan = workspaceService.planArchive(entity.source, {
      parent: args.parent,
      folderName: args.folderName,
    });
    // session scope 收全部占用该目录的会话（含 fork 分支），meeting scope 收全体成员。
    const snapshots = sessionsForEntity(entity);
    const ids = snapshots.map(session => session.id);
    if (ids.length === 0) throw new Error('没有可安全重连的活动 CLI');
    if (entity.scope === 'meeting' && ids.length !== (entity.meeting.subSessions || []).length) {
      throw new Error('部分群聊成员未运行，请先恢复全部成员再归档');
    }
    const resumeIssues = snapshots.map(preciseResumeIssue).filter(Boolean);
    if (resumeIssues.length > 0) throw new Error(`${resumeIssues.join('；')}，请稍等会话绑定完成后重试`);
    ids.forEach(id => workspaceMigrationSessionIds.add(id));

    let moved = false;
    let workspace = null;
    // Kimi 迁移失败的会话 id：不再盲目重连（连上也是个死终端），汇总到失败列表。
    const kimiFailedIds = new Set();
    const kimiFailures = [];
    try {
      ids.forEach(id => sessionManager.closeSession(id));
      await waitForSessionsClosed(ids);
      workspace = await archiveDraftAfterExit(entity.source, {
        parent: plan.parent,
        folderName: plan.folderName,
        label: entity.label,
      });
      moved = true;

      let meeting = null;
      if (entity.scope === 'meeting') {
        meeting = meetingManager.updateMeeting(entity.id, {
          workspace: workspace.path,
          workspaceLabel: workspace.label,
        });
        if (meeting) sendToRenderer('meeting-updated', { meeting });
      }

      // Must run before resumeAll: the CLI resolves --resume against the *new*
      // cwd bucket, so without this the archived session comes back empty.
      const migration = migrateTranscriptsForCwdChange({
        toCwd: workspace.path,
        ccSessionIds: snapshots
          .filter(snapshot => CWD_BOUND_TRANSCRIPT_KINDS.has(baseKind(snapshot.kind)))
          .map(snapshot => snapshot.ccSessionId)
          .filter(Boolean),
      });
      if (migration.errors.length > 0 || migration.missing.length > 0) {
        console.warn('[workspace] transcript migration incomplete:',
          { errors: migration.errors, missing: migration.missing });
      }

      // Kimi 会校验会话记录的 workDir 与 cwd 是否一致，不迁移就直接
      // "created under a different directory" 退出——PTY spawn 仍然成功，
      // Hub 察觉不到，用户只会看到一个死掉的终端。必须在重连前搬好注册表。
      // 迁移成功后必须把新 sessionDir/wire 路径写回 resume meta，否则 tap 和
      // 卡片视图继续盯着已被搬走的旧路径（JsonlTail 对缺失文件静默轮询，永不恢复）；
      // 迁移失败的会话不再盲目重连（连上也是个死终端），而是汇总报错。
      const migrateKimiSnapshot = (snapshot) => {
        if (baseKind(snapshot.kind) !== 'kimi' || !snapshot.kimiSid) return;
        try {
          const migration = migrateKimiSession({ sessionId: snapshot.kimiSid, toCwd: workspace.path });
          if (!migration.ok) {
            kimiFailedIds.add(snapshot.id);
            kimiFailures.push(`${snapshot.title || snapshot.id}: ${migration.reason}`);
            return;
          }
          if (migration.sessionDir) {
            snapshot.kimiSessionDir = migration.sessionDir;
            snapshot.transcriptPath = path.join(migration.sessionDir, 'agents', 'main', 'wire.jsonl');
          }
        } catch (error) {
          kimiFailedIds.add(snapshot.id);
          kimiFailures.push(`${snapshot.title || snapshot.id}: ${error && error.message ? error.message : String(error)}`);
        }
      };
      for (const snapshot of snapshots) migrateKimiSnapshot(snapshot);

      // 同目录下 dormant（未运行）的 Kimi 会话也要一起搬：它们的 kimi 状态仍指着
      // 已被移走的旧目录，不搬的话之后唤醒必然 "created under a different directory"。
      // renderer 里该条目的 cwd/kimiSessionDir 由 session-meta-updated 广播同步，
      // resume 时还有 lookupKimiSession 对账兜底（resume-session-handlers）。
      const liveIds = new Set(ids);
      const dormantKimiMigrated = [];
      for (const entry of getLastPersistedSessions() || []) {
        if (!entry || !entry.hubId || liveIds.has(entry.hubId)) continue;
        if (baseKind(entry.kind) !== 'kimi' || !entry.kimiSid) continue;
        if (!entry.cwd || normalizeKey(entry.cwd) !== normalizeKey(entity.source)) continue;
        try {
          const migration = migrateKimiSession({ sessionId: entry.kimiSid, toCwd: workspace.path });
          if (!migration.ok) {
            kimiFailures.push(`${entry.title || entry.hubId}（休眠）: ${migration.reason}`);
            continue;
          }
          entry.cwd = workspace.path;
          if (migration.sessionDir) {
            entry.kimiSessionDir = migration.sessionDir;
            entry.transcriptPath = path.join(migration.sessionDir, 'agents', 'main', 'wire.jsonl');
          }
          dormantKimiMigrated.push(entry.hubId);
          sendToRenderer('session-meta-updated', {
            hubSessionId: entry.hubId,
            kind: entry.kind,
            kimiSid: entry.kimiSid,
            kimiSessionDir: entry.kimiSessionDir || null,
            transcriptPath: entry.transcriptPath || null,
            cwd: workspace.path,
          });
        } catch (error) {
          kimiFailures.push(`${entry.title || entry.hubId}（休眠）: ${error && error.message ? error.message : String(error)}`);
        }
      }

      const restart = await resumeAll(
        snapshots.filter(snapshot => !kimiFailedIds.has(snapshot.id)),
        workspace.path,
        workspace.label,
      );
      restart.failures.unshift(...kimiFailures);
      sendToRenderer('workspace-updated', { workspace });
      if (restart.failures.length > 0) {
        throw new Error(`Workspace 已归档，但部分 CLI 重连失败：${restart.failures.join('；')}`);
      }
      return {
        ok: true,
        scope: entity.scope,
        id: entity.id,
        source: entity.source,
        workspace,
        resumedSessionIds: restart.resumed.map(session => session.id),
        dormantKimiMigrated,
      };
    } catch (error) {
      const closedSnapshots = snapshots.filter(snapshot =>
        !sessionManager.getSession(snapshot.id) && !kimiFailedIds.has(snapshot.id));
      if (closedSnapshots.length > 0) {
        if (moved && workspace) await resumeAll(closedSnapshots, workspace.path, workspace.label);
        else await resumeAll(closedSnapshots, entity.source, entity.label);
      }
      throw error;
    } finally {
      ids.forEach(id => workspaceMigrationSessionIds.delete(id));
    }
  });

  ipcMain.handle('workspace:rename-label', (_event, args = {}) => {
    const workspace = workspaceService.renameLabel(args.path, args.label);
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:reveal', async (_event, cwd) => {
    const target = path.resolve(String(cwd || ''));
    const known = workspaceService.listWorkspaces(activePaths()).items
      .some(item => normalizeKey(item.path) === normalizeKey(target));
    if (!known) return { ok: false, error: 'unknown-workspace' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
}

module.exports = { registerWorkspaceIpc };
