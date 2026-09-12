'use strict';
const assert = require('assert');
const { registerUsageIpc, hasDeepSeekBalanceData } = require('../main/ipc/usage-handlers');
const { createAccountUsageController } = require('../renderer/account-usage-controller');
const { remainingPercent, createSidebarAccountUsage } = require('../renderer/sidebar-account-usage');

async function main() {
  for (const [used, expected] of [[0, 100], [100, 0], [101, 0], [35, 65], [-1, null], [null, null], [NaN, null], ['5', null]]) {
    assert.strictEqual(remainingPercent({ pct: used }), expected);
  }
  for (const totalBalance of [null, undefined, '', ' ', false, Infinity]) {
    assert.strictEqual(hasDeepSeekBalanceData({ totalBalance, currency: 'CNY' }), false);
  }
  assert.strictEqual(hasDeepSeekBalanceData({ totalBalance: 0, currency: 'CNY' }), true);
  let cache = { claude: { usage5h: { pct: 10 }, observedAt: 100 },
    codex: { usage7d: { pct: 40 }, observedAt: 100 },
    deepseek: { totalBalance: 0, currency: 'CNY', observedAt: 100 } };
  const handlers = {}, calls = [];
  let resolveCodex, codexFailure = false, claudeMissing = false, scopeKey = 'account-a';
  registerUsageIpc({ handle: (id, fn) => { handlers[id] = fn; } }, {
    loadUsageCacheForCurrentConfig: () => cache,
    getCodexUsageScopeKey: () => scopeKey,
    refreshClaudeAccountUsage: () => { calls.push('claude'); return claudeMissing ? null : { data: cache.claude, observedAt: 100 }; },
    refreshCodexAccountUsage: async () => { calls.push('codex'); if (codexFailure) throw Error('timeout'); return new Promise(resolve => { resolveCodex = resolve; }); },
    refreshDeepSeekAccountBalance: () => { calls.push('deepseek'); return { ...cache.deepseek, observedAt: 200 }; },
    refreshKimiAccountUsage: () => { throw Error('must not refresh Kimi'); },
    clearCodexJsonlCache: () => { throw Error('must not clear unrelated cache'); },
    scanAgentSessions: () => { throw Error('must not scan all providers'); },
  });
  const invoke = provider => handlers['refresh-usage-now']({}, provider);
  for (const provider of ['all', '', null, {}, '__proto__']) await assert.rejects(invoke(provider), /不支持/);
  const before = JSON.stringify(cache);
  const first = invoke('codex'), duplicate = invoke('codex');
  const [claude, deepseek] = await Promise.all([invoke('claude'), invoke('deepseek')]);
  assert.deepStrictEqual(calls, ['codex', 'claude', 'deepseek']);
  assert.strictEqual(claude.providerResults.claude.fresh, false);
  assert.strictEqual(deepseek.providerResults.deepseek.fresh, true);
  assert.strictEqual(deepseek.cache.deepseek.totalBalance, 0);
  assert.deepStrictEqual(Object.keys(deepseek.cache), ['deepseek']);
  assert.deepStrictEqual(Object.keys(claude.providerResults), ['claude']);
  resolveCodex({ usage7d: { pct: 40 }, observedAt: 200 });
  const results = await Promise.all([first, duplicate]);
  assert.deepStrictEqual(results[0], results[1]);
  assert.strictEqual(results[0].providerResults.codex.changed, false);
  assert.strictEqual(results[0].providerResults.codex.fresh, true, 'same numeric value can be a new live observation');
  assert.strictEqual(JSON.stringify(cache), before);
  const switching = invoke('codex');
  scopeKey = 'account-b';
  resolveCodex({ usage7d: { pct: 99 }, observedAt: 300, scopeKey: 'account-a' });
  const switched = await switching;
  assert.strictEqual(switched.providerResults.codex.ok, false);
  assert.deepStrictEqual(switched.cache, {});
  assert.match(switched.providerResults.codex.error, /账号已切换/);
  codexFailure = true;
  const failed = await invoke('codex');
  assert.strictEqual(failed.providerResults.codex.ok, false);
  assert.strictEqual(failed.providerResults.codex.observedAt, 100);
  assert.deepStrictEqual(failed.cache, { codex: cache.codex });
  claudeMissing = true;
  assert.strictEqual((await invoke('claude')).providerResults.claude.ok, false);

  let resultFn, ipcCalls = [];
  const controller = createAccountUsageController({ document: { getElementById() { return null; } },
    sessions: new Map(), escapeHtml: String, setIntervalFn() {},
    ipcRenderer: { invoke(channel, provider) { ipcCalls.push([channel, provider]); return resultFn(provider); } },
  });
  controller.applyUsageCache(cache);
  let finish;
  resultFn = p => p === 'codex' ? new Promise(r => { finish = r; }) : Promise.resolve(deepseek);
  const pending = controller.refreshUsageNow('codex');
  assert.strictEqual(await controller.refreshUsageNow('codex'), null);
  assert.strictEqual(await controller.refreshUsageNow(), null, 'bulk must not overlap a scoped UI refresh');
  await controller.refreshUsageNow('deepseek');
  assert.strictEqual(controller.getSnapshot().deepseek.lastSeen, 200);
  controller.applyUsageCache({ codex: { usage7d: { pct: 25 }, observedAt: 300 } });
  finish(results[0]); await pending;
  assert.strictEqual(controller.getSnapshot().codex.usage7d.pct, 25, 'late manual response must not revert newer observation');
  assert.strictEqual(controller.getSnapshot().claude.lastSeen, 100);
  resultFn = () => Promise.resolve(failed);
  await controller.refreshUsageNow('codex');
  assert.strictEqual(controller.getSnapshot().codex.lastSeen, 300);
  assert.match(controller.getSnapshot().refresh.providers.codex.error, /timeout/);
  resultFn = () => Promise.reject(Error('IPC disconnected'));
  await assert.rejects(controller.refreshUsageNow('deepseek'), /IPC disconnected/);
  assert.strictEqual(controller.getSnapshot().refresh.providers.deepseek.inFlight, false);
  assert.strictEqual(controller.getSnapshot().deepseek.lastSeen, 200);
  await assert.rejects(controller.refreshUsageNow('__proto__'), /不支持/);

  const nodes = [];
  const doc = { createElement(tag) {
    const node = { tag, children: [], dataset: {}, style: {}, attrs: {}, listeners: {},
      appendChild(c) { this.children.push(c); }, setAttribute(k,v) { this.attrs[k] = v; },
      addEventListener(k,fn) { this.listeners[k] = fn; } }; nodes.push(node); return node;
  } };
  const root = doc.createElement('div');
  const view = createSidebarAccountUsage({ document: doc, root, refresh: async () => {},
    formatAge: ts => String(ts || 0), formatBalance: data => data.totalBalance == null ? '—' : '¥' + data.totalBalance.toFixed(2),
    freshness: ts => ts === 200 ? 'fresh' : 'stale' });
  const buttons = nodes.filter(n => n.tag === 'button');
  assert.strictEqual(buttons.length, 4);
  view.render({ ...cache, deepseek: { ...cache.deepseek, lastSeen: 200 } }, {});
  const values = nodes.filter(n => n.className === 'sidebar-quota-value').map(n => n.textContent);
  assert.deepStrictEqual(values, ['90%', '—', '60%', '¥0.00', '—']);
  view.render({ tokenPlan: { usage7d: { pct: 45.3284435 }, lastSeen: 200 } }, {});
  assert.strictEqual(nodes.filter(n => n.className === 'sidebar-quota-value').at(-1).textContent, '54.67%');
  view.render(cache, { codex: { inFlight: true }, deepseek: { error: 'offline' } });
  assert.strictEqual(nodes.filter(n => n.tag === 'button')[1], buttons[1]);
  assert.strictEqual(buttons[1].attrs['aria-disabled'], 'true');
  assert.strictEqual(nodes.some(n => n.className === 'sidebar-quota-feedback' || n.className === 'sidebar-quota-footer'), false);
  assert.match(buttons[2].title, /offline/, 'refresh errors remain available on the provider control');
  // Exercise the actual main service body: account changes must be rejected
  // before the shared cache and background broadcaster can see the old result.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  const serviceBody = source.slice(source.indexOf('async function refreshCodexAccountUsageLive()'),
    source.indexOf('async function refreshKimiAccountUsageLive()'));
  let currentScope = 'a', resolveLive, writes = 0;
  const context = require('vm').createContext({
    currentCodexUsageScope: () => ({ backend: 'subscription', scopeKey: currentScope, home: 'isolated' }),
    getHubConfig: () => ({}), os: { homedir: () => 'isolated' },
    readCodexAccountUsage: () => new Promise(resolve => { resolveLive = resolve; }),
    attachCodexUsageScope: (payload, scope) => ({ ...payload, scopeKey: scope.scopeKey }),
    cacheAgentUsage: () => { writes++; },
  });
  require('vm').runInContext('let _codexLiveUsage = null;\n' + serviceBody, context);
  const liveRequest = context.refreshCodexAccountUsageLive();
  currentScope = 'b'; resolveLive({ observedAt: 400 });
  await assert.rejects(liveRequest, /账号已切换/);
  assert.strictEqual(writes, 0);
  const validRequest = context.refreshCodexAccountUsageLive();
  resolveLive({ observedAt: 500 });
  assert.strictEqual((await validRequest).scopeKey, 'b');
  assert.strictEqual(writes, 1);
  console.log('unit-sidebar-quota-refresh OK: values, isolation, dedup, concurrent providers, errors, stale races, stable controls');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
