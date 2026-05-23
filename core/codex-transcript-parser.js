/**
 * Parse Codex CLI rollout JSONL files into the same normalized turn shape used
 * by the card view renderer.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_TAIL_WINDOW_INITIAL_BYTES = 8 * 1024 * 1024;

function normalizePathForCompare(p) {
  if (!p) return '';
  try { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
  catch { return String(p).replace(/\\/g, '/').toLowerCase(); }
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

function _makeTurnId(prefix, obj, index) {
  if (obj && typeof obj.id === 'string') return `${prefix}-${obj.id}`;
  if (obj && obj.payload && typeof obj.payload.id === 'string') return `${prefix}-${obj.payload.id}`;
  const ts = obj && obj.timestamp ? String(obj.timestamp) : String(index);
  return `${prefix}-${ts}-${index}`;
}

function isInjectedContextText(text) {
  const t = String(text || '').trimStart();
  if (!t) return false;
  return (
    t.startsWith('# AGENTS.md instructions for ') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<skills_instructions>') ||
    t.startsWith('# Model Set Context') ||
    (t.includes('<INSTRUCTIONS>') && t.includes('CAT-CAFE-GOVERNANCE-START'))
  );
}

function hasNearbyEventUserDuplicate(entries, entryIndex, text) {
  const normalized = normalizeUserDuplicateText(text);
  if (!normalized) return false;
  const maxLookahead = Math.min(entries.length, entryIndex + 6);
  for (let i = entryIndex + 1; i < maxLookahead; i++) {
    const obj = entries[i] && entries[i].obj;
    if (!obj || obj.type !== 'event_msg') continue;
    const payload = obj.payload || {};
    if (payload.type !== 'user_message') continue;
    if (normalizeUserDuplicateText(textFromPayload(payload)) === normalized) return true;
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
      if (eventType === 'user_message') {
        flushAssistant();
        const text = textFromPayload(payload).trim();
        if (text) {
          turns.push({
            id: _makeTurnId('codex-user', obj, index),
            role: 'user',
            text,
            ts: toMs(obj.timestamp),
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
      if (eventType === 'agent_message') {
        const text = textFromPayload(payload).trim();
        if (!text) return;
        const pending = ensurePendingAssistant();
        pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
        pending.ts = pending.ts || toMs(obj.timestamp);
        pending.tsEnd = toMs(obj.timestamp);
        pending.agentMessages.push(text);
        return;
      }
      if (eventType === 'task_complete') {
        const text = textFromContent(payload.last_agent_message).trim();
        // 空 last_agent_message 但已有 agentMessages 时，不要丢轮；
        // 让 flushAssistant 走 agentMessages 拼接 fallback
        if (!text && (!pendingAssistant || !pendingAssistant.agentMessages.length)) return;
        const pending = ensurePendingAssistant();
        pending.id = pending.id || _makeTurnId('codex-assistant', obj, index);
        pending.ts = pending.ts || toMs(obj.timestamp);
        pending.tsEnd = toMs(obj.timestamp);
        if (text) pending.finalText = text;
        pending.durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : null;
        return;
      }
    }

    if (obj.type === 'response_item' && obj.payload && obj.payload.role === 'user') {
      const text = textFromPayload(obj.payload).trim();
      if (text && !isInjectedContextText(text) && !hasNearbyEventUserDuplicate(entries, entryIndex, text)) {
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

  let windowBytes = CODEX_TAIL_WINDOW_INITIAL_BYTES;
  while (windowBytes < stat.size) {
    const turns = parseCodexRolloutText(readCodexTailWindowText(jsonlPath, windowBytes));
    if (turns.length >= limit) return applyTurnLimit(turns, limit, fromTail);
    windowBytes = Math.min(stat.size, windowBytes * 2);
  }

  const turns = parseCodexRolloutText(fs.readFileSync(jsonlPath, 'utf8'));
  return applyTurnLimit(turns, limit, fromTail);
}

function findCodexRolloutBySid(codexSid, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT) {
  if (!codexSid || !sessionsRoot) return null;
  const suffix = `-${codexSid}.jsonl`;
  let best = null;
  const visit = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full, depth + 1);
      } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith(suffix)) {
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      }
    }
  };
  visit(sessionsRoot, 0);
  return best ? best.path : null;
}

function findCodexRolloutByCwd(cwd, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  const targetCwd = normalizePathForCompare(cwd);
  if (!targetCwd || !sessionsRoot) return null;
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const beforeMs = Number.isFinite(opts.beforeMs) ? opts.beforeMs : 10000;
  const afterMs = Number.isFinite(opts.afterMs) ? opts.afterMs : 300000;
  let best = null;
  const visit = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!ent.isFile() || !ent.name.startsWith('rollout-') || !ent.name.endsWith('.jsonl')) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const mtime = stat.mtimeMs || 0;
      if (sinceMs !== null && (mtime < sinceMs - beforeMs || mtime > sinceMs + afterMs)) continue;
      const first = readFirstLineSync(full);
      if (!first) continue;
      let meta;
      try { meta = JSON.parse(first); } catch { continue; }
      if (meta?.type !== 'session_meta' || normalizePathForCompare(meta.payload?.cwd || '') !== targetCwd) continue;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    }
  };
  visit(sessionsRoot, 0);
  return best ? best.path : null;
}

module.exports = {
  DEFAULT_CODEX_SESSIONS_ROOT,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
  textFromContent,
  isInjectedContextText,
};
