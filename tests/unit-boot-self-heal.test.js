// tests/unit-boot-self-heal.test.js
//
// 2026-05-07 道雪 — 单测 stateStore.loadAndSelfHeal 的孤儿恢复语义。
// 不启动 electron，纯 JS 单元层验证。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-heal-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const stateStore = require('../core/state-store');
const sessionStore = require('../core/session-store');
const meetingStore = require('../core/meeting-store');

(function run() {
  // SH1: state.json 不存在，但 sessions/<id>.json 存在 → self-heal 应该恢复
  {
    sessionStore.saveSessionFile('orphan-1', {
      kind: 'codex', title: 'Orphan Codex', cwd: 'C:/x',
      codexSid: 'codex-orphan-sid', updatedAt: 1000,
    });
    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const ids = healed.sessions.map(s => s.hubId);
    assert.ok(ids.includes('orphan-1'), 'orphan session 应被 boot heal 恢复');
    const recovered = healed.sessions.find(s => s.hubId === 'orphan-1');
    assert.strictEqual(recovered.codexSid, 'codex-orphan-sid', 'codexSid 应保留');
    console.log('PASS SH1 orphan session 从 sessions/ 目录恢复');
  }

  // SH2: meetings/<id>.json (v2) 存在但 state.json 没 → 应被 self-heal 恢复
  {
    meetingStore.saveMeetingFile('orphan-m', {
      id: 'orphan-m', title: 'Orphan Meeting', scene: 'research',
      _timeline: [], _cursors: {}, _nextIdx: 0,
      createdAt: 999, subSessions: ['s1'], lastMessageTime: 999,
      mode: 'free', participants: [0, 1, 2], updatedAt: 2000,
    });
    // 重新读盘（前面 SH1 已经写过 state.json，里面没 orphan-m）
    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const m = healed.meetings.find(mm => mm.id === 'orphan-m');
    assert.ok(m, 'orphan meeting v2 应被恢复');
    assert.strictEqual(m.title, 'Orphan Meeting');
    assert.strictEqual(m.scene, 'research');
    console.log('PASS SH2 orphan meeting (v2) 从 meetings/ 目录恢复');
  }

  // SH3: meetings/<id>.json v1 老格式（缺 title/scene）→ 不应单独恢复（防残缺侧边栏）
  {
    const v1Path = path.join(TEMP, 'meetings', 'v1-only.json');
    fs.writeFileSync(v1Path, JSON.stringify({
      schemaVersion: 1, id: 'v1-only',
      _timeline: [], _cursors: {}, _nextIdx: 0,
      pilotSlot: null, dispatchMode: 'all', mode: 'free', participants: null,
      savedAt: 1000,
    }));
    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const m = healed.meetings.find(mm => mm.id === 'v1-only');
    assert.strictEqual(m, undefined, 'v1-only file without state.json entry 不应造孤儿条目');
    console.log('PASS SH3 v1-only 文件无 state.json 配套时被忽略（避免残缺）');
  }

  // SH4: state.json 已有 vs sessions/<id>.json 时间戳更新 → LWW 取较新
  {
    // 先写 state.json 包含 sess-A updatedAt=100
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [{ hubId: 'sess-A', kind: 'claude', title: 'old-title', updatedAt: 100 }],
      meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });
    // sessions/<sess-A>.json 写一个更新版（updatedAt=500）
    sessionStore.saveSessionFile('sess-A', {
      kind: 'claude', title: 'new-title', codexSid: null,
      updatedAt: 500,
    });
    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const s = healed.sessions.find(ss => ss.hubId === 'sess-A');
    assert.ok(s);
    assert.strictEqual(s.title, 'new-title', 'per-session JSON 较新版本胜出');
    console.log('PASS SH4 state.json vs sessions/ LWW 仲裁');
  }

  // SH5: state.json 已有 vs sessions/<id>.json 时间戳更老 → 保留 state.json 版本
  {
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [{ hubId: 'sess-B', kind: 'claude', title: 'state-newer', updatedAt: 9999 }],
      meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });
    sessionStore.saveSessionFile('sess-B', {
      kind: 'claude', title: 'sessions-older', updatedAt: 100,
    });
    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const s = healed.sessions.find(ss => ss.hubId === 'sess-B');
    assert.ok(s);
    assert.strictEqual(s.title, 'state-newer', 'state.json 较新版本胜出');
    console.log('PASS SH5 反向 LWW — state.json 较新时保留');
  }

  console.log('\n[ALL boot self-heal tests PASSED]');
})();
