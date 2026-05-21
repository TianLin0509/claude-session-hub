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
  const controller = createAccountUsageController({
    document,
    window: { open() {} },
    ipcRenderer: {
      on(channel, fn) { ipcHandlers[channel] = fn; },
      invoke() { return Promise.resolve(); },
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
    codex: { usage5h: { pct: 65 }, usage7d: { pct: 31 }, profileLabel: 'Main' },
    packy: { enabled: true, balanceUsd: 12.34, usedUsd: 5, displayName: 'Packy' },
  });
  assert.strictEqual(accountEl.style.display, 'block');
  assert.ok(accountEl.innerHTML.includes('Claude'));
  assert.ok(accountEl.innerHTML.includes('Codex'));
  assert.ok(accountEl.innerHTML.includes('42%'));
  assert.ok(accountEl.innerHTML.includes('$12.34'));

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
