'use strict';

const assert = require('assert');
const { registerArchiveIpc } = require('../main/ipc/archive-handlers.js');

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

console.log('Running archive IPC contract tests...');

test('list-past-sessions delegates limit and returns archive items', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  registerArchiveIpc(ipc, {
    sessionArchive: {
      async listRecent(limit) {
        calls.push(['listRecent', limit]);
        return [{ sessionId: 'a' }];
      },
      async searchAcross() {
        throw new Error('unexpected');
      },
    },
    logger: { warn() {} },
  });

  const result = await ipc.handlers.get('list-past-sessions')(null, { limit: 12 });

  assert.deepStrictEqual(calls, [['listRecent', 12]]);
  assert.deepStrictEqual(result, [{ sessionId: 'a' }]);
});

test('search-past-sessions delegates query and limit', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  registerArchiveIpc(ipc, {
    sessionArchive: {
      async listRecent() {
        throw new Error('unexpected');
      },
      async searchAcross(query, opts) {
        calls.push(['searchAcross', query, opts]);
        return { hits: [{ sessionId: 'b' }], truncated: true };
      },
    },
    logger: { warn() {} },
  });

  const result = await ipc.handlers.get('search-past-sessions')(null, { query: 'hello', limit: 7 });

  assert.deepStrictEqual(calls, [['searchAcross', 'hello', { limit: 7 }]]);
  assert.deepStrictEqual(result, { hits: [{ sessionId: 'b' }], truncated: true });
});

test('unified search IPC passes the live snapshot and exposes preview/status/refresh', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  const snapshot = { sessions: [{ hubId: 'hub-1' }], meetings: [{ id: 'meeting-1' }] };
  registerArchiveIpc(ipc, {
    sessionArchive: { async listRecent() { return []; }, async searchAcross() { throw new Error('legacy path must not run'); } },
    searchService: {
      async search(request, receivedSnapshot) {
        calls.push(['search', request, receivedSnapshot]);
        return { results: [{ sessionKey: 'codex:1' }], totalSessions: 1 };
      },
      async preview(request) { calls.push(['preview', request]); return { session: { key: request.sessionKey } }; },
      async status() { calls.push(['status']); return { phase: 'ready', ready: true }; },
      async refresh(receivedSnapshot, opts) { calls.push(['refresh', receivedSnapshot, opts]); return { phase: 'ready' }; },
    },
    getSearchSnapshot: () => snapshot,
    logger: { warn() {} },
  });

  const search = await ipc.handlers.get('search-past-sessions')(null, { query: '公式', providers: ['codex'] });
  const preview = await ipc.handlers.get('get-session-search-preview')(null, { sessionKey: 'codex:1', eventId: 'a1' });
  const status = await ipc.handlers.get('get-session-search-status')();
  const refresh = await ipc.handlers.get('refresh-session-search')(null, { force: true });

  assert.equal(search.totalSessions, 1);
  assert.equal(preview.session.key, 'codex:1');
  assert.equal(status.ready, true);
  assert.equal(refresh.phase, 'ready');
  assert.deepStrictEqual(calls, [
    ['search', { query: '公式', providers: ['codex'] }, snapshot],
    ['preview', { sessionKey: 'codex:1', eventId: 'a1' }],
    ['status'],
    ['refresh', snapshot, { force: true }],
  ]);
});

test('archive handlers preserve fallback values on errors', async () => {
  const ipc = createFakeIpc();
  const warnings = [];
  registerArchiveIpc(ipc, {
    sessionArchive: {
      async listRecent() {
        throw new Error('list failed');
      },
      async searchAcross() {
        throw new Error('search failed');
      },
    },
    logger: { warn: (...args) => warnings.push(args) },
  });

  const list = await ipc.handlers.get('list-past-sessions')(null, {});
  const search = await ipc.handlers.get('search-past-sessions')(null, {});

  assert.deepStrictEqual(list, []);
  assert.deepStrictEqual(search, { hits: [], truncated: false });
  assert.strictEqual(warnings.length, 2);
});

process.on('beforeExit', () => {
  if (!process.exitCode) console.log('All archive IPC contract tests passed.');
});
