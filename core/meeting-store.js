// core/meeting-store.js
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

// 2026-05-07 道雪 — schemaVersion 1→2：补全 title/scene/createdAt/subSessions/...
//   字段，让 per-meeting JSON 成为完整权威备份。即使 state.json 损坏或被外部 Hub
//   覆盖，下次 boot 也能从 meetings/<id>.json 单独恢复整间圆桌。
//   loadMeetingFile 同时支持 v1（部分字段）与 v2（完整字段），调用方按 schemaVersion
//   决定是否需要再去 state.json 取兜底。
const SCHEMA_VERSION = 2;
const DEBOUNCE_MS = 5000;

function meetingsDir() {
  return path.join(getHubDataDir(), 'meetings');
}

function ensureDir() {
  fs.mkdirSync(meetingsDir(), { recursive: true });
}

function meetingFilePath(id) {
  return path.join(meetingsDir(), `${id}.json`);
}

function saveMeetingFile(id, data) {
  ensureDir();
  const now = Date.now();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    id,
    // ── timeline + cursors（v1 已有） ──
    _timeline: Array.isArray(data._timeline) ? data._timeline : [],
    _cursors: data._cursors && typeof data._cursors === 'object' ? data._cursors : {},
    _nextIdx: typeof data._nextIdx === 'number' ? data._nextIdx : 0,
    slotSpecs: Array.isArray(data.slotSpecs) ? data.slotSpecs : null,
    pilotSlot: (typeof data.pilotSlot === 'number') ? data.pilotSlot : null,
    dispatchMode: ['all', 'pilot', 'observer'].includes(data.dispatchMode) ? data.dispatchMode : 'all',
    mode: ['pilot', 'free'].includes(data.mode) ? data.mode : 'free',
    participants: Array.isArray(data.participants) ? data.participants : null,
    // ── v2 新增：完整 meeting metadata（用于 boot 自我修复） ──
    title: typeof data.title === 'string' ? data.title : null,
    scene: typeof data.scene === 'string' ? data.scene : null,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : null,
    subSessions: Array.isArray(data.subSessions) ? data.subSessions : [],
    layout: typeof data.layout === 'string' ? data.layout : 'focus',
    focusedSub: typeof data.focusedSub === 'string' ? data.focusedSub : null,
    syncContext: !!data.syncContext,
    sendTarget: typeof data.sendTarget === 'string' ? data.sendTarget : 'all',
    pinned: !!data.pinned,
    lastScene: typeof data.lastScene === 'string' ? data.lastScene : null,
    lastMessageTime: typeof data.lastMessageTime === 'number' ? data.lastMessageTime : null,
    covenantText: typeof data.covenantText === 'string' ? data.covenantText : '',
    immersive: !!data.immersive,
    // 时间戳
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : now,
    savedAt: now,
  };
  const tmp = meetingFilePath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, meetingFilePath(id));
}

function loadMeetingFile(id) {
  try {
    const raw = fs.readFileSync(meetingFilePath(id), 'utf-8');
    const obj = JSON.parse(raw);
    const v = obj.schemaVersion;
    if (v !== 1 && v !== 2) {
      console.warn(`[meeting-store] schema mismatch for ${id}: ${v}`);
      return null;
    }
    // 通用兜底
    if (!['pilot', 'free'].includes(obj.mode)) obj.mode = 'free';
    if (!Array.isArray(obj.participants)) obj.participants = null;
    if (typeof obj.updatedAt !== 'number') obj.updatedAt = obj.savedAt || 0;
    if (v === 1) {
      // v1 → 缺 title/scene/createdAt/subSessions 等。返回时显式带 schemaVersion=1
      // 让调用方判断是否需要补全（main.js boot 会在 state.json 里反查；如果都没有则
      // 不画 sidebar 条目，避免残缺）
      obj.schemaVersion = 1;
    }
    return obj;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[meeting-store] load ${id} failed:`, e.message);
    return null;
  }
}

function listMeetingFiles() {
  try {
    return fs.readdirSync(meetingsDir())
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.slice(0, -5));
  } catch { return []; }
}

// Boot 自我修复用：扫目录返回所有 per-meeting JSON 内容（含 schemaVersion）。
// 损坏文件 skip 不影响其他文件加载。
function listMeetingFilesWithData() {
  const out = [];
  for (const id of listMeetingFiles()) {
    const data = loadMeetingFile(id);
    if (data) out.push(data);
  }
  return out;
}

function deleteMeetingFile(id) {
  try { fs.unlinkSync(meetingFilePath(id)); } catch {}
}

// Debounced flush registry
const _dirty = new Map();
const _timers = new Map();

function markDirty(id, data) {
  _dirty.set(id, data);
  if (_timers.has(id)) clearTimeout(_timers.get(id));
  const t = setTimeout(() => {
    const snap = _dirty.get(id);
    if (snap) {
      try { saveMeetingFile(id, snap); } catch (e) { console.warn(`[meeting-store] flush ${id} failed:`, e.message); }
      _dirty.delete(id);
    }
    _timers.delete(id);
  }, DEBOUNCE_MS);
  t.unref?.();
  _timers.set(id, t);
}

async function flushAll() {
  for (const [, t] of _timers) clearTimeout(t);
  _timers.clear();
  for (const [id, snap] of _dirty) {
    try { saveMeetingFile(id, snap); } catch (e) { console.warn(`[meeting-store] flushAll ${id} failed:`, e.message); }
  }
  _dirty.clear();
}

function cancelDirty(id) {
  if (_timers.has(id)) {
    clearTimeout(_timers.get(id));
    _timers.delete(id);
  }
  _dirty.delete(id);
}

module.exports = {
  saveMeetingFile,
  loadMeetingFile,
  listMeetingFiles,
  listMeetingFilesWithData,
  deleteMeetingFile,
  markDirty,
  cancelDirty,
  flushAll,
  SCHEMA_VERSION,
  DEBOUNCE_MS,
};
