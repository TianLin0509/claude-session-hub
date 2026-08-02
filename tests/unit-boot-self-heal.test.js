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
      _timeline: [], _cursors: {}, _nextIdx: 0, mode: 'free', participants: null,
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
      immersiveByMeeting: {},
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
      immersiveByMeeting: {},
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

  // SH6: 旧实例可能在升级后仍写入「Codex 2 · 分支」。boot self-heal 必须在
  // state.json 与较新的 per-session JSON 完成 LWW 后再次交付规范标题，不能只靠
  // renderer 临时改显示。
  {
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [{
        hubId: 'legacy-branch', kind: 'codex', title: '旧标题 · 分支',
        userRenamed: true, updatedAt: 100,
      }],
      meetings: [],
      immersiveByMeeting: {},
    }, { sync: true });
    const legacyFile = path.join(TEMP, 'sessions', 'legacy-branch.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
      schemaVersion: 1,
      hubId: 'legacy-branch',
      kind: 'codex',
      title: 'Codex 2 · 分支',
      userRenamed: true,
      updatedAt: 500,
      savedAt: 500,
    }));

    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const s = healed.sessions.find(ss => ss.hubId === 'legacy-branch');
    assert.ok(s);
    assert.strictEqual(s.title, '分支: 待命名', 'a generic provider label must not become the final branch name');
    assert.strictEqual(s.userRenamed, false, 'old handler flag was not a real user rename');
    assert.strictEqual(s.branchAutoTitlePending, true, 'generic Codex branch remains eligible for auto-title');
    const persisted = JSON.parse(fs.readFileSync(path.join(TEMP, 'state.json'), 'utf8'));
    assert.strictEqual(
      persisted.sessions.find(ss => ss.hubId === 'legacy-branch').title,
      '分支: 待命名',
      'self-heal must persist the canonical title instead of repairing only the renderer',
    );
    console.log('PASS SH6 legacy branch title migrated in authority state');
  }

  // SH7: Codex rollout 的 session_meta 自带 forked_from_id。即使旧 Hub 没存
  // branchSourceSessionId，也应反查父成员；父成员只是 Codex 2 时，继承它所属的
  // 原始群聊标题，而不是把 provider 槽位名当会话名。
  {
    const parentCodexSid = '55555555-5555-4555-8555-555555555555';
    const branchCodexSid = '66666666-6666-4666-8666-666666666666';
    const transcriptPath = path.join(TEMP, 'rollout-branch.jsonl');
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: branchCodexSid, forked_from_id: parentCodexSid },
    })}\n`);
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: [{
        hubId: 'meeting-codex-parent',
        kind: 'codex',
        title: 'Codex 2',
        codexSid: parentCodexSid,
        meetingId: 'meeting-original',
        updatedAt: 1000,
      }],
      meetings: [{
        id: 'meeting-original',
        title: '通道重构与多阵子驱动',
        updatedAt: 1000,
      }],
      immersiveByMeeting: {},
    }, { sync: true });
    const branchPath = path.join(TEMP, 'sessions', 'legacy-meeting-branch.json');
    fs.writeFileSync(branchPath, JSON.stringify({
      schemaVersion: 1,
      hubId: 'legacy-meeting-branch',
      kind: 'codex',
      title: 'Codex 2 · 分支',
      codexSid: branchCodexSid,
      transcriptPath,
      updatedAt: 2000,
      savedAt: 2000,
    }));

    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const branch = healed.sessions.find(s => s.hubId === 'legacy-meeting-branch');
    assert.ok(branch);
    assert.strictEqual(branch.title, '分支: 通道重构与多阵子驱动');
    assert.strictEqual(branch.branchSourceSessionId, 'meeting-codex-parent');
    assert.strictEqual(branch.branchAutoTitlePending, false);
    assert.strictEqual(branch.autoTitleGenerated, true);
    const branchFile = sessionStore.loadSessionFile('legacy-meeting-branch');
    assert.strictEqual(branchFile.title, '分支: 通道重构与多阵子驱动');
    console.log('PASS SH7 Codex fork ancestry restores the original meeting title');
  }

  console.log('\n[ALL boot self-heal tests PASSED]');
})();
