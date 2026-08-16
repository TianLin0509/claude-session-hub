'use strict';

const { isUsableCodexRolloutPath } = require('../../core/codex-transcript-parser.js');
const { isKimiCliKind: defaultIsKimiCliKind } = require('../../core/ai-kinds.js');
const { parseKimiWireToTurns: defaultParseKimiWireToTurns } = require('../../core/kimi-transcript-parser.js');

function defaultDefer() {
  return new Promise(resolve => setImmediate(resolve));
}

async function runTranscriptParser(deps, kind, transcriptPath, parseOpts, fallbackParser) {
  if (deps.transcriptParserService && typeof deps.transcriptParserService.parse === 'function') {
    return deps.transcriptParserService.parse(kind, transcriptPath, parseOpts);
  }
  const turns = await fallbackParser(transcriptPath, parseOpts);
  return { turns: Array.isArray(turns) ? turns : [], meta: {} };
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
  const validateCodexRolloutPath = typeof deps.isUsableCodexRolloutPath === 'function'
    ? deps.isUsableCodexRolloutPath
    : isUsableCodexRolloutPath;
  const isKimiCliKind = typeof deps.isKimiCliKind === 'function' ? deps.isKimiCliKind : defaultIsKimiCliKind;
  const parseKimiWireToTurns = typeof deps.parseKimiWireToTurns === 'function'
    ? deps.parseKimiWireToTurns
    : defaultParseKimiWireToTurns;

  await defer();

  const { hubSessionId, ccSessionId, transcriptPath: inPath, kind: inKind, opts } = args || {};
  let transcriptPath = null;
  try {
    const session = hubSessionId ? sessionManager.getSession(hubSessionId) : null;
    const kind = session ? session.kind : inKind;
    // Public kind stays `deepseek` across the migration. A persisted Claude id
    // without a Codex id is the unambiguous marker for a pre-migration session;
    // it must keep using the Claude parser even when the live session is absent.
    const effectiveCcSessionId = (session && session.ccSessionId) || ccSessionId || null;
    const isLegacyDeepSeek = /^deepseek(?:-resume)?$/.test(String(kind || ''))
      && !!effectiveCcSessionId
      && !(session && session.codexSid);
    const runtimeKind = (session && session.transcriptKind)
      || (isLegacyDeepSeek ? 'deepseek-legacy' : kind);

    if (isCodexCliKind(runtimeKind)) {
      const liveRolloutPath = hubSessionId ? transcriptTap.getCodexRolloutPath(hubSessionId) : null;
      const expectedCodexSid = session && session.codexSid ? session.codexSid : null;
      if (liveRolloutPath && validateCodexRolloutPath(liveRolloutPath, expectedCodexSid)) {
        transcriptPath = liveRolloutPath;
      }
      if (!transcriptPath && session && session.transcriptPath
        && validateCodexRolloutPath(session.transcriptPath, expectedCodexSid)) {
        transcriptPath = session.transcriptPath;
      }
      if (!transcriptPath && inPath && validateCodexRolloutPath(inPath, expectedCodexSid)) {
        transcriptPath = inPath;
      }
      if (!transcriptPath && session && session.codexSid) {
        const bySid = findCodexRolloutBySid(
          session.codexSid,
          session.codexSessionsRoot || defaultCodexSessionsRoot,
        );
        if (bySid && validateCodexRolloutPath(bySid, session.codexSid)) transcriptPath = bySid;
      }
      if (!transcriptPath && session && session.codexAllowMtimeFallback && session.cwd) {
        const byCwd = findCodexRolloutByCwd(
          session.cwd,
          session.codexSessionsRoot || defaultCodexSessionsRoot,
          { sinceMs: session.createdAt || Date.now() },
        );
        if (byCwd && validateCodexRolloutPath(byCwd)) transcriptPath = byCwd;
      }
      if (!transcriptPath) {
        return { turns: [], transcriptPath: null, error: 'codex rollout not found' };
      }
      if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
        updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
      }
      const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
      const parsed = await runTranscriptParser(deps, 'codex', transcriptPath, parseOpts, parseCodexRolloutToTurns);
      return {
        turns: parsed.turns,
        transcriptPath,
        parseMs: parsed.meta.parseMs,
        parseCacheHit: !!parsed.meta.cacheHit,
        error: null,
      };
    }

    if (isKimiCliKind(runtimeKind)) {
      transcriptPath = (session && session.transcriptPath) || inPath || null;
      if (!transcriptPath && session && session.kimiSessionDir) {
        transcriptPath = require('path').join(session.kimiSessionDir, 'agents', 'main', 'wire.jsonl');
      }
      if (!transcriptPath) {
        return { turns: [], transcriptPath: null, error: 'kimi wire transcript not found' };
      }
      if (hubSessionId && session && session.transcriptPath !== transcriptPath) {
        updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
      }
      const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
      const parsed = await runTranscriptParser(deps, 'kimi', transcriptPath, parseOpts, parseKimiWireToTurns);
      return {
        turns: parsed.turns,
        transcriptPath,
        parseMs: parsed.meta.parseMs,
        parseCacheHit: !!parsed.meta.cacheHit,
        error: null,
      };
    }

    transcriptPath = session && session.transcriptPath ? session.transcriptPath : null;
    if (!transcriptPath && inPath) {
      transcriptPath = inPath;
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
    const parsed = await runTranscriptParser(deps, 'claude', transcriptPath, parseOpts, parseClaudeTranscriptToTurns);
    return {
      turns: parsed.turns,
      transcriptPath,
      parseMs: typeof parsed.meta.parseMs === 'number' ? parsed.meta.parseMs : Date.now() - parseStartedAt,
      parseCacheHit: !!parsed.meta.cacheHit,
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
  runTranscriptParser,
};
