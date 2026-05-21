'use strict';

function defaultDefer() {
  return new Promise(resolve => setImmediate(resolve));
}

async function parseSessionTranscript(args = {}, deps) {
  const {
    defaultCodexSessionsRoot,
    defer = defaultDefer,
    findCodexRolloutByCwd,
    findCodexRolloutBySid,
    findTranscriptByCCSessionId,
    isCodexCliKind,
    parseClaudeTranscriptToTurns,
    parseCodexRolloutToTurns,
    sessionManager,
    transcriptTap,
    updateSessionTranscriptBinding,
  } = deps;

  await defer();

  const { hubSessionId, ccSessionId, transcriptPath: inPath, kind: inKind, opts } = args || {};
  let transcriptPath = inPath || null;
  try {
    const session = hubSessionId ? sessionManager.getSession(hubSessionId) : null;
    const kind = session ? session.kind : inKind;

    if (isCodexCliKind(kind)) {
      const liveRolloutPath = hubSessionId ? transcriptTap.getCodexRolloutPath(hubSessionId) : null;
      if (liveRolloutPath) {
        transcriptPath = liveRolloutPath;
      }
      if (!transcriptPath && session && session.transcriptPath) {
        transcriptPath = session.transcriptPath;
      }
      if (!transcriptPath && session && session.codexSid) {
        transcriptPath = findCodexRolloutBySid(
          session.codexSid,
          session.codexSessionsRoot || defaultCodexSessionsRoot,
        );
      }
      if (!transcriptPath && session && session.codexAllowMtimeFallback && session.cwd) {
        transcriptPath = findCodexRolloutByCwd(
          session.cwd,
          session.codexSessionsRoot || defaultCodexSessionsRoot,
          { sinceMs: session.createdAt || Date.now() },
        );
      }
      if (!transcriptPath) {
        return { turns: [], transcriptPath: null, error: 'codex rollout not found' };
      }
      if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
        updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
      }
      const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
      const turns = parseCodexRolloutToTurns(transcriptPath, parseOpts);
      return { turns: Array.isArray(turns) ? turns : [], transcriptPath, error: null };
    }

    if (kind === 'codex-app') {
      const extracted = hubSessionId ? await transcriptTap.extractLatestTurn(hubSessionId, 0) : null;
      if (!extracted || !extracted.text) {
        return { turns: [], transcriptPath: null, error: 'codex app-server transcript not materialized' };
      }
      return {
        turns: [{
          id: `codex-app-assistant-${hubSessionId || Date.now()}`,
          role: 'assistant',
          text: extracted.text,
          ts: Date.now(),
          tsEnd: Date.now(),
          stopReason: 'turn_completed',
          source: 'codex_app_server',
        }],
        transcriptPath: null,
        error: null,
      };
    }

    if (!transcriptPath && session && session.transcriptPath) {
      transcriptPath = session.transcriptPath;
    }
    if (!transcriptPath && ccSessionId) {
      transcriptPath = findTranscriptByCCSessionId(ccSessionId);
    }
    if (!transcriptPath && hubSessionId) {
      if (session && session.ccSessionId) {
        transcriptPath = findTranscriptByCCSessionId(session.ccSessionId);
      }
    }
    if (!transcriptPath) {
      return { turns: [], transcriptPath: null, error: 'transcript not found' };
    }
    if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
      updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
    }
    const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
    const parseStartedAt = Date.now();
    const turns = await parseClaudeTranscriptToTurns(transcriptPath, parseOpts);
    return {
      turns: Array.isArray(turns) ? turns : [],
      transcriptPath,
      parseMs: Date.now() - parseStartedAt,
      error: null,
    };
  } catch (err) {
    return { turns: [], transcriptPath, error: err && err.message ? err.message : String(err) };
  }
}

function registerTranscriptIpc(ipcMain, deps) {
  const {
    transcriptTap,
  } = deps;

  ipcMain.handle('get-last-assistant-text', (_e, sessionId) => {
    return transcriptTap.getLastAssistantText(sessionId);
  });

  ipcMain.handle('parse-session-transcript', async (_e, args = {}) => {
    return parseSessionTranscript(args, deps);
  });
}

module.exports = {
  parseSessionTranscript,
  registerTranscriptIpc,
};
