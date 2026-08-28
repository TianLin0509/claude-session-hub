'use strict';

const { isUsableCodexRolloutPath, readCodexRolloutMeta } = require('../../core/codex-transcript-parser.js');
const { isKimiCliKind: defaultIsKimiCliKind } = require('../../core/ai-kinds.js');
const { parseKimiWireToTurns: defaultParseKimiWireToTurns } = require('../../core/kimi-transcript-parser.js');
const {
  MAX_BRANCH_DEPTH,
  applyTailLimit,
  mergeInheritedTurns,
  resolveForkTimestamp,
} = require('../../core/branch-transcript-inheritance.js');

// 增量刷新（turn-complete 回填）用 limit:1 只取最新一条回答，合并前置历史后再切尾
// 结果完全一样，白搭一次父 transcript 解析。除此之外的窗口都照常继承。
const BRANCH_INHERITANCE_MIN_LIMIT = 2;

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

// 分支会话的祖先记录既可能是活会话，也可能只剩落盘记录（休眠 / Hub 重启后）。
function lookupSessionRecord(sessionId, deps) {
  const id = String(sessionId || '');
  if (!id) return null;
  const live = deps.sessionManager && typeof deps.sessionManager.getSession === 'function'
    ? deps.sessionManager.getSession(id)
    : null;
  if (live) return { record: live, live: true };
  const persisted = typeof deps.getPersistedSessions === 'function' ? deps.getPersistedSessions() : [];
  const found = (Array.isArray(persisted) ? persisted : []).find(item => item && item.hubId === id);
  return found ? { record: found, live: false } : null;
}

// Codex 的 rollout 头里写着 fork 时刻（session_meta.timestamp），比任何推断都准。
function codexProviderForkAt(session, transcriptPath) {
  if (!transcriptPath || !session || !session.codexSid) return 0;
  try {
    const meta = readCodexRolloutMeta(transcriptPath);
    if (!meta || !meta.forked_from_id) return 0;
    const at = Date.parse(meta.timestamp || '');
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * 给分支会话补上分支之前的对话。
 *
 * 为什么必须补：`codex fork <sid>` 的新 rollout **一条父历史都不写**（2026-08-28 对
 * 4 个真实 fork 文件实测：首个 task_started 之前的 response_item/message 全是 0 条），
 * 于是卡片视图从分支那一刻开始，之前的内容彻底看不到。Claude 的 `--fork-session`
 * 会整份复制，跑同一条路径也安全 —— 签名去重会把重复的部分全滤掉。
 */
async function withInheritedBranchTurns(args, deps, liveSession, childTurns, parseOpts, transcriptPath) {
  const depth = Number(args && args.__branchDepth) || 0;
  if (depth >= MAX_BRANCH_DEPTH) return childTurns;
  const limit = Number(parseOpts && parseOpts.limit);
  if (Number.isFinite(limit) && limit < BRANCH_INHERITANCE_MIN_LIMIT) return childTurns;

  // 休眠 / Hub 重启后的分支会话拿不到活对象，branchSourceSessionId 只在落盘记录里。
  const session = liveSession
    || (args && args.hubSessionId ? (lookupSessionRecord(args.hubSessionId, deps) || {}).record : null);
  const parentId = session && session.branchSourceSessionId;
  if (!parentId) return childTurns;

  const parent = lookupSessionRecord(parentId, deps);
  if (!parent) return childTurns;

  const parentResult = await parseSessionTranscript({
    // hubSessionId 一定要带上：祖先自己也可能是分支，而它若已休眠，
    // branchSourceSessionId 只能靠这个 id 从落盘记录里查回来，否则多级分支链
    // 只继承得到一层。祖先不活时 parseSessionTranscript 会自动落到下面这几个
    // 显式字段上（Codex 侧此时只校验「是不是一份可用的顶层 rollout」）。
    hubSessionId: parentId,
    ccSessionId: parent.record.ccSessionId || null,
    transcriptPath: parent.record.transcriptPath || null,
    kind: parent.record.kind || null,
    opts: { ...parseOpts, fromTail: true },
    __branchDepth: depth + 1,
  }, deps);

  const parentTurns = parentResult && Array.isArray(parentResult.turns) ? parentResult.turns : [];
  if (!parentTurns.length) return childTurns;

  const forkAt = resolveForkTimestamp({
    session,
    childTurns,
    providerForkAt: codexProviderForkAt(session, transcriptPath),
  });
  const merged = mergeInheritedTurns(parentTurns, childTurns, { forkAt, sourceSessionId: parentId });
  // 合并后重新收口到调用方要的窗口，否则一条长父会话会把 limit 翻倍。
  return applyTailLimit(merged, limit, parseOpts && parseOpts.fromTail);
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
        turns: await withInheritedBranchTurns(args, deps, session, parsed.turns, parseOpts, transcriptPath),
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
        turns: await withInheritedBranchTurns(args, deps, session, parsed.turns, parseOpts, transcriptPath),
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
      turns: await withInheritedBranchTurns(args, deps, session, parsed.turns, parseOpts, transcriptPath),
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
