'use strict';

const assert = require('assert');
const { registerUsageIpc } = require('../main/ipc/usage-handlers.js');

const handlers = new Map();
const calls = [];
const ipcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn);
  },
};

registerUsageIpc(ipcMain, {
  clearCodexJsonlCache() {
    calls.push(['clearCodexJsonlCache']);
  },
  fetchAndCachePackyAccount() {
    calls.push(['fetchAndCachePackyAccount']);
    return Promise.resolve({ enabled: true });
  },
  loadUsageCacheForCurrentConfig() {
    calls.push(['loadUsageCacheForCurrentConfig']);
    return { codex: { usage5h: { pct: 29 }, usage7d: { pct: 7 } } };
  },
  refreshClaudeAccountUsage() {
    calls.push(['refreshClaudeAccountUsage']);
    return { usage5h: { pct: 96 }, usage7d: { pct: 54 } };
  },
  scanAgentSessions(opts) {
    calls.push(['scanAgentSessions', opts]);
    return { codex: { usage5h: { pct: 29 }, usage7d: { pct: 7 }, source: 'jsonl' } };
  },
});

assert.ok(handlers.has('get-usage-cache'));
assert.ok(handlers.has('refresh-usage-now'));
assert.ok(handlers.has('refresh-packy-account'));

(async () => {
  const cache = await handlers.get('get-usage-cache')();
  assert.strictEqual(cache.codex.usage5h.pct, 29);

  const refreshed = await handlers.get('refresh-usage-now')();
  assert.strictEqual(refreshed.cache.codex.usage7d.pct, 7);
  assert.strictEqual(refreshed.agentData.codex.source, 'jsonl');
  assert.strictEqual(refreshed.packyAccount.enabled, true);
  assert.ok(typeof refreshed.refreshedAt === 'number');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'fetchAndCachePackyAccount'), [['fetchAndCachePackyAccount']]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'clearCodexJsonlCache'), [['clearCodexJsonlCache']]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'refreshClaudeAccountUsage'), [['refreshClaudeAccountUsage']]);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'scanAgentSessions'), [
    ['scanAgentSessions', { force: true }],
  ]);

  const packy = await handlers.get('refresh-packy-account')();
  assert.strictEqual(packy.enabled, true);
  assert.strictEqual(calls.filter(c => c[0] === 'fetchAndCachePackyAccount').length, 2);

  console.log('unit-usage-ipc-contract OK');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
