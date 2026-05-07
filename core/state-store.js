const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');
const { acquireLock, releaseLock } = require('./file-lock');

const STATE_DIR = getHubDataDir();
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = STATE_FILE + '.lock';
const CURRENT_VERSION = 1;

// 2026-05-07 道雪 — 多 Hub 并发安全：
//   - 旧版 save() 是 last-writer-wins 全量覆盖，多 Hub 共享同一份 ~/.claude-session-hub
//     时会互相吞 session/圆桌；这版改为 acquireLock + read-merge-write。
//   - 每条 session/meeting 加 updatedAt（毫秒），merge 时 LWW 仲裁。
//   - 删除靠显式 _removedSessionIds/_removedMeetingIds set（main.js 持续 push），
//     不依赖"内存里没有 = 已删除"，避免某 Hub 启动时把别 Hub 的进展抹掉。
//   - 锁拿不到（极端 IO 阻塞）走 fallback 直写，保证 Hub 不卡死。

const _removedSessionIds = new Set();
const _removedMeetingIds = new Set();

function markRemovedSession(hubId) { if (hubId) _removedSessionIds.add(hubId); }
function markRemovedMeeting(meetingId) { if (meetingId) _removedMeetingIds.add(meetingId); }
// 2026-05-07 多方审查 fix：暴露 isMarked* 给 session-store/meeting-store 的 markDirty
//   做防御。renderer schedulePersist 是 400ms 防抖的，close-meeting 同步标记 removed
//   后，紧随其后的 persist-sessions IPC 可能仍带着已删 hubId（renderer 的 sessions
//   Map 还没收到 session-closed 事件就 send 了），main.js 会调 markDirty(sid, ...)，
//   把刚删的 per-session JSON 又写回来。markDirty 检查这个集合，跳过即可。
//   注意：drain 时清空 set，所以这道防御只在 save 周期内有效；正常 save 完成后，
//   下一轮 persist-sessions 已经 diff 出 sid → 走 removed 路径，文件再次被删。
function isMarkedRemovedSession(hubId) { return _removedSessionIds.has(hubId); }
function isMarkedRemovedMeeting(meetingId) { return _removedMeetingIds.has(meetingId); }
function _drainRemoved() {
  const s = [..._removedSessionIds];
  const m = [..._removedMeetingIds];
  _removedSessionIds.clear();
  _removedMeetingIds.clear();
  return { sessions: s, meetings: m };
}

function defaultState() {
  return {
    version: CURRENT_VERSION,
    cleanShutdown: true,
    sessions: [],
    meetings: [],
    immersiveByMeeting: {},
    pilotSlotByMeeting: {},
    dispatchModeByMeeting: {},
  };
}

function _readDiskState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CURRENT_VERSION) {
      try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.old'); } catch {}
      return defaultState();
    }
    return _normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

function _normalizeState(parsed) {
  if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
  for (const s of parsed.sessions) {
    if (s.codexSid === undefined) s.codexSid = null;
    if (s.geminiChatId === undefined) s.geminiChatId = null;
    if (s.geminiProjectHash === undefined) s.geminiProjectHash = null;
    if (s.geminiProjectRoot === undefined) s.geminiProjectRoot = null;
    if (typeof s.updatedAt !== 'number') s.updatedAt = 0;  // 老条目视为最古老
  }
  if (!Array.isArray(parsed.meetings)) parsed.meetings = [];
  for (const m of parsed.meetings) {
    if (typeof m.updatedAt !== 'number') m.updatedAt = 0;
  }
  if (!parsed.immersiveByMeeting || typeof parsed.immersiveByMeeting !== 'object') parsed.immersiveByMeeting = {};
  if (!parsed.pilotSlotByMeeting || typeof parsed.pilotSlotByMeeting !== 'object') parsed.pilotSlotByMeeting = {};
  if (!parsed.dispatchModeByMeeting || typeof parsed.dispatchModeByMeeting !== 'object') parsed.dispatchModeByMeeting = {};
  return parsed;
}

function load() {
  return _readDiskState();
}

// loadAndSelfHeal — boot path
//   1. read state.json
//   2. scan sessions/<id>.json  → restore orphans missing from state.sessions
//   3. scan meetings/<id>.json  → restore orphans missing from state.meetings (v2 only)
//   4. write back the healed state (cleanShutdown=false, sync)
//   返回 healed state.
function loadAndSelfHeal({ sessionStore, meetingStore } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const fd = acquireLock(LOCK_FILE);
  // 2026-05-07 多方审查 fix：原版即使 fd==null 仍 read+merge+write，
  //   两 Hub 同时 boot 时第二个会盖掉第一个还没完成的写。
  // 改为：拿不到锁时只读不写，返回当前盘上 state（仍执行 self-heal 合并扫描，
  //   但不写回磁盘）。下次正常 save 路径会自然把内存合并落盘。
  const haveLock = fd != null;
  try {
    const disk = _readDiskState();
    // 2026-05-07 道雪：保留盘上原始 cleanShutdown，让 main.js 看到 reboot 是不是
    //   优雅退出。下方 disk.cleanShutdown=false 会立即翻 flag，不能影响这个值。
    const originalCleanShutdown = !!disk.cleanShutdown;

    // session orphans — listSessionFilesWithData 内部已 try/catch（损坏 JSON skip）；
    //   再外层裹一道防御，万一目录权限错也不让 boot 死掉。
    if (sessionStore && typeof sessionStore.listSessionFilesWithData === 'function') {
      try {
        const onDisk = new Set(disk.sessions.map(s => s.hubId));
        const fromFiles = sessionStore.listSessionFilesWithData();
        for (const data of fromFiles) {
          if (!data || !data.hubId) continue;
          if (onDisk.has(data.hubId)) {
            const i = disk.sessions.findIndex(s => s.hubId === data.hubId);
            if (i >= 0 && (data.updatedAt || 0) > (disk.sessions[i].updatedAt || 0)) {
              disk.sessions[i] = { ...disk.sessions[i], ...data };
            }
          } else {
            disk.sessions.push({ ...data });
          }
        }
      } catch (e) {
        console.warn('[hub] session-store self-heal scan failed:', e.message);
      }
    }

    // meeting orphans
    if (meetingStore && typeof meetingStore.listMeetingFilesWithData === 'function') {
      try {
        const onDisk = new Set(disk.meetings.map(m => m.id));
        const fromFiles = meetingStore.listMeetingFilesWithData();
        for (const data of fromFiles) {
          if (!data || !data.id) continue;
          if (onDisk.has(data.id)) {
            const i = disk.meetings.findIndex(m => m.id === data.id);
            if (i >= 0 && (data.updatedAt || 0) > (disk.meetings[i].updatedAt || 0)) {
              // v2 文件版字段更全（含 title/scene/createdAt/...），覆盖式合并
              disk.meetings[i] = { ...disk.meetings[i], ...data };
            }
          } else if ((data.schemaVersion || 0) >= 2) {
            // v2 文件包含完整字段，可单独还原
            disk.meetings.push({ ...data });
          }
          // v1 only 文件无 state.json 条目 → 字段不全，跳过避免画残缺侧边栏
        }
      } catch (e) {
        console.warn('[hub] meeting-store self-heal scan failed:', e.message);
      }
    }

    disk.cleanShutdown = false;
    if (haveLock) {
      // 只在拿到锁的情况下写盘，避免与并发 boot 的 Hub 互踩
      _writeMergedToDisk(disk);
    } else {
      console.warn('[hub] loadAndSelfHeal: lock unavailable, returning in-memory heal without disk write');
    }
    // 返回时 cleanShutdown 字段已被翻成 false（运行中状态），但我们额外暴露
    //   bootWasCleanShutdown 给调用方判断"上次是不是优雅退出"。
    disk.bootWasCleanShutdown = originalCleanShutdown;
    return disk;
  } finally {
    if (fd != null) releaseLock(fd, LOCK_FILE);
  }
}

function mergeState(diskState, memState, removed = { sessions: [], meetings: [] }) {
  const sessByHubId = new Map();
  for (const s of diskState.sessions || []) sessByHubId.set(s.hubId, s);
  for (const s of memState.sessions || []) {
    if (!s || !s.hubId) continue;
    const existing = sessByHubId.get(s.hubId);
    if (!existing || (s.updatedAt || 0) >= (existing.updatedAt || 0)) {
      sessByHubId.set(s.hubId, s);
    }
  }
  for (const id of removed.sessions || []) sessByHubId.delete(id);

  const meetByMtgId = new Map();
  for (const m of diskState.meetings || []) meetByMtgId.set(m.id, m);
  for (const m of memState.meetings || []) {
    if (!m || !m.id) continue;
    const existing = meetByMtgId.get(m.id);
    if (!existing || (m.updatedAt || 0) >= (existing.updatedAt || 0)) {
      meetByMtgId.set(m.id, m);
    }
  }
  for (const id of removed.meetings || []) meetByMtgId.delete(id);

  return {
    version: CURRENT_VERSION,
    cleanShutdown: !!memState.cleanShutdown,
    sessions: [...sessByHubId.values()],
    meetings: [...meetByMtgId.values()],
    immersiveByMeeting: { ...(diskState.immersiveByMeeting || {}), ...(memState.immersiveByMeeting || {}) },
    pilotSlotByMeeting: { ...(diskState.pilotSlotByMeeting || {}), ...(memState.pilotSlotByMeeting || {}) },
    dispatchModeByMeeting: { ...(diskState.dispatchModeByMeeting || {}), ...(memState.dispatchModeByMeeting || {}) },
  };
}

function _writeMergedToDisk(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function _saveImpl(state) {
  const now = Date.now();
  if (Array.isArray(state.sessions)) {
    for (const s of state.sessions) if (typeof s.updatedAt !== 'number') s.updatedAt = now;
  }
  if (Array.isArray(state.meetings)) {
    for (const m of state.meetings) if (typeof m.updatedAt !== 'number') m.updatedAt = now;
  }

  const fd = acquireLock(LOCK_FILE);
  if (fd == null) {
    // 2026-05-07 多方审查 fix：原版锁拿不到直接 _writeMergedToDisk(state) 全量覆盖，
    //   绕过 mergeState/disk-reread/removed tombstone。多 Hub 同时拿不到锁时双方都
    //   走这个 fallback 会互相覆盖。
    // 改为：仍走读盘 + merge + 写，只不过没锁保护。即使两个 Hub 同时执行 fallback，
    //   各自的 mergeState 仍把对方的盘上数据合并进来——比起裸覆盖，最坏情况是
    //   "其中一方的 updatedAt 较新条目可能被覆盖"，而不是"全盘丢失"。
    try {
      const disk = _readDiskState();
      const removed = _drainRemoved();
      const merged = mergeState(disk, state, removed);
      _writeMergedToDisk(merged);
    } catch (e) {
      console.warn('[hub] state save failed (no lock fallback):', e.message);
    }
    return;
  }

  try {
    const disk = _readDiskState();
    const removed = _drainRemoved();
    const merged = mergeState(disk, state, removed);
    _writeMergedToDisk(merged);
  } catch (e) {
    console.warn('[hub] state save failed:', e.message);
  } finally {
    releaseLock(fd, LOCK_FILE);
  }
}

let saveDebounceTimer = null;
let _pendingState = null;

function save(state, { sync = false } = {}) {
  _pendingState = state;
  if (sync) {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
    _saveImpl(_pendingState);
    _pendingState = null;
    return;
  }
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    const s = _pendingState;
    _pendingState = null;
    saveDebounceTimer = null;
    _saveImpl(s);
  }, 500);
}

module.exports = {
  load,
  loadAndSelfHeal,
  save,
  mergeState,
  markRemovedSession,
  markRemovedMeeting,
  isMarkedRemovedSession,
  isMarkedRemovedMeeting,
  STATE_FILE,
  LOCK_FILE,
  CURRENT_VERSION,
};
