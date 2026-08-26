'use strict';

const { isStableSessionTitle } = require('../../core/session-title-guards.js');
const { isKimiCliKind } = require('../../core/ai-kinds.js');
const { lookupKimiSession: defaultLookupKimiSession } = require('../../core/kimi-session-migrator.js');
const { sessionModelId } = require('../../core/session-capabilities.js');

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
    lookupKimiSession = defaultLookupKimiSession,
    logger = console,
    meetingManager,
    os,
    path,
    readCodexRolloutMeta = () => null,
    readTranscriptTail,
    registerSessionForTap,
    resolveCodexSessionsRoot = null,
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
    const isGemini = meta.kind === 'gemini' || meta.kind === 'gemini-resume';
    const isDeepSeek = meta.kind === 'deepseek' || meta.kind === 'deepseek-resume';
    const isLegacyDeepSeek = isDeepSeek && !!meta.ccSessionId && !meta.codexSid;
    const isClaudeCliResumable = isClaudeFamily(meta.kind) || isLegacyDeepSeek;
    const isCodexRuntime = isCodexBaseKind(meta.kind) && !isLegacyDeepSeek;
    const isKimi = isKimiCliKind(meta.kind);
    const isNativeResumeKind = (isGemini || isCodexRuntime || isKimi);
    let effectiveCodexSid = isCodexRuntime ? (meta.codexSid || null) : null;
    let effectiveCodexSessionsRoot = isCodexRuntime ? (meta.codexSessionsRoot || null) : null;
    if (isCodexRuntime && !effectiveCodexSessionsRoot && typeof resolveCodexSessionsRoot === 'function') {
      try {
        effectiveCodexSessionsRoot = resolveCodexSessionsRoot(meta) || null;
      } catch (error) {
        logger.warn('[resume-session] failed to resolve Codex profile sessions root:', error && error.message);
      }
    }
    if (isCodexRuntime && !effectiveCodexSessionsRoot) {
      effectiveCodexSessionsRoot = defaultCodexSessionsRoot;
    }
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
        } else if (isGemini) {
          resumeOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
        } else if (isCodexRuntime) {
          resumeOpts.codexInstructionFile = promptFile;
        }
      }
      const codexMcpEnabled = meta.mcpProfile !== 'none';
      if (meeting && meeting.groupChat && isCodexRuntime && codexMcpEnabled && scenes.buildAiTeamMcpEntryForCodex) {
        addCodexMcpEntry(resumeOpts, scenes.buildAiTeamMcpEntryForCodex(meta.meetingId, meta.kind || 'codex'));
      }
      if (meeting && meeting.groupChat && meeting.scene === 'research' && hookPort) {
        const hubDataDir = getHubDataDir();
        if (isClaudeCliResumable) {
          resumeOpts.mcpConfigFile = scenes.writeResearchMcpConfig(
            hubDataDir, meta.meetingId, hookPort, hookToken, meta.kind || 'claude', { enableChuxin: true },
          );
        } else if (isGemini) {
          resumeOpts.extraEnv = {
            ...(resumeOpts.extraEnv || {}),
            ELECTRON_RUN_AS_NODE: '1',
            ARENA_MEETING_ID: meta.meetingId,
            ARENA_HUB_PORT: String(hookPort),
            ARENA_HOOK_TOKEN: hookToken,
            ARENA_AI_KIND: 'gemini',
            ARENA_HUB_DATA_DIR: hubDataDir,
            ARENA_CHUXIN_ENABLED: '1',
            SPIRIT_REGISTRY_ROOT: process.env.SPIRIT_REGISTRY_ROOT || path.join(os.homedir(), 'spirit-lens-registry'),
          };
        } else if (isCodexRuntime && codexMcpEnabled) {
          resumeOpts.codexBypassApprovals = true;
          addCodexMcpEntry(resumeOpts, scenes.buildResearchMcpEntryForCodex(
            meta.meetingId, hookPort, hookToken, hubDataDir, { enableChuxin: true },
          ));
        }
      } else if (meeting && meeting.groupChat && meeting.scene === 'research' && !hookPort) {
        logger.warn('[群聊] research scene resume for meeting ' + meta.meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
      }
    }

    let resumeTranscriptPath = meta.transcriptPath || null;
    if (isCodexRuntime && resumeTranscriptPath && isCodexSubagentRolloutPath(resumeTranscriptPath)) {
      // Older Hub builds could persist the active Codex subagent rollout as if
      // it were the top-level PTY session. Recover the parent native SID when
      // the rollout records it; otherwise keep the old safe picker fallback.
      let parentCodexSid = null;
      let subagentCodexSid = null;
      try {
        const rolloutMeta = readCodexRolloutMeta(resumeTranscriptPath);
        subagentCodexSid = rolloutMeta && (rolloutMeta.id || rolloutMeta.session_id) || null;
        parentCodexSid = rolloutMeta && (
          rolloutMeta.parent_thread_id
          || rolloutMeta.source?.subagent?.thread_spawn?.parent_thread_id
          || rolloutMeta.source?.subagent?.parent_thread_id
        ) || null;
      } catch {}
      resumeTranscriptPath = null;
      if (parentCodexSid) {
        effectiveCodexSid = parentCodexSid;
        logger.warn(`[resume-session] repaired subagent binding to parent Codex session ${String(parentCodexSid).slice(0, 8)}`);
      } else if (!effectiveCodexSid || !subagentCodexSid || effectiveCodexSid === subagentCodexSid) {
        effectiveCodexSid = null;
        logger.warn(`[resume-session] rejected subagent rollout binding for Hub session ${String(meta.hubId).slice(0, 8)}`);
      }
    }
    // Resume metadata may point at a pre-archive path.  Provider-native ids are
    // the authority: when discovery succeeds, prefer it even if a persisted
    // transcriptPath is present instead of letting an old card source win.
    if (isClaudeCliResumable && meta.ccSessionId) {
      try {
        const discovered = findTranscriptByCCSessionId(meta.ccSessionId);
        if (discovered) resumeTranscriptPath = discovered;
      } catch {}
    }
    if (isCodexRuntime && effectiveCodexSid) {
      try {
        const discovered = findCodexRolloutBySid(effectiveCodexSid, effectiveCodexSessionsRoot);
        if (discovered) resumeTranscriptPath = discovered;
      } catch {}
    }
    const codexMissingSid = (isCodexRuntime && !effectiveCodexSid);

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
          }
          // cwd can already be correct while the persisted sessionDir/wire path
          // is stale or absent.  Reconcile the binding independently; otherwise
          // a resumed card view keeps reading the old file forever.
          if (indexed.sessionDir) {
            const indexedWire = path.join(indexed.sessionDir, 'agents', 'main', 'wire.jsonl');
            const staleBinding = !meta.kimiSessionDir
              || path.resolve(meta.kimiSessionDir) !== path.resolve(indexed.sessionDir)
              || !meta.transcriptPath
              || path.resolve(meta.transcriptPath) !== path.resolve(indexedWire);
            if (staleBinding) {
              logger.log(`[resume-session] kimi transcript reconciled via session_index: ${meta.transcriptPath || '(empty)'} -> ${indexedWire}`);
            }
            meta.kimiSessionDir = indexed.sessionDir;
            meta.transcriptPath = indexedWire;
            resumeTranscriptPath = indexedWire;
          }
        }
      } catch (error) {
        logger.warn('[resume-session] kimi index reconcile failed:', error && error.message);
      }
    }

    const safeResumeModel = sessionModelId(meta);
    const createdSession = sessionManager.createSession(meta.kind || 'claude', {
      id: meta.hubId,
      title: meta.title,
      cwd: (isGemini && meta.geminiProjectRoot) ? meta.geminiProjectRoot : meta.cwd,
      ...(meta.cwdFellBackFrom ? { cwdFellBackFrom: meta.cwdFellBackFrom } : {}),
      ...(meta.workspaceLabel ? { workspaceLabel: meta.workspaceLabel } : {}),
      meetingId: meta.meetingId || null,
      completionNotificationEnabled: meta.completionNotificationEnabled === true,
      model: safeResumeModel || undefined,
      ...(meta.effort ? { effort: meta.effort } : {}),
      ...(isLegacyDeepSeek ? { deepseekLegacyClaude: true } : {}),
      resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
      resumeTranscriptPath: resumeTranscriptPath || undefined,
      useContinue: isClaudeCliResumable && !meta.ccSessionId,
      useResume: isNativeResumeKind,
      codexResumePicker: codexMissingSid,
      codexSid: effectiveCodexSid,
      codexProfile: isCodexRuntime ? (meta.codexProfile || null) : null,
      // MCP 档位现在 Claude 家族也有（core/claude-mcp-profile.js），不能再只给
      // codex runtime 继承 —— 否则 resume 出来的 Claude 会话会从用户选的 Lean
      // 悄悄变回 Full，一次多起七个 MCP 进程。
      ...(meta.mcpProfile ? { mcpProfile: meta.mcpProfile } : {}),
      ...(meta.fastMode === false ? { fastMode: false } : {}),
      ...(meta.codexSpeedTier ? { codexSpeedTier: meta.codexSpeedTier } : {}),
      geminiChatId: isGemini ? (meta.geminiChatId || null) : null,
      ...(isGemini && meta.geminiProjectHash ? { geminiProjectHash: meta.geminiProjectHash } : {}),
      geminiProjectRoot: isGemini ? (meta.geminiProjectRoot || null) : null,
      ...(isKimi ? {
        kimiSid: meta.kimiSid || null,
        kimiSessionDir: meta.kimiSessionDir || null,
        kimiResumePicker: !meta.kimiSid,
      } : {}),
      userRenamed: !!meta.userRenamed,
      autoTitleGenerated: !meta.branchAutoTitlePending
        && (!!meta.autoTitleGenerated || isStableSessionTitle(meta.title, meta.kind)),
      ...(meta.branchSourceSessionId ? { branchSourceSessionId: meta.branchSourceSessionId } : {}),
      ...(Number.isInteger(Number(meta.branchIndex)) && Number(meta.branchIndex) > 0
        ? { branchIndex: Number(meta.branchIndex) }
        : {}),
      ...(typeof meta.branchAutoTitlePending === 'boolean'
        ? { branchAutoTitlePending: meta.branchAutoTitlePending }
        : {}),
      ...(meta.pinned ? { pinned: true } : {}),
      lastMessageTime: meta.lastMessageTime,
      lastOutputPreview: meta.lastOutputPreview,
      ...(typeof meta.contextPct === 'number' ? { contextPct: meta.contextPct } : {}),
      ...(typeof meta.contextUsed === 'number' ? { contextUsed: meta.contextUsed } : {}),
      ...(typeof meta.contextMax === 'number' ? { contextMax: meta.contextMax } : {}),
      ...(typeof meta.contextEffectiveMax === 'number'
        ? { contextEffectiveMax: meta.contextEffectiveMax }
        : {}),
      ...(typeof meta.contextEffectiveObservedAt === 'number'
        ? { contextEffectiveObservedAt: meta.contextEffectiveObservedAt }
        : {}),
      ...(meta.purpose ? { purpose: meta.purpose } : {}),
      ...(meta.researchSessionId ? { researchSessionId: meta.researchSessionId } : {}),
      ...(meta.chuxinTaskId ? { chuxinTaskId: meta.chuxinTaskId } : {}),
      ...(Array.isArray(meta.heroIds) ? { heroIds: meta.heroIds } : {}),
      ...(meta.promptPolicyVersion ? { promptPolicyVersion: meta.promptPolicyVersion } : {}),
      ...(meta.hiddenFromSidebar ? { hiddenFromSidebar: true } : {}),
      ...resumeOpts,
    });
    registerSessionForTap(createdSession);
    // CodexTap can synchronously discover and publish a persisted rollout
    // while registerSessionForTap is still on the stack. Always send/return the
    // authoritative SessionManager copy so that freshly repaired SID/path/root
    // metadata is not overwritten by the stale createSession return value.
    const session = sessionManager.getSession(createdSession.id) || createdSession;
    sendToRenderer('session-created', { session });

    const needsLevel3 = (
      (isCodexRuntime && !effectiveCodexSid) ||
      (isGemini && !meta.geminiChatId)
    );

    if (needsLevel3) {
      let sourcePath = null;
      if (isGemini && meta.geminiProjectHash && meta.geminiChatId) {
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
