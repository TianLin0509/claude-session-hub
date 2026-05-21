'use strict';

function registerResumeSessionIpc(ipcMain, deps) {
  const {
    defaultCodexSessionsRoot,
    findCodexRolloutBySid,
    findTranscriptByCCSessionId,
    fs,
    getHookPort,
    getHubDataDir,
    hookToken,
    isClaudeFamily,
    isClaudeWebKind,
    isCodexBaseKind,
    logger = console,
    meetingManager,
    os,
    path,
    readTranscriptTail,
    registerSessionForTap,
    scenes,
    sendToRenderer,
    sessionManager,
    slotIds,
  } = deps;

  ipcMain.handle('resume-session', async (_e, meta) => {
    if (!meta || !meta.hubId) return null;
    const isClaude = (meta.kind === 'claude' || meta.kind === 'claude-resume' || isClaudeWebKind(meta.kind));
    const isGlm = (meta.kind === 'glm');
    const isClaudeCliResumable = isClaudeFamily(meta.kind);
    const isGeminiOrCodex = (meta.kind === 'gemini' || isCodexBaseKind(meta.kind));
    const codexMissingSid = (isCodexBaseKind(meta.kind) && !meta.codexSid);
    const hookPort = getHookPort();

    let resumeOpts = {};
    if (meta.meetingId) {
      const meeting = meetingManager.getMeeting(meta.meetingId);
      let promptFile = null;
      if (meeting && meeting.scene && !meeting.groupChat) {
        const hubDataDir = getHubDataDir();
        const covenantText = (typeof meeting.covenantText === 'string' && meeting.covenantText.length > 0)
          ? meeting.covenantText
          : scenes.readCovenantSnapshot(hubDataDir, meta.meetingId);
        let slotId = null;
        if (Array.isArray(meeting.subSessions)) {
          const idx = meeting.subSessions.indexOf(meta.hubId);
          if (idx >= 0 && idx < slotIds.length) slotId = slotIds[idx];
        }
        promptFile = scenes.writePromptFile(hubDataDir, meta.meetingId, meeting.scene, covenantText, slotId);
      }
      if (promptFile) {
        if (isClaude || isGlm) {
          resumeOpts.appendSystemPromptFile = promptFile;
        } else if (meta.kind === 'gemini') {
          resumeOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
        } else if (isCodexBaseKind(meta.kind)) {
          resumeOpts.codexInstructionFile = promptFile;
        }
      }
      if (meeting && meeting.groupChat && meeting.scene === 'research' && hookPort) {
        const hubDataDir = getHubDataDir();
        if (isClaudeCliResumable) {
          resumeOpts.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, meta.meetingId, hookPort, hookToken, meta.kind || 'claude');
        } else if (meta.kind === 'gemini') {
          resumeOpts.extraEnv = {
            ...(resumeOpts.extraEnv || {}),
            ELECTRON_RUN_AS_NODE: '1',
            ARENA_MEETING_ID: meta.meetingId,
            ARENA_HUB_PORT: String(hookPort),
            ARENA_HOOK_TOKEN: hookToken,
            ARENA_AI_KIND: 'gemini',
          };
        } else if (isCodexBaseKind(meta.kind)) {
          resumeOpts.codexBypassApprovals = true;
          resumeOpts.codexMcpEntries = [scenes.buildResearchMcpEntryForCodex(meta.meetingId, hookPort, hookToken)];
        }
      } else if (meeting && meeting.groupChat && meeting.scene === 'research' && !hookPort) {
        logger.warn('[群聊] research scene resume for meeting ' + meta.meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
      }
    }

    let resumeTranscriptPath = meta.transcriptPath || null;
    if (!resumeTranscriptPath && isClaudeCliResumable && meta.ccSessionId) {
      try { resumeTranscriptPath = findTranscriptByCCSessionId(meta.ccSessionId); } catch {}
    }
    if (!resumeTranscriptPath && isCodexBaseKind(meta.kind) && meta.codexSid) {
      try { resumeTranscriptPath = findCodexRolloutBySid(meta.codexSid, meta.codexSessionsRoot || defaultCodexSessionsRoot); } catch {}
    }

    const session = sessionManager.createSession(meta.kind || 'claude', {
      id: meta.hubId,
      title: meta.title,
      cwd: (meta.kind === 'gemini' && meta.geminiProjectRoot) ? meta.geminiProjectRoot : meta.cwd,
      meetingId: meta.meetingId || null,
      model: meta.model || undefined,
      resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
      resumeTranscriptPath: resumeTranscriptPath || undefined,
      useContinue: isClaudeCliResumable && !meta.ccSessionId,
      useResume: isGeminiOrCodex,
      codexResumePicker: codexMissingSid,
      codexSid: isCodexBaseKind(meta.kind) ? (meta.codexSid || null) : null,
      codexProfile: isCodexBaseKind(meta.kind) ? (meta.codexProfile || null) : null,
      geminiChatId: meta.kind === 'gemini' ? (meta.geminiChatId || null) : null,
      geminiProjectRoot: meta.kind === 'gemini' ? (meta.geminiProjectRoot || null) : null,
      autoTitleGenerated: !!meta.autoTitleGenerated,
      lastMessageTime: meta.lastMessageTime,
      lastOutputPreview: meta.lastOutputPreview,
      ...resumeOpts,
    });
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });

    const needsLevel3 = (
      (isCodexBaseKind(meta.kind) && !meta.codexSid) ||
      (meta.kind === 'gemini' && !meta.geminiChatId)
    );

    if (needsLevel3) {
      let sourcePath = null;
      if (meta.kind === 'gemini' && meta.geminiProjectHash && meta.geminiChatId) {
        try {
          const dir = path.join(os.homedir(), '.gemini', 'tmp', meta.geminiProjectHash, 'chats');
          const f = fs.readdirSync(dir).find(n => n.includes(meta.geminiChatId));
          if (f) sourcePath = path.join(dir, f);
        } catch {}
      }

      if (sourcePath) {
        readTranscriptTail(meta.kind, sourcePath, 10).then(tail => {
          if (!tail) return;
          const msg = `[CONTEXT FROM PREVIOUS SESSION]\n${tail}\n\n[END CONTEXT]\n`;
          setTimeout(() => {
            try {
              const sess = sessionManager.getSession(session.id);
              if (!sess || sess.status === 'dormant') {
                logger.warn(`[群聊] Level 3 inject skipped: session ${session.id.slice(0, 8)} no longer active`);
                return;
              }
              sessionManager.writeToSession(session.id, msg);
              logger.log(`[群聊] Level 3 fallback: injected ${tail.length}-char transcript tail to ${meta.kind} session ${session.id.slice(0, 8)}`);
            } catch (err) {
              logger.warn(`[群聊] Level 3 inject failed:`, err.message);
            }
          }, 5000);
        }).catch(err => logger.warn('[群聊] Level 3 fallback error:', err.message));
      }
    }

    return session;
  });
}

module.exports = {
  registerResumeSessionIpc,
};
