const assert = require('assert');
const path = require('path');

const { createAccountUsageController } = require(path.join(__dirname, '..', 'renderer', 'account-usage-controller.js'));

function makeAccountElement() {
  return {
    style: {},
    innerHTML: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

async function main() {
  let now = Date.now();
  let refreshStatusTimer = null;
  const accountEl = makeAccountElement();
  const document = {
    getElementById(id) {
      if (id === 'quota-ticker') return accountEl;
      return null;
    },
  };
  const sessions = new Map([['s1', { contextUsed: 2000 }]]);
  const ipcHandlers = {};
  const invokeCalls = [];
  const controller = createAccountUsageController({
    document,
    ipcRenderer: {
      on(channel, fn) { ipcHandlers[channel] = fn; },
      invoke(channel) {
        invokeCalls.push(channel);
        if (channel === 'refresh-usage-now') {
          return Promise.resolve({
            cache: {
              codex: { usage5h: { pct: 66 }, usage7d: { pct: 32 }, observedAt: now, ts: now, source: 'app-server' },
              kimi: { usage5h: { pct: 67, label: '5h' }, usage7d: { pct: 13, label: '周' }, observedAt: now, ts: now, source: 'kimi-api' },
            },
            agentData: {
              codex: { usage5h: { pct: 66 }, usage7d: { pct: 32 }, observedAt: now, _ts: now, source: 'app-server', profileLabel: 'Main', accountEmail: 'current@example.com' },
              kimi: { usage5h: { pct: 67, label: '5h' }, usage7d: { pct: 13, label: '周' }, observedAt: now, _ts: now, source: 'kimi-api' },
            },
            providerResults: {
              claude: { ok: true, changed: false, mode: 'snapshot', source: 'statusline-cache', observedAt: now - 300000 },
              codex: { ok: true, changed: true, mode: 'live', source: 'app-server', observedAt: now },
              kimi: { ok: true, changed: true, mode: 'live', source: 'kimi-api', observedAt: now },
            },
            refreshedAt: now,
          });
        }
        return Promise.resolve();
      },
    },
    sessions,
    escapeHtml: (s) => String(s).replace(/[&<>"]/g, ''),
    setIntervalFn: () => 0,
    setTimeoutFn: (fn, delay) => {
      refreshStatusTimer = { fn, delay };
      return 1;
    },
    nowFn: () => now,
  });

  assert.strictEqual(controller.pctClass(12), 'ok');
  assert.strictEqual(controller.pctClass(74), 'warn');
  assert.strictEqual(controller.pctClass(91), 'danger');

  controller.applyUsageCache({
    claude: { usage5h: { pct: 101 }, usage7d: { pct: 8 }, ts: now - 300000 },
    codex: { usage5h: { pct: 65 }, usage7d: { pct: 31 }, observedAt: now - 300000, ts: now, profileLabel: 'Main', accountEmail: 'current@example.com' },
    kimi: { usage5h: { pct: 67, label: '5h', resetsAt: now + 30 * 60000 }, usage7d: { pct: 13, label: '周', resetsAt: now + 6 * 86400000 }, observedAt: now - 60000, source: 'kimi-api' },
  });
  assert.strictEqual(accountEl.style.display, 'flex');
  assert.ok(accountEl.innerHTML.includes('Claude'));
  assert.ok(accountEl.innerHTML.includes('Codex'));
  assert.ok(accountEl.innerHTML.includes('Codex·Main'), 'selected Codex profile must be visible, not tooltip-only');
  assert.ok(accountEl.innerHTML.includes('data-provider="codex"'));
  assert.ok(accountEl.innerHTML.includes('Kimi'));
  assert.ok(accountEl.innerHTML.includes('101%'));
  assert.ok(!accountEl.innerHTML.includes('acc-bar-track'), 'compact usage UI must not render decorative bars');
  assert.ok(!accountEl.innerHTML.includes('acc-ai-logo'), 'compact usage UI must be text-first without provider logos');
  assert.strictEqual((accountEl.innerHTML.match(/data-action="refresh-usage"/g) || []).length, 1,
    'all providers should share one compact refresh action');
  assert.ok(accountEl.innerHTML.includes('↻30m'), 'ticker 必须显示每个窗口的重置时间（5h 重置是硬需求）');
  assert.ok(accountEl.innerHTML.includes('↻6d'), 'ticker 必须同时显示 7d/周 窗口的重置时间');
  assert.ok(accountEl.innerHTML.includes('5m'), 'Codex freshness must use observedAt instead of cache write time');
  assert.ok(!accountEl.innerHTML.includes('acc-packy-row'));
  assert.ok(accountEl.innerHTML.includes('data-action="refresh-usage"'));
  assert.ok(
    accountEl.innerHTML.includes('current@example.com'),
    'codex 账号标签必须出现在 segment tooltip（让用户看出监控的是哪个 codex 账号）',
  );

  await controller.refreshUsageNow();
  assert.ok(invokeCalls.includes('refresh-usage-now'));
  assert.ok(accountEl.innerHTML.includes('66%'));
  assert.ok(accountEl.innerHTML.includes('67%'));
  assert.ok(accountEl.innerHTML.includes('qt-refresh'), 'ticker 必须保留单一刷新入口');
  assert.ok(refreshStatusTimer && refreshStatusTimer.delay >= 60000,
    'manual refresh status must schedule its own expiry render');
  now += 61000;
  refreshStatusTimer.fn();
  assert.ok(accountEl.innerHTML.includes('66%'), '过期重渲染后实时数值仍在');
  assert.ok(!accountEl.innerHTML.includes('acc-packy-row'));

  const session = sessions.get('s1');
  session._tokenSamples = [
    { t: Date.now() - 120000, used: 1000 },
    { t: Date.now(), used: 7000 },
  ];
  const burn = controller.sessionBurnRate(session);
  assert.ok(burn && burn.tokensPerMin > 0);

  assert.ok(!Object.prototype.hasOwnProperty.call(ipcHandlers, 'packy-account-updated'));

  console.log('unit-account-usage-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
