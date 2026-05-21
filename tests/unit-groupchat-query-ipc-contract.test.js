'use strict';

const assert = require('assert');
const {
  registerGroupchatQueryIpc,
  snapshotDebug,
} = require('../main/ipc/groupchat-query-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function createFakeDeps() {
  const calls = [];
  const orch = {
    getState() {
      calls.push(['getState']);
      return { currentTurn: 3 };
    },
    searchRaw(query, limit) {
      calls.push(['searchRaw', query, limit]);
      return [{ id: 'raw-1', text: query, limit }];
    },
    readRaw(messageId) {
      calls.push(['readRaw', messageId]);
      return { id: messageId, text: 'raw body' };
    },
  };
  const deps = {
    calls,
    getHubDataDir() {
      calls.push(['getHubDataDir']);
      return 'C:\\hub-data';
    },
    groupchat: {
      getOrchestrator(hubDataDir, meetingId) {
        calls.push(['getOrchestrator', hubDataDir, meetingId]);
        return orch;
      },
    },
    transcriptTap: {
      getCodexDebugSnapshot() {
        calls.push(['getCodexDebugSnapshot']);
        return { pending: ['codex-1'] };
      },
      getGeminiDebugSnapshot() {
        calls.push(['getGeminiDebugSnapshot']);
        return { pending: ['gemini-1'] };
      },
    },
  };
  return deps;
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

console.log('Running groupchat query IPC contract tests...');

test('registers expected query and debug channels', () => {
  const ipc = createFakeIpc();
  registerGroupchatQueryIpc(ipc, createFakeDeps());

  for (const channel of [
    'groupchat:get-state',
    'groupchat:search-raw',
    'groupchat:read-raw',
    'groupchat-codex-debug-state',
    'groupchat-gemini-debug-state',
  ]) {
    assert.ok(ipc.handlers.has(channel), `${channel} should be registered`);
  }
});

test('groupchat:get-state delegates to the meeting orchestrator', () => {
  const ipc = createFakeIpc();
  const deps = createFakeDeps();
  registerGroupchatQueryIpc(ipc, deps);

  const state = ipc.handlers.get('groupchat:get-state')(null, { meetingId: 'm1' });

  assert.deepStrictEqual(state, { currentTurn: 3 });
  assert.deepStrictEqual(deps.calls, [
    ['getHubDataDir'],
    ['getOrchestrator', 'C:\\hub-data', 'm1'],
    ['getState'],
  ]);
});

test('raw search and read preserve existing argument order', () => {
  const ipc = createFakeIpc();
  const deps = createFakeDeps();
  registerGroupchatQueryIpc(ipc, deps);

  const search = ipc.handlers.get('groupchat:search-raw')(null, { meetingId: 'm2', query: 'hello', limit: 7 });
  const read = ipc.handlers.get('groupchat:read-raw')(null, { meetingId: 'm2', messageId: 'raw-2' });

  assert.deepStrictEqual(search, [{ id: 'raw-1', text: 'hello', limit: 7 }]);
  assert.deepStrictEqual(read, { id: 'raw-2', text: 'raw body' });
  assert.deepStrictEqual(deps.calls, [
    ['getHubDataDir'],
    ['getOrchestrator', 'C:\\hub-data', 'm2'],
    ['searchRaw', 'hello', 7],
    ['getHubDataDir'],
    ['getOrchestrator', 'C:\\hub-data', 'm2'],
    ['readRaw', 'raw-2'],
  ]);
});

test('debug handlers return codex and gemini snapshots', async () => {
  const ipc = createFakeIpc();
  const deps = createFakeDeps();
  registerGroupchatQueryIpc(ipc, deps);

  const codex = await ipc.handlers.get('groupchat-codex-debug-state')();
  const gemini = await ipc.handlers.get('groupchat-gemini-debug-state')();

  assert.deepStrictEqual(codex, { ok: true, snapshot: { pending: ['codex-1'] } });
  assert.deepStrictEqual(gemini, { ok: true, snapshot: { pending: ['gemini-1'] } });
});

test('snapshotDebug preserves the existing failure shape', () => {
  const result = snapshotDebug(() => {
    throw new Error('tap unavailable');
  });

  assert.deepStrictEqual(result, {
    ok: false,
    reason: 'snapshot_failed',
    detail: 'tap unavailable',
  });
});
