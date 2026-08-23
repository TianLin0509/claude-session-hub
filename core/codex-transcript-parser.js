/**
 * Parse Codex CLI rollout JSONL files into the same normalized turn shape used
 * by the card view renderer.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { isSyntheticUserEntry, isSyntheticUserText, displayUserText } = require('./synthetic-user-filter.js');
const {
  codexAgentMessageEventFromRecord,
  codexUserMessageEventFromRecord,
} = require('./transcript-payload-utils.js');

const DEFAULT_CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_TAIL_WINDOW_INITIAL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TARGETED_DATE_DIRS = 7;

function normalizePathForCompare(p) {
  if (!p) return '';
  try { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
  catch { return String(p).replace(/\\/g, '/').toLowerCase(); }
}

function codexDateDir(sessionsRoot, atMs) {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) return null;
  return path.join(
    sessionsRoot,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function codexDateDirsForRange(sessionsRoot, startMs, endMs, paddingDays = 1) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const start = new Date(Math.min(startMs, endMs) - paddingDays * DAY_MS);
  const end = new Date(Math.max(startMs, endMs) + paddingDays * DAY_MS);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  const count = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (count < 1 || count > MAX_TARGETED_DATE_DIRS) return [];
  const dirs = [];
  for (let at = start.getTime(); at <= end.getTime(); at += DAY_MS) {
    const dir = codexDateDir(sessionsRoot, at);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

function uuidV7Timestamp(uuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(uuid || ''))) {
    return null;
  }
  const timestamp = Number.parseInt(String(uuid).replace(/-/g, '').slice(0, 12), 16);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readFirstLineSync(filePath, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < maxBytes) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, maxBytes - total), total);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl));
        break;
      }
      chunks.push(Buffer.from(slice));
      total += n;
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readCodexRolloutMeta(filePath) {
  const first = readFirstLineSync(filePath);
  if (!first) return null;
  try {
    const record = JSON.parse(first);
    if (record?.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') return null;
    return record.payload;
  } catch {
    return null;
  }
}

function isCodexSubagentRolloutMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (String(meta.thread_source || '').toLowerCase() === 'subagent') return true;
  if (meta.agent_path) return true;
  return !!(meta.source && typeof meta.source === 'object' && meta.source.subagent);
}

function isCodexTopLevelRolloutMeta(meta) {
  return !!meta && !isCodexSubagentRolloutMeta(meta);
}

function codexRolloutMetaMatchesSid(meta, codexSid) {
  if (!meta || !codexSid) return false;
  const expected = String(codexSid);
  return String(meta.id || '') === expected || String(meta.session_id || '') === expected;
}

function isUsableCodexRolloutPath(filePath, codexSid = null) {
  const meta = readCodexRolloutMeta(filePath);
  if (!isCodexTopLevelRolloutMeta(meta)) return false;
  return !codexSid || codexRolloutMetaMatchesSid(meta, codexSid);
}

function isCodexSubagentRolloutPath(filePath) {
  return isCodexSubagentRolloutMeta(readCodexRolloutMeta(filePath));
}

function toMs(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return textFromContent(content.content);
  }
  return '';
}

function textFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return (
    textFromContent(payload.message) ||
    textFromContent(payload.text) ||
    textFromContent(payload.content) ||
    textFromContent(payload.input) ||
    textFromContent(payload.prompt)
  );
}

function _recordId(obj) {
  const payload = obj && obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  const candidates = [
    obj && obj.id,
    payload && payload.id,
    payload && payload.item && payload.item.id,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function _stableRecordHash(obj) {
  // Card rendering de-duplicates by turn.id. A tail-window parse starts line
  // numbering at zero, so line indexes are not stable as a growing rollout's
  // 8 MB window moves. Hash semantic record data instead; identical records
  // now keep the same id in full, tail and later incremental parses.
  const payload = obj && obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  const raw = JSON.stringify([
    obj && obj.timestamp ? String(obj.timestamp) : '',
    obj && obj.type ? String(obj.type) : '',
    payload && payload.type ? String(payload.type) : '',
    payload && payload.item && payload.item.type ? String(payload.item.type) : '',
    payload && payload.item && payload.item.phase ? String(payload.item.phase) : '',
    payload && payload.turn_id ? String(payload.turn_id) : '',
    payload && payload.internal_chat_message_metadata_passthrough
      ? String(payload.internal_chat_message_metadata_passthrough.turn_id || '')
      : '',
    textFromPayload(payload),
    payload ? textFromContent(payload.last_agent_message) : '',
  ]);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function _makeTurnId(prefix, obj, index) {
  // A Codex turn_id can intentionally span multiple user steering messages
  // and multiple assistant commentary segments. It is therefore not a card
  // id. Prefer record-level ids; otherwise use timestamp + semantic hash.
  const recordId = _recordId(obj);
  if (recordId) return `${prefix}-${recordId}`;
  const ts = obj && obj.timestamp ? String(obj.timestamp) : 'no-ts';
  const hash = obj ? _stableRecordHash(obj) : `line-${index}`;
  return `${prefix}-${ts}-${hash}`;
}

function isInjectedContextText(text) {
  return isSyntheticUserText(text);
}

function hasNearbyEventUserDuplicate(entries, entryIndex, text) {
  const normalized = normalizeUserDuplicateText(text);
  if (!normalized) return false;
  const maxLookahead = Math.min(entries.length, entryIndex + 6);
  for (let i = entryIndex + 1; i < maxLookahead; i++) {
    const obj = entries[i] && entries[i].obj;
    const userEvent = codexUserMessageEventFromRecord(obj);
    if (!userEvent) continue;
    if (normalizeUserDuplicateText(userEvent.text) === normalized) return true;
  }
  return false;
}

function normalizeUserDuplicateText(text) {
  return String(text || '')
    .replace(/<image\b[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readCodexTailWindowText(jsonlPath, maxBytes) {
  let stat;
  try { stat = fs.statSync(jsonlPath); } catch { return ''; }
  const size = stat.size || 0;
  if (size <= maxBytes) return fs.readFileSync(jsonlPath, 'utf8');

  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseCodexRolloutText(raw) {
  const lines = raw.split(/\r?\n/);
  const entries = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') entries.push({ obj, index });
    } catch {}
  });
  const turns = [];
  let pendingAssistant = null;

  const ensurePendingAssistant = () => {
    if (!pendingAssistant) {
      pendingAssistant = {
        id: null,
        ts: null,
        tsEnd: null,
        text: '',
        finalText: '',
        durationMs: null,
        agentMessages: [],
      };
    }
    return pendingAssistant;
  };

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    const text = (pendingAssistant.finalText || pendingAssistant.agentMessages.join('\n\n') || '').trim();
    if (text) {
      turns.push({
        id: pendingAssistant.id || `codex-assistant-${turns.length}`,
        role: 'assistant',
        text,
        ts: pendingAssistant.ts,
        tsEnd: pendingAssistant.tsEnd || pendingAssistant.ts,
        stopReason: pendingAssistant.finalText ? 'task_complete' : 'partial_commentary',
        durationMs: pendingAssistant.durationMs || undefined,
        source: pendingAssistant.finalText ? 'codex_rollout' : 'codex_rollout_streaming',
      });
    }
    pendingAssistant = null;
  };

  entries.forEach(({ obj, index }, entryIndex) => {
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      const eventType = payload.type;
      const userEvent = codexUserMessageEventFromRecord(obj);
      if (userEvent) {
        flushAssistant();
        const raw = userEvent.text.trim();
        const text = raw && !isSyntheticUserEntry(obj, raw) ? displayUserText(raw) : null;
        if (text) {
          turns.push({
            id: _makeTurnId('codex-user', obj, index),
            role: 'user',
            text,
            ts: userEvent.submittedAt || toMs(obj.timestamp),
          });
        }
        return;
      }
      if (eventType === 'task_started') {
        if (pendingAssistant && (pendingAssistant.finalText || pendingAssistant.agentMessages.length)) {
          flushAssistant();
        }
        const pending = ensurePendingAssistant();
        pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
        pending.ts = pending.ts || toMs(obj.timestamp);
        return;
      }
      const agentEvent = codexAgentMessageEventFromRecord(obj);
      if (agentEvent) {
        const pending = ensurePendingAssistant();
        pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
        pending.ts = pending.ts || toMs(obj.timestamp);
        pending.tsEnd = agentEvent.completedAt || toMs(obj.timestamp);
        if (agentEvent.completed) pending.finalText = agentEvent.text;
        else pending.agentMessages.push(agentEvent.text);
        if (Number.isFinite(agentEvent.durationMs)) pending.durationMs = agentEvent.durationMs;
        return;
      }
    }

    if (obj.type === 'response_item' && obj.payload && obj.payload.role === 'user') {
      const raw = textFromPayload(obj.payload).trim();
      // 群聊里 Hub 发给成员的是一整段脚手架，用户真正打的字在 `## 用户` 段里，
      // 只显示那一段（displayUserText 同时兜住纯系统注入）。
      const text = raw && !isSyntheticUserEntry(obj, raw) ? displayUserText(raw) : null;
      if (text && !hasNearbyEventUserDuplicate(entries, entryIndex, text)) {
        flushAssistant();
        turns.push({
          id: _makeTurnId('codex-user', obj, index),
          role: 'user',
          text,
          ts: toMs(obj.timestamp),
        });
      }
    }
  });

  flushAssistant();
  return turns;
}

function applyTurnLimit(turns, limit, fromTail) {
  if (typeof limit === 'number' && limit < turns.length) {
    return fromTail ? turns.slice(turns.length - limit) : turns.slice(0, limit);
  }
  return turns;
}

function parseCodexRolloutToTurns(jsonlPath, opts = {}) {
  const { limit, fromTail = false } = opts;
  if (typeof limit === 'number' && limit <= 0) return [];

  const shouldTailRead = fromTail && typeof limit === 'number';
  if (!shouldTailRead) {
    const turns = parseCodexRolloutText(fs.readFileSync(jsonlPath, 'utf8'));
    return applyTurnLimit(turns, limit, fromTail);
  }

  let stat;
  try { stat = fs.statSync(jsonlPath); } catch { stat = null; }
  if (!stat || stat.size <= CODEX_TAIL_WINDOW_INITIAL_BYTES) {
    const turns = parseCodexRolloutText(fs.readFileSync(jsonlPath, 'utf8'));
    return applyTurnLimit(turns, limit, fromTail);
  }

  // Avoid reparsing overlapping 8 -> 16 -> 32 MB windows.  Try the bounded
  // tail once, then fall through to exactly one full read when strict history
  // completeness requires older turns.
  const tailTurns = parseCodexRolloutText(readCodexTailWindowText(jsonlPath, CODEX_TAIL_WINDOW_INITIAL_BYTES));
  if (tailTurns.length >= limit) return applyTurnLimit(tailTurns, limit, fromTail);

  const turns = parseCodexRolloutText(fs.readFileSync(jsonlPath, 'utf8'));
  return applyTurnLimit(turns, limit, fromTail);
}

function findCodexRolloutBySid(codexSid, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT) {
  if (!codexSid || !sessionsRoot) return null;
  const suffix = `-${codexSid}.jsonl`;
  let best = null;
  const visit = (dir, depth, maxDepth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full, depth + 1, maxDepth);
      } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith(suffix)) {
        if (!isUsableCodexRolloutPath(full, codexSid)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      }
    }
  };
  const sidTimestamp = uuidV7Timestamp(codexSid);
  if (sidTimestamp !== null) {
    const dateDirs = codexDateDirsForRange(sessionsRoot, sidTimestamp, sidTimestamp, 1);
    for (const dir of dateDirs) visit(dir, 0, 0);
    if (best) return best.path;
  }
  // Compatibility fallback for custom/legacy roots whose files are not stored
  // in Codex's YYYY/MM/DD layout, or for malformed historical UUID metadata.
  visit(sessionsRoot, 0, 3);
  return best ? best.path : null;
}

function findCodexRolloutByCwd(cwd, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  const targetCwd = normalizePathForCompare(cwd);
  if (!targetCwd || !sessionsRoot) return null;
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const beforeMs = Number.isFinite(opts.beforeMs) ? opts.beforeMs : 10000;
  const afterMs = Number.isFinite(opts.afterMs) ? opts.afterMs : 300000;
  let best = null;
  const visit = (dir, depth, maxDepth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full, depth + 1, maxDepth);
        continue;
      }
      if (!ent.isFile() || !ent.name.startsWith('rollout-') || !ent.name.endsWith('.jsonl')) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const mtime = stat.mtimeMs || 0;
      if (sinceMs !== null && (mtime < sinceMs - beforeMs || mtime > sinceMs + afterMs)) continue;
      const meta = readCodexRolloutMeta(full);
      if (!isCodexTopLevelRolloutMeta(meta) || normalizePathForCompare(meta.cwd || '') !== targetCwd) continue;
      const distance = sinceMs === null ? null : Math.abs(mtime - sinceMs);
      if (!best
        || (distance !== null && (best.distance === null || distance < best.distance))
        || (distance !== null && distance === best.distance && mtime > best.mtime)
        || (distance === null && mtime > best.mtime)) {
        best = { path: full, mtime, distance };
      }
    }
  };
  if (sinceMs !== null) {
    const dateDirs = codexDateDirsForRange(
      sessionsRoot,
      sinceMs - beforeMs,
      sinceMs + afterMs,
      1,
    );
    let hasStructuredDateDir = false;
    for (const dir of dateDirs) {
      if (!fs.existsSync(dir)) continue;
      hasStructuredDateDir = true;
      visit(dir, 0, 0);
    }
    // When the standard date layout exists, every candidate in the requested
    // spawn-time window is confined to these day directories. A full-root
    // negative scan only blocks Electron's main thread without finding more.
    if (hasStructuredDateDir) return best ? best.path : null;
  }
  visit(sessionsRoot, 0, 3);
  return best ? best.path : null;
}

module.exports = {
  DEFAULT_CODEX_SESSIONS_ROOT,
  // codex-session-migrator 判定 alreadyCurrent 要用同一套路径比较口径，
  // 不导出的话那边只会再写一份不一致的实现。
  normalizePathForCompare,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
  readCodexRolloutMeta,
  isCodexSubagentRolloutMeta,
  isCodexTopLevelRolloutMeta,
  codexRolloutMetaMatchesSid,
  isUsableCodexRolloutPath,
  isCodexSubagentRolloutPath,
  textFromContent,
  isInjectedContextText,
};
