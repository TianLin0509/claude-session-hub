'use strict';

const devProjectLocator = require('../../core/dev-project-locator.js');
const { ensureClaudeMemoryFile } = require('../../core/claude-memory-loader.js');
const { normalizeCodexContextWindow } = require('../../core/codex-context-window.js');

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CLAUDE_MCP_PROFILES = new Set(['full', 'lean', 'browser', 'wireless']);
const CODEX_MCP_PROFILES = new Set(['none', 'full', 'lean', 'browser', 'wireless']);
const CODEX_SPEED_TIERS = new Set(['standard', 'inherit', 'fast', 'flex']);

// Renderer 传来的 slot 会进入 PTY 命令构造。这里只放行与新建 Session 相同的
// provider-specific 字段，既不丢用户选择，也不把整份 renderer 对象盲传给 main。
function sanitizeMeetingSlot(slot = {}, fallbackIndex = null) {
  const kind = typeof slot.kind === 'string' ? slot.kind.trim() : '';
  const safe = {
    index: typeof slot.index === 'number' ? slot.index : fallbackIndex,
    kind,
  };
  const memberId = typeof slot.memberId === 'string' ? slot.memberId.trim() : '';
  if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(memberId)) safe.memberId = memberId;
  else if (Number.isInteger(fallbackIndex) && fallbackIndex >= 0) safe.memberId = `m${fallbackIndex + 1}`;
  if (typeof slot.model === 'string' && slot.model.trim()) safe.model = slot.model.trim();

  const effort = typeof slot.effort === 'string' ? slot.effort.trim().toLowerCase() : '';
  if (kind === 'claude' && CLAUDE_EFFORTS.has(effort)) safe.effort = effort;
  if ((kind === 'codex' || kind === 'deepseek') && CODEX_EFFORTS.has(effort)) safe.effort = effort;

  const mcpProfile = typeof slot.mcpProfile === 'string' ? slot.mcpProfile.trim().toLowerCase() : '';
  if (kind === 'claude' && CLAUDE_MCP_PROFILES.has(mcpProfile)) {
    safe.mcpProfile = mcpProfile;
  }
  if ((kind === 'codex' || kind === 'deepseek') && CODEX_MCP_PROFILES.has(mcpProfile)) {
    safe.mcpProfile = mcpProfile;
  }
  // 与普通新建 Session 一样，仅显式关闭时传 false；省略表示沿用默认开启。
  if (kind === 'claude' && slot.fastMode === false) safe.fastMode = false;

  const codexSpeedTier = typeof slot.codexSpeedTier === 'string'
    ? slot.codexSpeedTier.trim().toLowerCase()
    : '';
  if ((kind === 'codex' || kind === 'deepseek') && CODEX_SPEED_TIERS.has(codexSpeedTier)) {
    safe.codexSpeedTier = codexSpeedTier;
  }
  if (kind === 'codex') {
    const contextMax = normalizeCodexContextWindow(slot.contextMax);
    if (contextMax) safe.contextMax = contextMax;
  }
  return safe;
}

function sessionOptionsForMeetingSlot(slot, cwd) {
  const safe = sanitizeMeetingSlot(slot);
  const { index: _index, kind: _kind, memberId: _memberId, ...sessionOpts } = safe;
  return { ...sessionOpts, cwd };
}

function nextMeetingMemberId(slotSpecs) {
  const used = new Set((Array.isArray(slotSpecs) ? slotSpecs : [])
    .map(slot => slot && String(slot.memberId || ''))
    .filter(Boolean));
  let next = Math.max(0, ...[...used].map(value => {
    const match = /^m(\d+)$/.exec(value);
    return match ? Number(match[1]) : 0;
  })) + 1;
  while (used.has(`m${next}`)) next += 1;
  return `m${next}`;
}

function createMeetingSubAdder(deps) {
  const {
    fs,
    getHookPort,
    getHubDataDir,
    getMeetingWorkspaceDir,
    getSlotPromptName,
    groupchat,
    hookToken,
    ensureDeepSeekInstructionFile = ensureClaudeMemoryFile,
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
    workspaceService,
  } = deps;

  function addCodexMcpEntry(sessionOpts, entry) {
    if (!entry) return;
    sessionOpts.codexMcpEntries = [...(sessionOpts.codexMcpEntries || []), entry];
  }

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

    if (meeting && meeting.groupChat && sessionOpts.noInheritCursor === undefined) {
      // Headless/background group-chat members often have no renderer xterm
      // attached. With inherited cursor enabled, Windows ConPTY can stop
      // delivering Claude-family TUI output; Codex already forces this off in
      // session-manager. Apply the same safety to every group member.
      sessionOpts.noInheritCursor = true;
    }

    if (!sessionOpts.cwd && meeting && meeting.workspace) {
      // 2026-09-08：界面上配的工作目录可能已经不存在了（项目被搬走、worktree 被清掉）。
      // 原来直接拿它当 cwd —— CLI 在启动前就失败，报一个跟任务毫无关系的错。
      // 现在退到一个确实存在的目录（最近的存在祖先），让它至少能起来做只读定位；
      // prompt 里那段「先核实项目现场」会明说这只是落脚点、确认之前别在这写文件。
      const resolved = devProjectLocator.resolveLaunchDir(meeting.workspace, null);
      // 找不到更好的落脚点（连一个像样的存在祖先都没有）就保持原样 ——
      // 这时候换成盘符根或用户主目录只会更糟，行为也不该和以前不一样。
      sessionOpts.cwd = resolved.dir || meeting.workspace;
      if (resolved.dir && resolved.corrected) {
        logger.warn(`[meeting-sub] 工作目录 ${meeting.workspace} 不存在，本次退到 ${resolved.dir} 起会话（只读定位）`);
      }
    }
    if (!sessionOpts.cwd) {
      let workspaceDir = null;
      if (isIsolatedHub()) {
        workspaceDir = getMeetingWorkspaceDir(meetingId);
      } else if (meeting) {
        // 群聊 cwd 统一到主工作台，让 AI 原生 auto-memory 写到主项目目录
        // 下次群聊启动时联邦索引脚本能自动捞起新记忆，形成闭环
        workspaceDir = process.env.USERPROFILE || process.env.HOME || '.';
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

    // DeepSeek 已迁移到 Codex runtime；原来通过 Claude
    // --append-system-prompt-file 注入的主 MEMORY.md 改走 Codex instruction file。
    if (meeting && meeting.groupChat && kind === 'deepseek' && !sessionOpts.codexInstructionFile) {
      try {
        const hubDataDir = getHubDataDir();
        const injectPath = ensureDeepSeekInstructionFile(hubDataDir);
        if (injectPath) {
          sessionOpts.codexInstructionFile = injectPath;
        }
      } catch (err) {
        logger.warn(`[meeting-sub] claude-memory injection failed for ${meetingId}: ${err.message}`);
      }
    }

    const hookPort = getHookPort();
    const codexMcpEnabled = sessionOpts.mcpProfile !== 'none';
    if (meeting && meeting.groupChat && isCodexBaseKind(kind) && codexMcpEnabled && scenes.buildAiTeamMcpEntryForCodex) {
      addCodexMcpEntry(sessionOpts, scenes.buildAiTeamMcpEntryForCodex(meetingId, kind));
    }

    const needsResearchMcp = meeting && meeting.groupChat && meeting.scene === 'research';
    if (needsResearchMcp && hookPort) {
      const hubDataDir = getHubDataDir();
      if (isClaudeFamily(kind)) {
        sessionOpts.mcpConfigFile = scenes.writeResearchMcpConfig(
          hubDataDir, meetingId, hookPort, hookToken, kind, { enableChuxin: true },
        );
      } else if (kind === 'gemini') {
        sessionOpts.extraEnv = {
          ...(sessionOpts.extraEnv || {}),
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: hookToken,
          ARENA_AI_KIND: 'gemini',
          ARENA_HUB_DATA_DIR: hubDataDir,
          ARENA_CHUXIN_ENABLED: '1',
          SPIRIT_REGISTRY_ROOT: process.env.SPIRIT_REGISTRY_ROOT || path.join(require('os').homedir(), 'spirit-lens-registry'),
        };
      } else if (isCodexBaseKind(kind) && codexMcpEnabled) {
        sessionOpts.codexBypassApprovals = true;
        addCodexMcpEntry(sessionOpts, scenes.buildResearchMcpEntryForCodex(
          meetingId, hookPort, hookToken, hubDataDir, { enableChuxin: true },
        ));
      }
    } else if (needsResearchMcp && !hookPort) {
      logger.warn('[群聊] ' + meeting.scene + ' scene in meeting ' + meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
    }

    // Dev seats hold identity without an engine until they are given work. Both
    // native backends support it, so a Claude seat does not spawn a process the
    // room may never use.
    if (meeting?.groupChat && (meeting.mode === 'dev' || meeting.scene === 'dev')
        && ['codex', 'codex-resume', 'claude', 'claude-resume'].includes(kind)) sessionOpts.lazyStart = true;
    const session = sessionManager.createSession(kind, sessionOpts);
    if (!session) return null;
    const updated = meetingManager.addSubSession(meetingId, session.id);
    if (!updated) {
      sessionManager.closeSession(session.id);
      return null;
    }

    if (meeting && meeting.groupChat) {
      const addedIndex = updated.subSessions.indexOf(session.id);
      if (Array.isArray(updated.participants) && addedIndex >= 0) {
        const validParticipants = updated.participants.filter(index =>
          Number.isInteger(index) && index >= 0 && index < updated.subSessions.length
        );
        if (!validParticipants.includes(addedIndex)) validParticipants.push(addedIndex);
        meetingManager.setParticipants(meetingId, [...new Set(validParticipants)].sort((a, b) => a - b));
      }
      if (addedIndex >= 0 && typeof meetingManager.setSlotSpecs === 'function') {
        const latest = meetingManager.getMeeting(meetingId) || updated;
        const slotSpecs = Array.isArray(latest.slotSpecs) ? latest.slotSpecs.slice() : [];
        while (slotSpecs.length < addedIndex) slotSpecs.push(null);
        const currentModel = session.currentModel && typeof session.currentModel === 'object'
          ? session.currentModel.id
          : session.currentModel;
        slotSpecs[addedIndex] = sanitizeMeetingSlot({
          memberId: opts.memberId || nextMeetingMemberId(slotSpecs),
          kind,
          model: opts.model || currentModel || null,
          effort: opts.effort,
          mcpProfile: opts.mcpProfile,
          fastMode: opts.fastMode,
          codexSpeedTier: opts.codexSpeedTier,
          contextMax: opts.contextMax,
        });
        delete slotSpecs[addedIndex].index;
        meetingManager.setSlotSpecs(meetingId, slotSpecs);
      }
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
    workspaceService,
  } = deps;
  const addMeetingSubInternal = createMeetingSubAdder(deps);

  ipcMain.handle('create-meeting', async (_e, opts) => {
    const safe = { ...(opts || {}) };
    safe.groupChat = true;
    const devSlots = Array.isArray(safe.slots) ? safe.slots : safe.slotSpecs;
    if (safe.serialWorkflow?.soloDevelopment || safe.serialWorkflow?.templateId === 'dev-task-solo'
      || (safe.mode === 'dev' && (!Array.isArray(devSlots) || devSlots.length < 2))) {
      throw new Error('开发群聊至少需要两位成员；单人开发请使用普通会话的“一键开工”。');
    }
    const hasCustomTitle = typeof safe.title === 'string' && safe.title.trim().length > 0;
    safe.autoTitlePending = !hasCustomTitle;
    safe.userRenamed = hasCustomTitle;
    if (workspaceService) {
      const workspaceMeta = {
        label: hasCustomTitle ? safe.title.trim() : '未命名群聊',
        select: false,
      };
      if (typeof safe.workspaceDraft === 'boolean') workspaceMeta.draft = safe.workspaceDraft;
      const workspace = workspaceService.resolveForSession(safe.workspace, workspaceMeta);
      safe.workspace = workspace.path;
      safe.workspaceLabel = workspace.label;
    }
    if (Array.isArray(safe.slots) && safe.slots.length > 0) {
      safe.slots = safe.slots.map((slot, index) => sanitizeMeetingSlot(slot, index));
      safe.slotSpecs = safe.slots.map(slot => ({ ...slot }));
      if (safe.groupChat && safe.mode !== 'dev' && !Array.isArray(safe.participants)) {
        safe.participants = safe.slots.map((_, i) => i);
      }
    }
    // Initialization only: adding each session below otherwise selects every new member.
    // Existing rooms and later add-meeting-sub calls keep their own selection behavior.
    const devParticipants = safe.mode === 'dev'
      ? (Array.isArray(safe.participants) ? safe.participants.slice() : [safe.slotSpecs?.[0]?.index ?? 0])
      : null;
    if (devParticipants) safe.participants = devParticipants.slice();
    const meeting = meetingManager.createMeeting(safe);

    if (Array.isArray(safe.slots) && safe.slots.length > 0) {
      const errors = [];
      for (const slot of safe.slots) {
        try {
          await addMeetingSubInternal(
            meeting.id,
            slot.kind,
            sessionOptionsForMeetingSlot(slot, safe.workspace),
          );
        } catch (err) {
          errors.push({ slot, message: err && err.message || String(err) });
          logger.warn('[create-meeting] add-sub failed for slot', slot, err && err.message);
        }
      }
      if (devParticipants) meetingManager.setParticipants(meeting.id, devParticipants.slice());
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
  sanitizeMeetingSlot,
  sessionOptionsForMeetingSlot,
  nextMeetingMemberId,
};
