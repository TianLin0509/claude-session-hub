'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemoryReleasePlan, describeScript, sessionIdsInCmd } = require('../core/memory-release-planner');
const { createSessionManifestExchange, readManifests } = require('../core/session-manifest-exchange');
const { registerMemoryReleaseIpc } = require('../main/ipc/memory-release-handlers');

const MB = 1024 * 1024;
const HUB = 'C:\\Users\\x\\claude-session-hub\\node_modules\\electron\\dist\\electron.exe';
const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const UUID_C = 'cccccccc-1111-2222-3333-444444444444';

function proc(pid, ppid, name, cmd, wsMb, extra = {}) {
  return { pid, ppid, name, cmd, startedAt: 1_000 + pid, wsBytes: wsMb * MB, privBytes: 0, hasWindow: false, cpuDeltaMs: 0, ...extra };
}

function snapshotOf(processes) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const childrenMap = new Map();
  for (const p of processes) {
    if (!childrenMap.has(p.ppid)) childrenMap.set(p.ppid, []);
    childrenMap.get(p.ppid).push(p.pid);
  }
  return { processes, byPid, childrenMap, sampledAt: 5_000, cpuWindowMs: 1_200, cpuCount: 8 };
}

function fixture() {
  return snapshotOf([
    proc(100, 1, 'electron.exe', `"${HUB}" "C:\\Users\\x\\claude-session-hub"`, 500),
    proc(101, 100, 'electron.exe', `"${HUB}" --type=renderer`, 400),
    proc(102, 100, 'electron.exe', `${HUB} --max-old-space-size=768 C:\\x\\claude-session-hub\\core\\session-search-child.js`, 600),
    proc(200, 100, 'powershell.exe', 'powershell.exe -NoProfile -NoLogo', 60),
    proc(201, 200, 'claude.exe', `claude.exe --resume ${UUID_A}`, 400),
    proc(300, 100, 'powershell.exe', 'powershell.exe -NoProfile -NoLogo', 60),
    proc(301, 300, 'claude.exe', 'claude.exe --resume bbbbbbbb-1111-2222-3333-444444444444', 450),
    proc(401, 100, 'claude.exe', `claude.exe --session-id ${UUID_C}`, 300),
    proc(500, 999, 'claude.exe', `claude.exe --resume dddddddd-1111-2222-3333-444444444444`, 350),
    proc(600, 1, 'chrome.exe', 'chrome.exe', 700),
    proc(601, 600, 'chrome.exe', 'chrome.exe --type=renderer', 300),
    proc(700, 1, 'python.exe', 'python.exe -m uvicorn app.main:app --port 8000', 200),
    proc(800, 100, 'powershell.exe', 'powershell.exe -NoProfile -NoLogo', 90),
    proc(801, 800, 'node.exe', 'node cliDaemon.js', 110),
    proc(900, 1, 'AIGroupChatHub.exe', 'AIGroupChatHub.exe C:\\Users\\x\\claude-session-hub', 800),
    proc(901, 900, 'claude.exe', 'claude.exe --resume eeeeeeee-1111-2222-3333-444444444444', 500),
  ]);
}

const manifest = {
  pid: 100, appVersion: '1.6.306', writtenAt: 5_000,
  sessions: [
    { id: 's-a', title: 'PPT 改稿', kind: 'claude', ptyPid: 200, nativeId: UUID_A, suspendable: true, idleMs: 2 * 3600_000 },
    { id: 's-b', title: 'VPN 流量排查', kind: 'claude', ptyPid: 300, running: true, suspendable: false, blockReason: 'pty-turn-unfinished' },
    { id: 's-c', title: '无线仿真', kind: 'claude', ptyPid: null, nativeId: UUID_C, suspendable: true, idleMs: 20 * 60_000 },
  ],
};

const reclaimReport = {
  ok: true,
  groups: {
    deadHub: [],
    endedSession: [{ rootPid: 800, rootStartedAt: 1_800, pids: [800, 801], label: 'Playwright 浏览器守护进程', detail: '', ownerLabel: '当前 Hub，但不属于任何活跃会话', whatYouLose: '不会失去任何东西', eligible: true }],
  },
};

test('processes are grouped by owning session, not by process name', () => {
  const plan = buildMemoryReleasePlan({
    snapshot: fixture(), selfPid: 100, manifests: new Map([[100, manifest]]), reclaimReport,
    memory: { totalBytes: 32 * 1024 * MB, freeBytes: 4 * 1024 * MB },
  });
  const byKey = Object.fromEntries(plan.items.map(i => [i.key, i]));

  const a = byKey['session:100:s-a'];
  assert.equal(a.tier, 'suspend');
  assert.equal(a.title, 'PPT 改稿');
  assert.equal(a.wsBytes, 460 * MB, 'shell + claude subtree');
  assert.equal(a.selected, true, 'idle over an hour is preselected');
  assert.match(a.subtitle, /Claude Code · 会话 aaaaaaaa · 当前 Hub 窗口/);

  const b = byKey['session:100:s-b'];
  assert.equal(b.tier, 'info');
  assert.equal(b.status, '正在回答，不能休眠');
  assert.equal(b.selected, false);

  const c = byKey['session:100:s-c'];
  assert.equal(c.tier, 'suspend', 'claimed through the session id on the command line');
  assert.equal(c.selected, false, 'idle under an hour is offered but not preselected');

  const leftover = byKey['leftover:800:1800'];
  assert.equal(leftover.tier, 'safe');
  assert.equal(leftover.selected, true);
  assert.equal(leftover.wsBytes, 200 * MB);

  const orphan = byKey['orphan:500:1500'];
  assert.equal(orphan.tier, 'safe');
  assert.match(orphan.subtitle, /dddddddd/);

  const selfHub = plan.items.find(i => i.key.startsWith('hub:100:'));
  assert.equal(selfHub.tier, 'info');
  assert.equal(selfHub.wsBytes, 1500 * MB, 'hub row keeps only main + renderer + search index');
  assert.deepEqual(selfHub.parts.map(p => p.label).sort(), ['Hub 主进程', '会话搜索索引', '界面渲染'].sort());

  const otherHub = plan.items.find(i => i.key.startsWith('hub:900:'));
  assert.match(otherHub.title, /看不到会话状态/);
  assert.equal(otherHub.wsBytes, 1300 * MB, 'unknown sessions stay inside the other hub row');
  assert.equal(plan.totals.hubWindowsWithoutManifest, 1);

  assert.equal(byKey['app:Chrome'].wsBytes, 1000 * MB);
  assert.ok(byKey['app:Python · uvicorn app.main:app']);
  assert.equal(plan.memory.usedPct, 88);

  // 档位顺序：可结束 → 可休眠 → 只显示；每个 PID 只归一处。
  const tiers = plan.items.map(i => i.tier);
  assert.deepEqual(tiers, [...tiers].sort((x, y) => ['safe', 'suspend', 'info'].indexOf(x) - ['safe', 'suspend', 'info'].indexOf(y)));
  const seen = new Set();
  for (const item of plan.items) for (const m of item.members || []) { assert.ok(!seen.has(m.pid), `pid ${m.pid} listed twice`); seen.add(m.pid); }
});

test('a busy orphan CLI is shown but not offered', () => {
  const snap = fixture();
  snap.byPid.get(500).cpuDeltaMs = 900;
  const plan = buildMemoryReleasePlan({ snapshot: snap, selfPid: 100, manifests: new Map([[100, manifest]]), reclaimReport });
  const orphan = plan.items.find(i => i.key.startsWith('orphan:500'));
  assert.equal(orphan.tier, 'info');
  assert.equal(orphan.selected, false);
});

test('desktop apps with the same exe name are never treated as orphan CLIs', () => {
  const snap = snapshotOf([
    ...fixture().processes,
    proc(1100, 777, 'claude.exe', '"C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\claude.exe"', 300, { hasWindow: true }),
    proc(1200, 778, 'codex.exe', 'codex.exe app', 200),
  ]);
  const plan = buildMemoryReleasePlan({ snapshot: snap, selfPid: 100, manifests: new Map([[100, manifest]]), reclaimReport });
  assert.ok(!plan.items.some(i => i.key.startsWith('orphan:1100')), 'windowed desktop app is not an orphan');
  assert.ok(!plan.items.some(i => i.key.startsWith('orphan:1200')), 'no session id → not an orphan');
  assert.ok(!plan.items.some(i => i.tier !== 'info' && (i.members || []).some(m => m.pid === 1100 || m.pid === 1200)));
});

test('script hosts are labelled by what they run', () => {
  assert.equal(describeScript({ name: 'python.exe', cmd: 'python.exe C:\\work\\scripts\\image_worker.py --x' }), 'Python · scripts/image_worker.py');
  assert.equal(describeScript({ name: 'node.exe', cmd: '"C:\\node.exe" C:\\a\\b\\server.js' }), 'Node · b/server.js');
  assert.deepEqual(sessionIdsInCmd(`claude --resume ${UUID_A} --x`), [UUID_A]);
});

test('Hub windows exchange session manifests and forward suspend requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-exchange-'));
  try {
    const suspended = [];
    const a = createSessionManifestExchange({
      diagnosticsDir: dir, pid: 111, appVersion: '1.0.0', inboxMs: 250,
      describeSessions: () => [{ id: 's1', title: 'A 的会话', suspendable: true }],
      suspendSession: id => { suspended.push(id); return { ok: true }; },
    });
    const b = createSessionManifestExchange({ diagnosticsDir: dir, pid: 222, describeSessions: () => [] });
    a.start();
    try {
      const manifests = readManifests(dir);
      assert.equal(manifests.get(111).sessions[0].title, 'A 的会话');
      const result = await b.requestRemoteSuspend(111, 's1', { timeoutMs: 4_000, pollMs: 100 });
      assert.equal(result.ok, true);
      assert.equal(result.handledBy, 111);
      assert.deepEqual(suspended, ['s1']);
    } finally { a.stop(); }
    assert.equal(readManifests(dir).has(111), false, 'stop removes the manifest');
    const late = await b.requestRemoteSuspend(111, 's1', { timeoutMs: 600, pollMs: 100 });
    assert.equal(late.error, 'remote-timeout');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('execute re-scans, verifies pid + start time and only acts on still-eligible items', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-exec-'));
  try {
    let snap = fixture();
    const handlers = {};
    const killed = [];
    const suspended = [];
    const sessionManager = {
      listLivePtyPids: () => [200, 300],
      describeSessionsForMemory: () => manifest.sessions,
      suspendSession: id => { suspended.push(id); return { ok: true }; },
    };
    const api = registerMemoryReleaseIpc({ handle: (name, fn) => { handlers[name] = fn; } }, {
      dataDir: dir,
      inspector: { snapshot: async () => snap },
      exchange: {
        writeManifest() {}, readManifests: () => new Map(), snapshot: () => ({ ...manifest }),
        requestRemoteSuspend: async () => ({ ok: false, error: 'unexpected' }),
      },
      getSessionManager: () => sessionManager,
      processRef: { pid: 100, kill: () => {} },
      killProcess: pid => killed.push(pid),
      os: { totalmem: () => 32 * 1024 * MB, freemem: () => 4 * 1024 * MB },
      delay: async () => {},
      logger: { warn() {} },
    });
    const plan = await handlers['get-memory-release-plan']();
    assert.ok(plan.items.find(i => i.key === 'orphan:500:1500'));

    // 执行前 orphan 500 被 PID 复用（启动时间变了）→ 不再是同一个项，跳过。
    snap = fixture();
    snap.byPid.get(500).startedAt = 99_999;
    const result = await api.execute(['orphan:500:1500', 'session:100:s-a', 'session:100:s-b']);
    const byKey = Object.fromEntries(result.results.map(r => [r.key, r]));
    assert.equal(byKey['orphan:500:1500'].ok, false);
    assert.equal(byKey['session:100:s-a'].ok, true);
    assert.equal(byKey['session:100:s-b'].ok, false, 'running session is never suspended');
    assert.deepEqual(killed, []);
    assert.deepEqual(suspended, ['s-a']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
