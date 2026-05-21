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

test('resend prompt validates args and delegates active prompt', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  const orch = {
    state: { currentTurn: 2, currentMode: 'debate' },
    getActivePrompt(turnNum) {
      calls.push(['getActivePrompt', turnNum]);
      return { promptBy: { s1: 'prompt text' } };
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
    ['getActivePrompt', 2],
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

test('resend prompt preserves negative and exception responses', async () => {
  const ipc = createFakeIpc();
  const errors = [];
  const orch = {
    state: { currentTurn: 2, currentMode: 'debate' },
    getActivePrompt: () => ({ promptBy: { s1: 'prompt text' } }),
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
  assert.deepStrictEqual(await handler(null, { meetingId: 'm1', sid: 'missing' }), { ok: false, reason: 'no_active_prompt' });

  orch.getActivePrompt = () => ({ promptBy: { missing: 'prompt text' } });
  assert.deepStrictEqual(await handler(null, { meetingId: 'm1', sid: 'missing' }), {
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
