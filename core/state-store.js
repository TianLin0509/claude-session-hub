const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

const STATE_DIR = getHubDataDir();
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CURRENT_VERSION = 1;

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CURRENT_VERSION) {
      try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.old'); } catch {}
      return defaultState();
    }
    if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
    // Normalize new resume-meta fields (added in 2026-04-26 for meeting persistence T4)
    for (const s of parsed.sessions) {
      if (s.codexSid === undefined) s.codexSid = null;
      if (s.geminiChatId === undefined) s.geminiChatId = null;
      if (s.geminiProjectHash === undefined) s.geminiProjectHash = null;
      if (s.geminiProjectRoot === undefined) s.geminiProjectRoot = null;
    }
    if (!Array.isArray(parsed.meetings)) parsed.meetings = [];
    // Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meeting 持久化字典。
    //   缺省按 false（调试模式）处理，老 state.json 没有此字段也兼容。
    if (!parsed.immersiveByMeeting || typeof parsed.immersiveByMeeting !== 'object') {
      parsed.immersiveByMeeting = {};
    }
    // pilot-mode Task 1（2026-05-01）— 主驾 slot per-meeting 持久化字典。
    //   缺省 {}（无主驾），老 state.json 自动兼容。
    if (!parsed.pilotSlotByMeeting || typeof parsed.pilotSlotByMeeting !== 'object') {
      parsed.pilotSlotByMeeting = {};
    }
    return parsed;
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return {
    version: CURRENT_VERSION, cleanShutdown: true,
    sessions: [], meetings: [],
    immersiveByMeeting: {},
    pilotSlotByMeeting: {},
  };
}

let saveDebounceTimer = null;

function saveImpl(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.warn('[hub] state save failed:', e.message);
  }
}

function save(state, { sync = false } = {}) {
  if (sync) {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
    saveImpl(state);
    return;
  }
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => saveImpl(state), 500);
}

module.exports = { load, save, STATE_FILE, CURRENT_VERSION };
