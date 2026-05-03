// core/meeting-store.js
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

const SCHEMA_VERSION = 1;
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
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    id,
    _timeline: Array.isArray(data._timeline) ? data._timeline : [],
    _cursors: data._cursors && typeof data._cursors === 'object' ? data._cursors : {},
    _nextIdx: typeof data._nextIdx === 'number' ? data._nextIdx : 0,
    // meeting-create-modal（2026-05-01）：slotSpecs 也在 per-meeting JSON 落盘，
    //   作为 state.json 的备份（state.json 写失败时仍能从这里 restoreMeeting 重建 slot 信息）。
    slotSpecs: Array.isArray(data.slotSpecs) ? data.slotSpecs : null,
    // pilot-mode（2026-05-01）：当前主驾 slot 索引（0|1|2|null）。Hub 重启后自动恢复主驾态。
    pilotSlot: (typeof data.pilotSlot === 'number') ? data.pilotSlot : null,
    // pilot redesign（2026-05-02）：dispatchMode = 'all'|'pilot'|'observer'，决定本轮谁开口。
    dispatchMode: ['all', 'pilot', 'observer'].includes(data.dispatchMode) ? data.dispatchMode : 'all',
    // free-mode（2026-05-04）：mode = 'pilot'|'free'，缺失/非法 → 'pilot'（老 meeting 兼容）
    mode: ['pilot', 'free'].includes(data.mode) ? data.mode : 'pilot',
    // free-mode（2026-05-04）：participants = number[]（slot 索引）｜null（首次未初始化）
    //   非数组 → null；空数组保留（Q11=A：尊重用户清空）
    participants: Array.isArray(data.participants) ? data.participants : null,
    savedAt: Date.now(),
  };
  const tmp = meetingFilePath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, meetingFilePath(id));
}

function loadMeetingFile(id) {
  try {
    const raw = fs.readFileSync(meetingFilePath(id), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      console.warn(`[meeting-store] schema mismatch for ${id}: ${obj.schemaVersion}`);
      return null;
    }
    // free-mode（2026-05-04）：老 meeting 文件无 mode/participants 字段时兜底
    if (!['pilot', 'free'].includes(obj.mode)) obj.mode = 'pilot';
    if (!Array.isArray(obj.participants)) obj.participants = null;
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

function deleteMeetingFile(id) {
  try { fs.unlinkSync(meetingFilePath(id)); } catch {}
}

// Debounced flush registry
const _dirty = new Map();   // id → latest data snapshot
const _timers = new Map();  // id → debounce timer

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
  for (const [id, t] of _timers) clearTimeout(t);
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
  deleteMeetingFile,
  markDirty,
  cancelDirty,
  flushAll,
  SCHEMA_VERSION,
  DEBOUNCE_MS,
};
