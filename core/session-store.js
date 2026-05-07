// core/session-store.js
//
// 2026-05-07 道雪 — per-session JSON 备份。镜像 meeting-store 的设计：
//   每个 session 独立写一份 sessions/<hubId>.json，作为 state.json 的双备份。
//   重点保护 codexSid / geminiChatId / geminiProjectHash / geminiProjectRoot
//   这类 transcript 关联字段——历史上反复因 state.json 全量覆盖被吞回 null，
//   导致 Codex/Gemini 的 dormant resume 退化为 Level 2/3 fallback。
//
// 写时机：
//   markDirty(hubId, data)      — 200ms debounce 普通字段变更
//   markDirtySync(hubId, data)  — 即时落盘（codex/gemini sid 出现时立即固化）
//   flushAll()                  — before-quit 同步 flush

const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 200;  // 比 meeting 短：sid 类字段一旦变化要尽快落盘

function sessionsDir() {
  return path.join(getHubDataDir(), 'sessions');
}

function ensureDir() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

function sessionFilePath(hubId) {
  return path.join(sessionsDir(), `${hubId}.json`);
}

function saveSessionFile(hubId, data) {
  ensureDir();
  const now = Date.now();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    hubId,
    kind: typeof data.kind === 'string' ? data.kind : 'claude',
    title: typeof data.title === 'string' ? data.title : null,
    cwd: typeof data.cwd === 'string' ? data.cwd : null,
    pinned: !!data.pinned,
    ccSessionId: data.ccSessionId || null,
    codexSid: data.codexSid || null,
    geminiChatId: data.geminiChatId || null,
    geminiProjectHash: data.geminiProjectHash || null,
    geminiProjectRoot: data.geminiProjectRoot || null,
    currentModel: (data.currentModel && typeof data.currentModel === 'object') ? data.currentModel : null,
    meetingId: data.meetingId || null,
    lastMessageTime: typeof data.lastMessageTime === 'number' ? data.lastMessageTime : null,
    lastOutputPreview: typeof data.lastOutputPreview === 'string' ? data.lastOutputPreview : '',
    unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : now,
    savedAt: now,
  };
  const tmp = sessionFilePath(hubId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, sessionFilePath(hubId));
}

function loadSessionFile(hubId) {
  try {
    const raw = fs.readFileSync(sessionFilePath(hubId), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      console.warn(`[session-store] schema mismatch for ${hubId}: ${obj.schemaVersion}`);
      return null;
    }
    if (typeof obj.updatedAt !== 'number') obj.updatedAt = obj.savedAt || 0;
    return obj;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[session-store] load ${hubId} failed:`, e.message);
    return null;
  }
}

function listSessionFiles() {
  try {
    return fs.readdirSync(sessionsDir())
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.slice(0, -5));
  } catch { return []; }
}

function listSessionFilesWithData() {
  const out = [];
  for (const id of listSessionFiles()) {
    const data = loadSessionFile(id);
    if (data) out.push(data);
  }
  return out;
}

function deleteSessionFile(hubId) {
  try { fs.unlinkSync(sessionFilePath(hubId)); } catch {}
}

const _dirty = new Map();
const _timers = new Map();

function markDirty(hubId, data) {
  if (!hubId) return;
  _dirty.set(hubId, data);
  if (_timers.has(hubId)) clearTimeout(_timers.get(hubId));
  const t = setTimeout(() => {
    const snap = _dirty.get(hubId);
    if (snap) {
      try { saveSessionFile(hubId, snap); }
      catch (e) { console.warn(`[session-store] flush ${hubId} failed:`, e.message); }
      _dirty.delete(hubId);
    }
    _timers.delete(hubId);
  }, DEBOUNCE_MS);
  t.unref?.();
  _timers.set(hubId, t);
}

// Sync write — for codex/gemini sid 这类一旦确定不能丢的关键字段。
// 仍然保留 markDirty 的 pending 数据：本调用立即落盘，未触发的 debounce 取消。
function markDirtySync(hubId, data) {
  if (!hubId) return;
  if (_timers.has(hubId)) { clearTimeout(_timers.get(hubId)); _timers.delete(hubId); }
  _dirty.delete(hubId);
  try { saveSessionFile(hubId, data); }
  catch (e) { console.warn(`[session-store] sync flush ${hubId} failed:`, e.message); }
}

function flushAll() {
  for (const [, t] of _timers) clearTimeout(t);
  _timers.clear();
  for (const [id, snap] of _dirty) {
    try { saveSessionFile(id, snap); }
    catch (e) { console.warn(`[session-store] flushAll ${id} failed:`, e.message); }
  }
  _dirty.clear();
}

function cancelDirty(hubId) {
  if (_timers.has(hubId)) {
    clearTimeout(_timers.get(hubId));
    _timers.delete(hubId);
  }
  _dirty.delete(hubId);
}

module.exports = {
  saveSessionFile,
  loadSessionFile,
  listSessionFiles,
  listSessionFilesWithData,
  deleteSessionFile,
  markDirty,
  markDirtySync,
  cancelDirty,
  flushAll,
  SCHEMA_VERSION,
  DEBOUNCE_MS,
};
