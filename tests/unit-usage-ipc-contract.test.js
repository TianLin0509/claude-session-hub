'use strict';

const assert = require('assert');
const { registerUsageIpc } = require('../main/ipc/usage-handlers.js');

const handlers = new Map();
const calls = [];
let cacheState = { codex: { usage5h: { pct: 29 }, usage7d: { pct: 7 } } };
const ipcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn);
  },
};

registerUsageIpc(ipcMain, {
  clearCodexJsonlCache() {
    calls.push(['clearCodexJsonlCache']);
  },
  loadUsageCacheForCurrentConfig() {
    calls.push(['loadUsageCacheForCurrentConfig']);
    return cacheState;
  },
  refreshClaudeAccountUsage() {
    calls.push(['refreshClaudeAccountUsage']);
    return {
      data: { usage5h: { pct: 96 }, usage7d: { pct: 54 } },
      changed: false,
      observedAt: 1234,
      source: 'statusline-cache',
    };
  },
  async refreshCodexAccountUsage() {
    calls.push(['refreshCodexAccountUsage']);
    const live = {
      usage5h: { pct: 7 },
      usage7d: { pct: 1 },
      observedAt: 5678,
      source: 'app-server',
    };
    cacheState = { ...cacheState, codex: live };
    return live;
  },
  async refreshKimiAccountUsage() {
    calls.push(['refreshKimiAccountUsage']);
    const live = {
      usage5h: { pct: 67, label: '5h' },
      usage7d: { pct: 13, label: '周' },
      observedAt: 6789,
      source: 'kimi-api',
    };
    cacheState = { ...cacheState, kimi: live };
    return live;
  },
  scanAgentSessions(opts) {
    calls.push(['scanAgentSessions', opts]);
    return { codex: { usage5h: { pct: 29 }, usage7d: { pct: 7 }, source: 'jsonl' } };
  },
});

assert.ok(handlers.has('get-usage-cache'));
assert.ok(handlers.has('refresh-usage-now'));
assert.ok(!handlers.has('refresh-packy-account'));

(async () => {
  const cache = await handlers.get('get-usage-cache')();
  assert.strictEqual(cache.codex.usage5h.pct, 29);

  const refreshed = await handlers.get('refresh-usage-now')();
  assert.strictEqual(refreshed.cache.codex.usage7d.pct, 1);
  assert.strictEqual(refreshed.agentData.codex.source, 'app-server');
  assert.deepStrictEqual(refreshed.providerResults.codex, {
    ok: true,
    changed: true,
    mode: 'live',
    source: 'app-server',
    observedAt: 5678,
  });
  assert.deepStrictEqual(refreshed.providerResults.claude, {
    ok: true,
    changed: false,
    mode: 'snapshot',
    source: 'statusline-cache',
    observedAt: 1234,
  });
  assert.deepStrictEqual(refreshed.providerResults.kimi, {
    ok: true,
    changed: true,
    mode: 'live',
    source: 'kimi-api',
    observedAt: 6789,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(refreshed, 'packyAccount'));
  assert.ok(typeof refreshed.refreshedAt === 'number');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'clearCodexJsonlCache'), []);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'refreshClaudeAccountUsage'), [['refreshClaudeAccountUsage']]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'refreshCodexAccountUsage'), [['refreshCodexAccountUsage']]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'refreshKimiAccountUsage'), [['refreshKimiAccountUsage']]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'scanAgentSessions'), []);

  const fallbackHandlers = new Map();
  const fallbackCalls = [];
  registerUsageIpc({ handle(channel, fn) { fallbackHandlers.set(channel, fn); } }, {
    clearCodexJsonlCache() { fallbackCalls.push('clear'); },
    loadUsageCacheForCurrentConfig() { return {}; },
    refreshClaudeAccountUsage() { return null; },
    async refreshCodexAccountUsage() { throw new Error('app-server unavailable'); },
    scanAgentSessions(opts) {
      fallbackCalls.push(['scan', opts]);
      return { codex: { usage5h: { pct: 31 }, usage7d: { pct: 9 }, source: 'jsonl', observedAt: 999 } };
    },
  });
  const fallback = await fallbackHandlers.get('refresh-usage-now')();
  assert.strictEqual(fallback.agentData.codex.source, 'jsonl');
  assert.strictEqual(fallback.providerResults.codex.ok, true);
  assert.strictEqual(fallback.providerResults.codex.degraded, true);
  assert.strictEqual(fallback.providerResults.codex.error, 'app-server unavailable');
  assert.deepStrictEqual(fallbackCalls, ['clear', ['scan', { force: true }]]);

  const unavailableHandlers = new Map();
  registerUsageIpc({ handle(channel, fn) { unavailableHandlers.set(channel, fn); } }, {
    clearCodexJsonlCache() {},
    loadUsageCacheForCurrentConfig() { return {}; },
    refreshClaudeAccountUsage() { return null; },
    async refreshCodexAccountUsage() { throw new Error('offline'); },
    scanAgentSessions() {
      return { codex: { usage5h: null, usage7d: null, unavailable: true, source: 'jsonl' } };
    },
  });
  const unavailable = await unavailableHandlers.get('refresh-usage-now')();
  assert.strictEqual(unavailable.providerResults.codex.ok, false,
    'an unavailable placeholder must not be reported as a successful fallback');

  const racingHandlers = new Map();
  const oldClaude = {
    usage5h: { pct: 10 },
    usage7d: { pct: 20 },
    observedAt: 100,
  };
  const newClaude = {
    usage5h: { pct: 11 },
    usage7d: { pct: 21 },
    observedAt: 200,
  };
  let racingCache = { claude: oldClaude };
  registerUsageIpc({ handle(channel, fn) { racingHandlers.set(channel, fn); } }, {
    loadUsageCacheForCurrentConfig() { return racingCache; },
    refreshClaudeAccountUsage() {
      return { data: oldClaude, changed: false, observedAt: 100, source: 'statusline-cache' };
    },
    async refreshCodexAccountUsage() {
      const codex = { usage5h: { pct: 5 }, usage7d: { pct: 1 }, observedAt: 300, source: 'app-server' };
      racingCache = { claude: newClaude, codex };
      return codex;
    },
  });
  const racing = await racingHandlers.get('refresh-usage-now')();
  assert.strictEqual(racing.cache.claude.usage5h.pct, 11);
  assert.strictEqual(racing.providerResults.claude.changed, true,
    'Claude status must be recomputed when its cache advances while Codex refresh is pending');
  assert.strictEqual(racing.providerResults.claude.observedAt, 200);

  console.log('unit-usage-ipc-contract OK');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
