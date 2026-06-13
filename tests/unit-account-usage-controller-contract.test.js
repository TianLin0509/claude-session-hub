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
  const accountEl = makeAccountElement();
  const document = {
    getElementById(id) {
      if (id === 'account-usage') return accountEl;
      return null;
    },
  };
  const sessions = new Map([['s1', { contextUsed: 2000 }]]);
  const ipcHandlers = {};
  const invokeCalls = [];
  const controller = createAccountUsageController({
    document,
    window: { open() {} },
    ipcRenderer: {
      on(channel, fn) { ipcHandlers[channel] = fn; },
      invoke(channel) {
        invokeCalls.push(channel);
        if (channel === 'refresh-usage-now') {
          return Promise.resolve({
            cache: {
              codex: { usage5h: { pct: 66 }, usage7d: { pct: 32 }, ts: Date.now(), source: 'jsonl' },
            },
            agentData: {
              codex: { usage5h: { pct: 66 }, usage7d: { pct: 32 }, _ts: Date.now(), source: 'jsonl' },
            },
            packyAccount: { enabled: true, balanceUsd: 20.5, usedUsd: 6, displayName: 'Packy' },
          });
        }
        return Promise.resolve();
      },
    },
    sessions,
    escapeHtml: (s) => String(s).replace(/[&<>"]/g, ''),
    openConfigModal: async () => {},
    setIntervalFn: () => 0,
    setTimeoutFn: (fn) => fn(),
  });

  assert.strictEqual(controller.pctClass(12), 'ok');
  assert.strictEqual(controller.pctClass(74), 'warn');
  assert.strictEqual(controller.pctClass(91), 'danger');

  controller.applyUsageCache({
    claude: { usage5h: { pct: 42 }, usage7d: { pct: 8 }, ts: Date.now() },
    codex: { usage5h: { pct: 65 }, usage7d: { pct: 31 }, profileLabel: 'Main', accountEmail: 'current@example.com' },
    packy: { enabled: true, balanceUsd: 12.34, usedUsd: 5, displayName: 'Packy' },
  });
  assert.strictEqual(accountEl.style.display, 'block');
  assert.ok(accountEl.innerHTML.includes('Claude'));
  assert.ok(accountEl.innerHTML.includes('Codex'));
  assert.ok(accountEl.innerHTML.includes('42%'));
  assert.ok(accountEl.innerHTML.includes('$12.34'));
  assert.ok(accountEl.innerHTML.includes('data-action="refresh-usage"'));
  assert.ok(
    accountEl.innerHTML.includes('class="acc-ai-profile"') && accountEl.innerHTML.includes('>current@example.com<'),
    'codex 行必须渲染 profile 标签（让用户看出监控的是哪个 codex 账号）',
  );

  await controller.refreshUsageNow();
  assert.ok(invokeCalls.includes('refresh-usage-now'));
  assert.ok(accountEl.innerHTML.includes('66%'));
  assert.ok(accountEl.innerHTML.includes('$20.50'));

  const session = sessions.get('s1');
  session._tokenSamples = [
    { t: Date.now() - 120000, used: 1000 },
    { t: Date.now(), used: 7000 },
  ];
  const burn = controller.sessionBurnRate(session);
  assert.ok(burn && burn.tokensPerMin > 0);

  assert.ok(typeof ipcHandlers['packy-account-updated'] === 'function');
  ipcHandlers['packy-account-updated'](null, { enabled: false });
  assert.ok(accountEl.innerHTML.includes('acc-packy-row'));

  console.log('unit-account-usage-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
