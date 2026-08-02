'use strict';

const fs = require('fs');
const {
  formatBranchSessionTitle,
  isGenericAutoSessionTitle,
  isStableSessionTitle,
  normalizeTitle,
  stripBranchTitlePrefix,
} = require('./session-title-guards');

const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CODEX_META_LINE_BYTES = 1024 * 1024;

function meaningfulSourceTitle(value) {
  const clean = stripBranchTitlePrefix(normalizeTitle(value));
  if (!clean || clean === '待命名') return '';
  if (isGenericAutoSessionTitle(clean) || !isStableSessionTitle(clean)) return '';
  return clean;
}

function resolveBranchSourceTitle({ rendererTitle, source, meeting } = {}) {
  return meaningfulSourceTitle(rendererTitle)
    || meaningfulSourceTitle(source && source.title)
    || meaningfulSourceTitle(meeting && meeting.title)
    || '';
}

function buildBranchSessionTitle({ rendererTitle, source, meeting } = {}) {
  const sourceTitle = resolveBranchSourceTitle({ rendererTitle, source, meeting });
  return {
    sourceTitle,
    title: formatBranchSessionTitle(sourceTitle || '待命名'),
    branchAutoTitlePending: !sourceTitle,
    autoTitleGenerated: !!sourceTitle,
  };
}

function readFirstLine(filePath, maxBytes = MAX_CODEX_META_LINE_BYTES) {
  if (!filePath || typeof filePath !== 'string') return '';
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const parts = [];
    let total = 0;
    let position = 0;
    while (total < maxBytes) {
      const size = Math.min(64 * 1024, maxBytes - total);
      const chunk = Buffer.allocUnsafe(size);
      const read = fs.readSync(fd, chunk, 0, size, position);
      if (read <= 0) break;
      position += read;
      const used = chunk.subarray(0, read);
      const newline = used.indexOf(0x0a);
      if (newline >= 0) {
        parts.push(used.subarray(0, newline));
        return Buffer.concat(parts).toString('utf8').trim();
      }
      parts.push(used);
      total += read;
    }
    return Buffer.concat(parts).toString('utf8').trim();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readCodexForkedFromId(transcriptPath) {
  const line = readFirstLine(transcriptPath);
  if (!line) return null;
  try {
    const event = JSON.parse(line);
    const parentId = event && event.type === 'session_meta'
      ? event.payload && event.payload.forked_from_id
      : null;
    return CODEX_SESSION_ID_RE.test(String(parentId || '')) ? String(parentId) : null;
  } catch {
    return null;
  }
}

function needsBranchTitleRecovery(session) {
  if (!session) return false;
  const clean = normalizeTitle(session.title);
  const isMarkedBranch = /^分支\s*[:：]\s*/u.test(clean) || !!session.branchSourceSessionId;
  if (!isMarkedBranch) return false;
  const base = stripBranchTitlePrefix(clean);
  // The legacy handler incorrectly set userRenamed=true on its generated
  // "分支: Codex 2" title. Preserve real manual names, but do not let that
  // stale flag protect a provider placeholder forever.
  if (session.userRenamed === true && meaningfulSourceTitle(base) && !session.branchAutoTitlePending) {
    return false;
  }
  return !meaningfulSourceTitle(base) || !!session.branchAutoTitlePending;
}

function healPersistedBranchSessionTitles(state, {
  sessionStore = null,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
  const meetings = Array.isArray(state && state.meetings) ? state.meetings : [];
  const byHubId = new Map(sessions.filter(Boolean).map(session => [session.hubId, session]));
  const byCodexSid = new Map(
    sessions.filter(session => session && session.codexSid).map(session => [session.codexSid, session]),
  );
  const meetingById = new Map(meetings.filter(Boolean).map(meeting => [meeting.id, meeting]));
  const changed = [];

  for (const session of sessions) {
    if (!needsBranchTitleRecovery(session)) continue;

    let source = session.branchSourceSessionId
      ? byHubId.get(session.branchSourceSessionId)
      : null;
    if (!source && session.codexSid && session.transcriptPath) {
      const parentCodexSid = readCodexForkedFromId(session.transcriptPath);
      if (parentCodexSid) source = byCodexSid.get(parentCodexSid) || null;
    }
    const meeting = source && source.meetingId ? meetingById.get(source.meetingId) : null;
    const resolved = buildBranchSessionTitle({ source, meeting });
    const nextSourceId = source && source.hubId ? source.hubId : session.branchSourceSessionId;
    const titleChanged = session.title !== resolved.title;
    const sourceChanged = !!nextSourceId && session.branchSourceSessionId !== nextSourceId;
    const flagsChanged = session.branchAutoTitlePending !== resolved.branchAutoTitlePending
      || session.autoTitleGenerated !== resolved.autoTitleGenerated
      || session.userRenamed === true;
    if (!titleChanged && !sourceChanged && !flagsChanged) continue;

    session.title = resolved.title;
    session.userRenamed = false;
    session.autoTitleGenerated = resolved.autoTitleGenerated;
    session.branchAutoTitlePending = resolved.branchAutoTitlePending;
    if (nextSourceId) session.branchSourceSessionId = nextSourceId;
    session.updatedAt = now();
    changed.push(session);
    if (sessionStore && typeof sessionStore.saveSessionFile === 'function' && session.hubId) {
      try { sessionStore.saveSessionFile(session.hubId, session); }
      catch (error) { logger.warn?.('[branch-title] per-session heal failed:', error.message); }
    }
  }

  return changed;
}

module.exports = {
  buildBranchSessionTitle,
  healPersistedBranchSessionTitles,
  meaningfulSourceTitle,
  readCodexForkedFromId,
  resolveBranchSourceTitle,
};
