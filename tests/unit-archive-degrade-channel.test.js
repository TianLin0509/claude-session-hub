'use strict';
// P1-3：归档流程里的降级必须能到 UI，不能只写 main 进程 console。
//
// 背景：codex rollout 找不到 / 被锁 / 首行不是 session_meta 时，旧代码只
// console.warn 然后照样 return { ok: true }。桌面图标启动的 Hub 没有终端窗口，
// 那些日志等于不存在 —— 用户看到「归档成功」，随后那个 codex 成员 resume 时
// 弹目录选择菜单永久卡住，正是代码注释里说要避免的「在线但永远不说话的成员」。
//
// 这个测试真的跑 registerWorkspaceIpc + 真的搬目录，断言的是行为：
//   1. 每一条降级都必须出现在推给 renderer 的 workspace-archive-warning 里；
//   2. 同样的信息必须出现在返回值 warnings 里（不依赖事件时序）；
//   3. 归档本身成功时不许因为降级就整体失败；
//   4. 后半程 throw（CLI 重连失败）不能把已经产生的降级信息一起吃掉。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceService } = require('../core/workspace-service.js');
const { registerWorkspaceIpc } = require('../main/ipc/workspace-handlers.js');

const CODEX_SID = '11111111-1111-4111-8111-111111111111';
const DORMANT_CODEX_SID = '22222222-2222-4222-8222-222222222222';
const MISSING_CC_SID = '33333333-3333-4333-8333-333333333333';

function buildHarness(tempRoot, name, opts = {}) {
  const workspaceRoot = path.join(tempRoot, name, 'Vibe');
  const dataDir = path.join(tempRoot, name, 'hub-data');
  const toolsDir = path.join(workspaceRoot, 'Tools');
  // codex rollout 根目录刻意留空 → migrateCodexSession 必然 { ok: false }。
  const codexRoot = path.join(tempRoot, name, 'codex-sessions');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });

  const workspaceService = new WorkspaceService({
    getHubDataDir: () => dataDir,
    isIsolatedHub: () => true,
    workspaceRoot,
    initGit: () => true,
    logger: { warn() {}, error() {} },
    randomId: () => 'draft1',
  });
  const scratch = workspaceService.createScratchWorkspace({ label: '降级通道验证' });
  workspaceService.updateSuggestedName(scratch.path, '降级通道验证');

  const sessions = new Map([
    ['codex-live', {
      id: 'codex-live', kind: 'codex', title: 'Codex 成员', cwd: scratch.path,
      codexSid: CODEX_SID, codexSessionsRoot: codexRoot,
    }],
    ['claude-live', {
      id: 'claude-live', kind: 'claude', title: 'Claude 成员', cwd: scratch.path,
      ccSessionId: MISSING_CC_SID,
    }],
  ]);
  const persisted = [{
    hubId: 'codex-dormant',
    kind: 'codex',
    title: '休眠 Codex',
    cwd: scratch.path,
    codexSid: DORMANT_CODEX_SID,
    codexSessionsRoot: codexRoot,
  }];

  const events = [];
  const handlers = new Map();
  registerWorkspaceIpc({ handle(channel, fn) { handlers.set(channel, fn); } }, {
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    meetingManager: { getMeeting: () => null, getAllMeetings: () => [] },
    resumeSession: async (meta) => {
      if (opts.failResumeFor && opts.failResumeFor.includes(meta.hubId)) {
        throw new Error('PTY spawn 失败（模拟）');
      }
      const resumed = { ...meta, id: meta.hubId };
      sessions.set(resumed.id, resumed);
      return resumed;
    },
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sessionManager: {
      getSession: id => sessions.get(id),
      getAllSessions: () => [...sessions.values()],
      closeSession(id) { sessions.delete(id); },
    },
    shell: { openPath: async () => '' },
    workspaceMigrationSessionIds: new Set(),
    workspaceService,
    getLastPersistedSessions: () => persisted,
  });

  return { handlers, events, scratch, toolsDir };
}

function pushedWarnings(events) {
  return events.filter(item => item.channel === 'workspace-archive-warning').map(item => item.payload);
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-archive-degrade-'));
  // transcript 查找默认读 USERPROFILE/HOME，指到空的临时目录才能确定性地拿到 missing，
  // 同时避免扫用户真实的 ~/.claude/projects。
  const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const fakeHome = path.join(tempRoot, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  try {
    // --- 场景 1：归档成功，但 codex / transcript / 休眠会话都降级了 ---
    const ok = buildHarness(tempRoot, 'case-ok');
    const result = await ok.handlers.get('workspace:archive-and-restart')(null, {
      scope: 'session', id: 'codex-live', parent: ok.toolsDir, folderName: 'degrade-ok',
    });

    assert.equal(result.ok, true, '降级不该让归档整体失败');
    assert.ok(Array.isArray(result.warnings), '返回值必须带 warnings 数组');
    assert.ok(result.warnings.length >= 3,
      `codex(live) + transcript(missing) + codex(dormant) 至少 3 条，实际 ${result.warnings.length}`);

    const stages = new Set(result.warnings.map(item => item.stage));
    assert.ok(stages.has('codex'), 'codex rollout 迁移失败必须进 warnings');
    assert.ok(stages.has('transcript'), 'transcript 缺失必须进 warnings');

    for (const warning of result.warnings) {
      assert.equal(warning.scope, 'session');
      assert.equal(warning.id, 'codex-live');
      assert.ok(warning.message && warning.message.length > 0, 'warning 必须带可读文案');
    }

    // 核心断言：每一条 warning 都真的被推给了 renderer，没有只落 console 的分支。
    const pushed = pushedWarnings(ok.events);
    assert.equal(pushed.length, result.warnings.length,
      '推给 renderer 的降级条数必须与返回值一致 —— 少一条就是又出现了 console-only 分支');
    const key = item => `${item.stage}|${item.target}|${item.message}`;
    assert.deepEqual(
      pushed.map(key).sort(),
      result.warnings.map(key).sort(),
      '推送内容必须与返回值逐条一致',
    );

    // 旧字段仍然可用（历史上没人读，但不做破坏性移除）。
    assert.ok(Array.isArray(result.codexWarnings));
    assert.equal(result.codexWarnings.length, result.warnings.filter(w => w.stage === 'codex').length);

    // --- 场景 2：后半程 CLI 重连失败会 throw，降级信息不能跟着返回值一起丢 ---
    const boom = buildHarness(tempRoot, 'case-throw', { failResumeFor: ['codex-live', 'claude-live'] });
    await assert.rejects(
      boom.handlers.get('workspace:archive-and-restart')(null, {
        scope: 'session', id: 'codex-live', parent: boom.toolsDir, folderName: 'degrade-throw',
      }),
      /部分 CLI 重连失败/,
    );
    const pushedBeforeThrow = pushedWarnings(boom.events);
    assert.ok(pushedBeforeThrow.length >= 3,
      'throw 之前产生的降级必须已经推给 renderer（返回值这时候已经拿不到了）');
    assert.ok(pushedBeforeThrow.some(item => item.stage === 'codex'),
      'throw 路径同样要能看到 codex 降级');

    console.log('unit-archive-degrade-channel: PASS');
  } finally {
    if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedHome.USERPROFILE;
    if (savedHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome.HOME;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
