'use strict';

function createMeetingSubAdder(deps) {
  const {
    fs,
    getHookPort,
    getHubDataDir,
    getMeetingWorkspaceDir,
    getSlotPromptName,
    groupchat,
    hookToken,
    isClaudeFamily,
    isCodexBaseKind,
    isIsolatedHub,
    kindLabels,
    logger = console,
    meetingManager,
    path,
    registerSessionForTap,
    scenes,
    sendToRenderer,
    sessionManager,
    slotIds,
  } = deps;

  return async function addMeetingSubInternal(meetingId, kind, opts = {}) {
    const meeting = meetingManager.getMeeting(meetingId);
    let sessionOpts = { ...(opts || {}), meetingId };
    if (opts && opts.model) sessionOpts.model = opts.model;

    let slotId = null;
    if (meeting) {
      const currentSubCount = (meeting.subSessions || []).length;
      if (currentSubCount < slotIds.length) {
        slotId = slotIds[currentSubCount];
      }
      if (!sessionOpts.title) {
        if (meeting.groupChat) {
          const label = kindLabels[kind] || kind || 'AI';
          sessionOpts.title = `${label} ${currentSubCount + 1}`;
        } else if (slotId) {
          sessionOpts.title = getSlotPromptName(slotId);
        }
      }
    }

    if (!sessionOpts.cwd) {
      let workspaceDir = null;
      if (isIsolatedHub()) {
        workspaceDir = getMeetingWorkspaceDir(meetingId);
      } else if (meeting) {
        const homeDir = process.env.USERPROFILE || process.env.HOME || '.';
        const bucket = 'groupchat';
        workspaceDir = path.join(homeDir, '.arena', bucket, meetingId);
      }
      if (workspaceDir) {
        try {
          fs.mkdirSync(workspaceDir, { recursive: true });
          sessionOpts.cwd = workspaceDir;
        } catch (err) {
          logger.warn(`[meeting-sub] workspace mkdir failed for ${meetingId}: ${err.message}; sub will use default cwd`);
        }
      }
    }

    const hookPort = getHookPort();
    if (meeting && meeting.groupChat && meeting.scene === 'research' && hookPort) {
      const hubDataDir = getHubDataDir();
      if (isClaudeFamily(kind)) {
        sessionOpts.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, meetingId, hookPort, hookToken, kind);
      } else if (kind === 'gemini') {
        sessionOpts.extraEnv = {
          ...(sessionOpts.extraEnv || {}),
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: hookToken,
          ARENA_AI_KIND: 'gemini',
        };
      } else if (isCodexBaseKind(kind)) {
        sessionOpts.codexBypassApprovals = true;
        sessionOpts.codexMcpEntries = [scenes.buildResearchMcpEntryForCodex(meetingId, hookPort, hookToken)];
      }
    } else if (meeting && meeting.groupChat && meeting.scene === 'research' && !hookPort) {
      logger.warn('[群聊] research scene in meeting ' + meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
    }

    const session = sessionManager.createSession(kind, sessionOpts);
    if (!session) return null;
    const updated = meetingManager.addSubSession(meetingId, session.id);
    if (!updated) {
      sessionManager.closeSession(session.id);
      return null;
    }

    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    const freshMeeting = meetingManager.getMeeting(meetingId);
    sendToRenderer('meeting-updated', { meeting: freshMeeting || updated });
    return { session, meeting: freshMeeting || updated };
  };
}

function registerMeetingCreateIpc(ipcMain, deps) {
  const {
    getHubDataDir,
    groupchat,
    logger = console,
    meetingManager,
    sendToRenderer,
  } = deps;
  const addMeetingSubInternal = createMeetingSubAdder(deps);

  ipcMain.handle('create-meeting', async (_e, opts) => {
    const safe = { ...(opts || {}) };
    safe.groupChat = true;
    const hasCustomTitle = typeof safe.title === 'string' && safe.title.trim().length > 0;
    safe.autoTitlePending = !hasCustomTitle;
    safe.userRenamed = hasCustomTitle;
    if (Array.isArray(safe.slots) && safe.slots.length > 0) {
      safe.slotSpecs = safe.slots.map(s => ({
        index: typeof s.index === 'number' ? s.index : null,
        kind: s.kind,
        model: s.model || null,
      }));
      if (safe.groupChat && !Array.isArray(safe.participants)) {
        safe.participants = safe.slots.map((_, i) => i);
      }
    }
    const meeting = meetingManager.createMeeting(safe);

    if (Array.isArray(safe.slots) && safe.slots.length > 0) {
      const errors = [];
      for (const slot of safe.slots) {
        try {
          await addMeetingSubInternal(meeting.id, slot.kind, { model: slot.model });
        } catch (err) {
          errors.push({ slot, message: err && err.message || String(err) });
          logger.warn('[create-meeting] add-sub failed for slot', slot, err && err.message);
        }
      }
      const finalMeeting = meetingManager.getMeeting(meeting.id);
      const subCount = finalMeeting ? (finalMeeting.subSessions || []).length : 0;
      if (subCount === 0) {
        try { meetingManager.closeMeeting(meeting.id); } catch (err) { logger.warn('[create-meeting] close empty meeting failed:', err.message); }
        try { groupchat.cleanup?.(getHubDataDir(), meeting.id); } catch {}
        const detail = errors.map(er => `· ${er.slot.kind}（${er.slot.model || 'default'}）：${er.message}`).join('\n');
        throw new Error('所有子会话创建失败：\n' + (detail || '（未知原因）'));
      }
      meetingManager.setSlotSpecs(meeting.id, safe.slotSpecs);
      if (errors.length > 0) {
        sendToRenderer('meeting-created-with-errors', { meeting: finalMeeting, errors });
      }
      sendToRenderer('meeting-created', { meeting: finalMeeting });
    } else {
      sendToRenderer('meeting-created', { meeting });
    }

    return meetingManager.getMeeting(meeting.id) || meeting;
  });

  ipcMain.handle('add-meeting-sub', async (_e, args = {}) => {
    const { meetingId, kind, model } = args;
    const opts = args.opts || {};
    if (model && !opts.model) opts.model = model;
    return addMeetingSubInternal(meetingId, kind, opts);
  });

  return { addMeetingSubInternal };
}

module.exports = {
  createMeetingSubAdder,
  registerMeetingCreateIpc,
};
