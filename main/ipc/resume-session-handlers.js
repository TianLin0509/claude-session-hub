'use strict';

const { isStableSessionTitle } = require('../../core/session-title-guards.js');
const { isKimiCliKind } = require('../../core/ai-kinds.js');
const { lookupKimiSession } = require('../../core/kimi-session-migrator.js');

function createResumeSessionHandler(deps) {
  const {
    defaultCodexSessionsRoot,
    findCodexRolloutBySid,
    findTranscriptByCCSessionId,
    fs,
    getHookPort,
    getHubDataDir,
    hookToken,
    isClaudeFamily,
    isCodexBaseKind,
    isCodexSubagentRolloutPath = () => false,
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

  function addCodexMcpEntry(resumeOpts, entry) {
    if (!entry) return;
    resumeOpts.codexMcpEntries = [...(resumeOpts.codexMcpEntries || []), entry];
  }

  return async function resumeSession(meta) {
    if (!meta || !meta.hubId) return null;
    const isClaude = (meta.kind === 'claude' || meta.kind === 'claude-resume');
    const isClaudeCliResumable = isClaudeFamily(meta.kind);
    const isKimi = isKimiCliKind(meta.kind);
    const isNativeResumeKind = (meta.kind === 'gemini' || isCodexBaseKind(meta.kind) || isKimi);
    let effectiveCodexSid = isCodexBaseKind(meta.kind) ? (meta.codexSid || null) : null;
    const hookPort = getHookPort();

    let resumeOpts = {};
    if (meta.meetingId) {
      const meeting = meetingManager.getMeeting(meta.meetingId);
      if (meeting && meeting.groupChat) resumeOpts.noInheritCursor = true;
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
        if (isClaudeCliResumable) {
          resumeOpts.appendSystemPromptFile = promptFile;
        } else if (meta.kind === 'gemini') {
          resumeOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
        } else if (isCodexBaseKind(meta.kind)) {
          resumeOpts.codexInstructionFile = promptFile;
        }
      }
      if (meeting && meeting.groupChat && isCodexBaseKind(meta.kind) && scenes.buildAiTeamMcpEntryForCodex) {
        addCodexMcpEntry(resumeOpts, scenes.buildAiTeamMcpEntryForCodex(meta.meetingId, meta.kind || 'codex'));
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
            ARENA_HUB_DATA_DIR: hubDataDir,
            SPIRIT_REGISTRY_ROOT: process.env.SPIRIT_REGISTRY_ROOT || path.join(os.homedir(), 'spirit-lens-registry'),
          };
        } else if (isCodexBaseKind(meta.kind)) {
          resumeOpts.codexBypassApprovals = true;
          addCodexMcpEntry(resumeOpts, scenes.buildResearchMcpEntryForCodex(meta.meetingId, hookPort, hookToken, hubDataDir));
        }
      } else if (meeting && meeting.groupChat && meeting.scene === 'research' && !hookPort) {
        logger.warn('[群聊] research scene resume for meeting ' + meta.meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
      }
    }

    let resumeTranscriptPath = meta.transcriptPath || null;
    if (isCodexBaseKind(meta.kind) && resumeTranscriptPath && isCodexSubagentRolloutPath(resumeTranscriptPath)) {
      logger.warn(`[resume-session] rejected subagent rollout binding for Hub session ${String(meta.hubId).slice(0, 8)}`);
      resumeTranscriptPath = null;
      effectiveCodexSid = null;
    }
    if (!resumeTranscriptPath && isClaudeCliResumable && meta.ccSessionId) {
      try { resumeTranscriptPath = findTranscriptByCCSessionId(meta.ccSessionId); } catch {}
    }
    if (!resumeTranscriptPath && isCodexBaseKind(meta.kind) && effectiveCodexSid) {
      try { resumeTranscriptPath = findCodexRolloutBySid(effectiveCodexSid, meta.codexSessionsRoot || defaultCodexSessionsRoot); } catch {}
    }
    const codexMissingSid = (isCodexBaseKind(meta.kind) && !effectiveCodexSid);

    // Kimi 会话绑死 cwd 且 CLI 会校验。归档搬目录后，renderer 持久化的 cwd /
    // kimiSessionDir 可能还是旧路径（休眠会话不在归档时的运行列表里），直接用会在
    // CLI 侧 "created under a different directory" 退出、Hub 只看到一个死终端。
    // 以 kimi 自己的 session_index.jsonl 为准对账：索引里的 workDir 存在就用它。
    if (isKimi && meta.kimiSid) {
      try {
        const indexed = lookupKimiSession(meta.kimiSid);
        if (indexed && indexed.workDir && fs.existsSync(indexed.workDir)) {
          const staleCwd = !meta.cwd
            || !fs.existsSync(meta.cwd)
            || path.resolve(meta.cwd) !== path.resolve(indexed.workDir);
          if (staleCwd) {
            logger.log(`[resume-session] kimi cwd reconciled via session_index: ${meta.cwd || '(empty)'} -> ${indexed.workDir}`);
            meta.cwd = indexed.workDir;
            if (indexed.sessionDir) {
              meta.kimiSessionDir = indexed.sessionDir;
              meta.transcriptPath = path.join(indexed.sessionDir, 'agents', 'main', 'wire.jsonl');
            }
          }
        }
      } catch (error) {
        logger.warn('[resume-session] kimi index reconcile failed:', error && error.message);
      }
    }

    const session = sessionManager.createSession(meta.kind || 'claude', {
      id: meta.hubId,
      title: meta.title,
      cwd: (meta.kind === 'gemini' && meta.geminiProjectRoot) ? meta.geminiProjectRoot : meta.cwd,
      ...(meta.workspaceLabel ? { workspaceLabel: meta.workspaceLabel } : {}),
      meetingId: meta.meetingId || null,
      model: meta.model || undefined,
      ...(meta.effort ? { effort: meta.effort } : {}),
      resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
      resumeTranscriptPath: resumeTranscriptPath || undefined,
      useContinue: isClaudeCliResumable && !meta.ccSessionId,
      useResume: isNativeResumeKind,
      codexResumePicker: codexMissingSid,
      codexSid: effectiveCodexSid,
      codexProfile: isCodexBaseKind(meta.kind) ? (meta.codexProfile || null) : null,
      geminiChatId: meta.kind === 'gemini' ? (meta.geminiChatId || null) : null,
      geminiProjectRoot: meta.kind === 'gemini' ? (meta.geminiProjectRoot || null) : null,
      ...(isKimi ? {
        kimiSid: meta.kimiSid || null,
        kimiSessionDir: meta.kimiSessionDir || null,
        kimiResumePicker: !meta.kimiSid,
      } : {}),
      userRenamed: !!meta.userRenamed,
      autoTitleGenerated: !!meta.autoTitleGenerated || isStableSessionTitle(meta.title, meta.kind),
      ...(meta.pinned ? { pinned: true } : {}),
      lastMessageTime: meta.lastMessageTime,
      lastOutputPreview: meta.lastOutputPreview,
      ...resumeOpts,
    });
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });

    const needsLevel3 = (
      (isCodexBaseKind(meta.kind) && !effectiveCodexSid) ||
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
  };
}

function registerResumeSessionIpc(ipcMain, deps) {
  const resumeSession = typeof deps.resumeSession === 'function'
    ? deps.resumeSession
    : createResumeSessionHandler(deps);
  ipcMain.handle('resume-session', (_event, meta) => resumeSession(meta));
  return { resumeSession };
}

module.exports = {
  createResumeSessionHandler,
  registerResumeSessionIpc,
};
