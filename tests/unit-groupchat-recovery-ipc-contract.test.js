'use strict';

const assert = require('assert');
const { registerGroupchatRecoveryIpc } = require('../main/ipc/groupchat-recovery-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((err) => {
      console.error(`  FAIL ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

console.log('Running groupchat recovery IPC contract tests...');

test('registers recovery channels', () => {
  const ipc = createFakeIpc();
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: {},
    groupChatWatcher: {},
    meetingManager: {},
    sessionManager: {},
  });

  assert.ok(ipc.handlers.has('groupchat-resend-prompt'));
  assert.ok(ipc.handlers.has('groupchat-manual-extract'));
  assert.ok(ipc.handlers.has('groupchat-skip-participant'));
  assert.ok(ipc.handlers.has('groupchat-resend-participant'));
});

test('manual extract settles active watcher with transcript text', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  const watchers = new Map([
    ['s1', { manualExtract: (text) => calls.push(['manualExtract', text]) }],
  ]);
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => watchers,
    getHubDataDir: () => 'C:\\hub',
    groupchat: {},
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: {},
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'answer', source: 'transcript', extractMode: 'task_complete' }) },
  });

  const result = await ipc.handlers.get('groupchat-manual-extract')(null, { sid: 's1', sincePromptTs: 123 });

  assert.deepStrictEqual(result, {
    ok: true,
    text: 'answer',
    source: 'transcript',
    mode: 'watcher_settle',
    extractMode: 'task_complete',
  });
  assert.deepStrictEqual(calls, [['manualExtract', 'answer']]);
});

test('manual extract patches settled groupchat turn and emits update', async () => {
  const ipc = createFakeIpc();
  const emitted = [];
  const calls = [];
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: {
      getOrchestrator(root, meetingId) {
        calls.push(['getOrchestrator', root, meetingId]);
        return {
          state: { turns: [{ n: 1 }, { n: 2 }] },
          patchTurnResult(turnNum, sid, fields) {
            calls.push(['patchTurnResult', turnNum, sid, fields]);
            return true;
          },
        };
      },
    },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (meetingId) => ({ id: meetingId }) },
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
    sessionManager: { getSession: () => ({ kind: 'claude' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'manual text', source: 'transcript' }) },
  });

  const result = await ipc.handlers.get('groupchat-manual-extract')(null, {
    meetingId: 'm1',
    sid: 's1',
    turnNum: 2,
  });

  assert.deepStrictEqual(result, {
    ok: true,
    text: 'manual text',
    source: 'transcript',
    mode: 'patch_groupchat_turn',
    extractMode: null,
  });
  assert.deepStrictEqual(calls, [
    ['getOrchestrator', 'C:\\hub', 'm1'],
    ['patchTurnResult', 2, 's1', { text: 'manual text', status: 'manual_extracted' }],
  ]);
  assert.deepStrictEqual(emitted, [['groupchat-turn-patched', {
    meetingId: 'm1',
    turnNum: 2,
    sid: 's1',
    charCount: 11,
  }]]);
});

test('manual extract falls back to PTY text and explains no-content modes', async () => {
  const ipc = createFakeIpc();
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: {},
    groupChatWatcher: { extractStreamingText: () => ({ text: 'pty text', source: 'pty' }) },
    meetingManager: {},
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: '', extractMode: 'no_task_complete_yet' }) },
  });

  const pty = await ipc.handlers.get('groupchat-manual-extract')(null, { sid: 's1' });
  assert.deepStrictEqual(pty, {
    ok: true,
    text: 'pty text',
    source: 'pty',
    mode: 'text_only',
    extractMode: 'pty_buffer_fallback',
  });

  const ipcNoContent = createFakeIpc();
  registerGroupchatRecoveryIpc(ipcNoContent, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: {},
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: {},
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: '', extractMode: 'no_task_complete_yet' }) },
  });

  const noContent = await ipcNoContent.handlers.get('groupchat-manual-extract')(null, { sid: 's1' });
  assert.strictEqual(noContent.ok, false);
  assert.strictEqual(noContent.reason, 'no_content');
  assert.strictEqual(noContent.extractMode, 'no_task_complete_yet');
  assert.ok(noContent.detail.includes('task_complete'));
});

// --- 2026-07-12 道雪：手动同步轮次守卫 + 诚实失败回归 ---

test('old-turn resync must not hijack the in-flight watcher and derives window from orchestrator state', async () => {
  const ipc = createFakeIpc();
  const watcherCalls = [];
  const patchCalls = [];
  const extractArgs = [];
  const watchers = new Map([
    ['s1', { manualExtract: (text) => watcherCalls.push(text) }],
  ]);
  const orch = {
    state: {
      currentTurn: 6,
      messages: [
        { id: 'u5', role: 'user', turnNum: 5, createdAt: 5000 },
        { id: 'a5-m1', role: 'assistant', turnNum: 5, sid: 's1', createdAt: 5500 },
        { id: 'u6', role: 'user', turnNum: 6, createdAt: 9000 },
      ],
      turns: [{ n: 5 }, { n: 6 }],
    },
    patchTurnResult(turnNum, sid, fields) {
      patchCalls.push([turnNum, sid, fields]);
      return { n: turnNum };
    },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => watchers,
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (id) => ({ id }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: {
      extractLatestTurn: async (sid, since, opts) => {
        extractArgs.push([sid, since, opts]);
        return { text: 'turn5 recovered', source: 'transcript', extractMode: 'final_answer' };
      },
    },
  });

  // 用户点第 5 轮的「重新提取」，此刻第 6 轮 watcher 还在飞行
  const result = await ipc.handlers.get('groupchat-manual-extract')(null, {
    meetingId: 'm1', sid: 's1', turnNum: 5, sincePromptTs: 999999,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mode, 'patch_groupchat_turn', '旧轮同步必须 patch，不得 settle 当前 watcher');
  assert.deepStrictEqual(watcherCalls, [], '飞行中的第 6 轮 watcher 不能被旧轮文本结算');
  assert.deepStrictEqual(patchCalls, [[5, 's1', { text: 'turn5 recovered', status: 'manual_extracted' }]]);
  // 窗口来自 orchestrator：since=u5.createdAt(5000)，until=u6.createdAt(9000)，
  // renderer 传的 sincePromptTs=999999（当前轮）被无视
  assert.deepStrictEqual(extractArgs, [['s1', 5000, { untilTs: 9000 }]]);
});

test('current-turn manual extract still settles the active watcher', async () => {
  const ipc = createFakeIpc();
  const watcherCalls = [];
  const watchers = new Map([
    ['s1', { manualExtract: (text) => watcherCalls.push(text) }],
  ]);
  const orch = {
    state: {
      currentTurn: 6,
      messages: [{ id: 'u6', role: 'user', turnNum: 6, createdAt: 9000 }],
      turns: [{ n: 6 }],
    },
    patchTurnResult() { throw new Error('should not patch when watcher settles'); },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => watchers,
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (id) => ({ id }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'turn6 text', source: 'transcript', extractMode: 'final_answer' }) },
  });

  const result = await ipc.handlers.get('groupchat-manual-extract')(null, {
    meetingId: 'm1', sid: 's1', turnNum: 6,
  });
  assert.strictEqual(result.mode, 'watcher_settle');
  assert.deepStrictEqual(watcherCalls, ['turn6 text']);
});

test('old-turn resync on non-codex backends is honestly rejected', async () => {
  const ipc = createFakeIpc();
  const orch = {
    state: {
      currentTurn: 6,
      messages: [
        { id: 'u5', role: 'user', turnNum: 5, createdAt: 5000 },
        { id: 'u6', role: 'user', turnNum: 6, createdAt: 9000 },
      ],
      turns: [{ n: 5 }, { n: 6 }],
    },
    patchTurnResult() { throw new Error('must not patch'); },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (id) => ({ id }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'claude' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'latest claude answer', source: 'transcript' }) },
  });

  const result = await ipc.handlers.get('groupchat-manual-extract')(null, {
    meetingId: 'm1', sid: 's1', turnNum: 5,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'old_turn_resync_unsupported', 'claude transcript 只能读最新轮，旧轮重提取要诚实拒绝');
});

test('groupchat manual extract reports turn_not_found instead of fake text_only success', async () => {
  const ipc = createFakeIpc();
  const orch = {
    state: { currentTurn: 2, messages: [], turns: [] },
    patchTurnResult() { return null; },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (id) => ({ id }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'some text', source: 'transcript' }) },
  });

  const result = await ipc.handlers.get('groupchat-manual-extract')(null, {
    meetingId: 'm1', sid: 's1', turnNum: 2,
  });
  assert.strictEqual(result.ok, false, '群聊内提取成功但写不回去 = 失败，不得假报"已同步"');
  assert.strictEqual(result.reason, 'turn_not_found');
  assert.ok(result.detail.includes('无法写回'));
});

test('manual extract recovers an in-flight turn when user message exists but final turn record does not', async () => {
  const ipc = createFakeIpc();
  const emitted = [];
  const patchCalls = [];
  const orch = {
    state: {
      currentTurn: 1,
      messages: [{ id: 'u1', role: 'user', turnNum: 1, createdAt: 1000, content: 'question' }],
      turns: [],
    },
    patchTurnResult(turnNum, sid, fields) {
      patchCalls.push([turnNum, sid, fields]);
      return { n: turnNum, inProgress: true };
    },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: () => ({ id: 'm1', subSessions: ['s1'] }) },
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
    sessionManager: { getSession: () => ({ kind: 'codex', title: 'Codex 1' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'usable answer', source: 'transcript', extractMode: 'final_answer' }) },
  });

  const result = await ipc.handlers.get('groupchat-manual-extract')(null, {
    meetingId: 'm1', sid: 's1', turnNum: 1,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mode, 'recover_inflight_turn');
  assert.deepStrictEqual(patchCalls, [[1, 's1', {
    text: 'usable answer',
    status: 'manual_extracted',
    memberId: 'm1',
    speaker: 'Codex 1',
  }]]);
  assert.strictEqual(emitted[0][0], 'groupchat-turn-patched');
});

test('meeting extract fails honestly when meeting/orchestrator state is unavailable', async () => {
  const ipc = createFakeIpc();
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map([['s1', { manualExtract: () => { throw new Error('must not settle'); } }]]),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => { throw new Error('state file corrupted'); } },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: () => ({ id: 'm1' }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: 'text', source: 'transcript' }) },
  });
  const result = await ipc.handlers.get('groupchat-manual-extract')(null, { meetingId: 'm1', sid: 's1', turnNum: 3 });
  assert.strictEqual(result.ok, false, '群聊状态不可用时不得假成功，也不得劫持 watcher');
  assert.strictEqual(result.reason, 'meeting_state_unavailable');
});

test('old-turn resync without the turn user message refuses instead of extracting with a wrong window', async () => {
  const ipc = createFakeIpc();
  const orch = {
    state: {
      currentTurn: 6,
      messages: [{ id: 'u6', role: 'user', turnNum: 6, createdAt: 9000 }],
      turns: [{ n: 5 }, { n: 6 }],
    },
    patchTurnResult() { throw new Error('must not patch'); },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (id) => ({ id }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: { extractLatestTurn: async () => ({ text: '别轮的内容', source: 'transcript' }) },
  });
  const result = await ipc.handlers.get('groupchat-manual-extract')(null, { meetingId: 'm1', sid: 's1', turnNum: 5 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'turn_window_unavailable', '旧轮窗口无法建立时诚实拒绝');
});

test('watcher settle re-reads currentTurn after extraction (preemption race guard)', async () => {
  const ipc = createFakeIpc();
  const watcherCalls = [];
  const patchCalls = [];
  const orch = {
    state: {
      currentTurn: 5,
      messages: [
        { id: 'u5', role: 'user', turnNum: 5, createdAt: 5000 },
      ],
      turns: [{ n: 5 }],
    },
    patchTurnResult(turnNum, sid, fields) { patchCalls.push([turnNum, sid, fields.status]); return { n: turnNum }; },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map([['s1', { manualExtract: (t) => watcherCalls.push(t) }]]),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: { extractStreamingText: () => null },
    meetingManager: { getMeeting: (id) => ({ id }) },
    sendToRenderer: () => {},
    sessionManager: { getSession: () => ({ kind: 'codex' }) },
    transcriptTap: {
      // 提取期间模拟"用户发了第 6 轮"（抢占）：currentTurn 前进
      extractLatestTurn: async () => {
        orch.state.currentTurn = 6;
        orch.state.messages.push({ id: 'u6', role: 'user', turnNum: 6, createdAt: 9000 });
        return { text: 'turn5 text', source: 'transcript' };
      },
    },
  });
  const result = await ipc.handlers.get('groupchat-manual-extract')(null, { meetingId: 'm1', sid: 's1', turnNum: 5 });
  assert.deepStrictEqual(watcherCalls, [], '提取期间被抢占：旧轮文本不得 settle 进新轮 watcher');
  assert.strictEqual(result.mode, 'patch_groupchat_turn', '改走 patch 指定轮');
  assert.deepStrictEqual(patchCalls, [[5, 's1', 'manual_extracted']]);
});

test('resend prompt sends latest-turn user input regardless of state', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  const orch = {
    // currentMode 'idle' = 整轮已结束，仍应能重发最新轮用户原话
    state: {
      currentTurn: 2,
      currentMode: 'idle',
      messages: [
        { id: 'u1', role: 'user', content: 'old turn' },
        { id: 'u2', role: 'user', content: 'prompt text' },
      ],
    },
  };
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: {
      getOrchestrator(root, meetingId) {
        calls.push(['getOrchestrator', root, meetingId]);
        return orch;
      },
    },
    groupChatWatcher: {
      async resendCurrentPrompt(args) {
        calls.push(['resendCurrentPrompt', args]);
        return { ok: true, sendStatus: 'auto_recovered' };
      },
    },
    meetingManager: {
      getMeeting(meetingId) {
        calls.push(['getMeeting', meetingId]);
        return { id: meetingId, groupChat: true };
      },
    },
    sessionManager: {
      getSession(sid) {
        calls.push(['getSession', sid]);
        return { id: sid, kind: 'claude' };
      },
    },
  });

  const invalid = await ipc.handlers.get('groupchat-resend-prompt')(null, { meetingId: 'm1' });
  const ok = await ipc.handlers.get('groupchat-resend-prompt')(null, { meetingId: 'm1', sid: 's1' });

  assert.deepStrictEqual(invalid, { ok: false, reason: 'invalid_args' });
  assert.deepStrictEqual(ok, { ok: true, sendStatus: 'auto_recovered' });
  assert.deepStrictEqual(calls, [
    ['getMeeting', 'm1'],
    ['getOrchestrator', 'C:\\hub', 'm1'],
    ['getSession', 's1'],
    ['resendCurrentPrompt', {
      sid: 's1',
      kind: 'claude',
      prompt: 'prompt text',
      promptHeader: '',
      timing: { ENTER_RETRY_GAP_MS: 150, POST_ENTER_VERIFY_MS: 500 },
    }],
  ]);
});

test('resend prompt handles missing input and exception responses', async () => {
  const ipc = createFakeIpc();
  const errors = [];
  const orch = {
    state: { currentTurn: 2, currentMode: 'idle', messages: [] },
  };
  const deps = {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: { getOrchestrator: () => orch },
    groupChatWatcher: {
      async resendCurrentPrompt() {
        throw new Error('pty failed');
      },
    },
    logger: { error: (...args) => errors.push(args) },
    meetingManager: { getMeeting: () => ({ groupChat: true }) },
    sessionManager: { getSession: () => null },
  };
  registerGroupchatRecoveryIpc(ipc, deps);

  const handler = ipc.handlers.get('groupchat-resend-prompt');
  // 最新轮没有用户输入消息 → no_user_input
  assert.deepStrictEqual(await handler(null, { meetingId: 'm1', sid: 's1' }), { ok: false, reason: 'no_user_input' });

  // 有输入但 PTY 发送抛异常 → exception 透传
  orch.state.messages = [{ id: 'u2', role: 'user', content: 'prompt text' }];
  assert.deepStrictEqual(await handler(null, { meetingId: 'm1', sid: 's1' }), {
    ok: false,
    reason: 'exception',
    detail: 'pty failed',
  });
  assert.strictEqual(errors.length, 1);
});

test('skip participant validates sid and active watcher', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  const watchers = new Map([
    ['s1', { skip: () => calls.push(['skip', 's1']) }],
  ]);
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => watchers,
    getHubDataDir: () => 'C:\\hub',
    groupchat: {},
    groupChatWatcher: {},
    meetingManager: {},
    sessionManager: {},
  });

  const missing = await ipc.handlers.get('groupchat-skip-participant')(null, {});
  const inactive = await ipc.handlers.get('groupchat-skip-participant')(null, { sid: 'missing' });
  const ok = await ipc.handlers.get('groupchat-skip-participant')(null, { sid: 's1' });

  assert.deepStrictEqual(missing, { ok: false, reason: 'missing sid' });
  assert.deepStrictEqual(inactive, { ok: false, reason: 'not_active' });
  assert.deepStrictEqual(ok, { ok: true });
  assert.deepStrictEqual(calls, [['skip', 's1']]);
});

test('resend participant keeps existing unsupported response', async () => {
  const ipc = createFakeIpc();
  registerGroupchatRecoveryIpc(ipc, {
    getActiveWatchers: () => new Map(),
    getHubDataDir: () => 'C:\\hub',
    groupchat: {},
    groupChatWatcher: {},
    meetingManager: {},
    sessionManager: {},
  });

  const result = await ipc.handlers.get('groupchat-resend-participant')();

  assert.deepStrictEqual(result, {
    ok: false,
    reason: 'unsupported',
    detail: 'group chat uses resend-prompt, manual extract, and skip recovery actions',
  });
});
