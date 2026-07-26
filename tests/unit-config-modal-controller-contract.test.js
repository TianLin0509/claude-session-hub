const assert = require('assert');
const path = require('path');

const { createConfigModalController } = require(path.join(__dirname, '..', 'renderer', 'config-modal.js'));

function makeElement(id = '') {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    value: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelectorAll() { return []; },
    classList: {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
      toggle(cls, on) {
        if (on) classes.add(cls);
        else classes.delete(cls);
      },
    },
    _listeners: listeners,
    _classes: classes,
  };
}

function makeDocument(ids) {
  const elements = new Map(ids.map(id => [id, makeElement(id)]));
  const labelEl = makeElement('codex-menu-label');
  labelEl.dataset.codexProfileLabel = 'second';
  return {
    readyState: 'loading',
    body: makeElement('body'),
    createElement: makeElement,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll(selector) {
      if (selector === '[data-codex-profile-label]') return [labelEl];
      if (selector === '.config-ai-row') return [];
      if (selector === '.config-ai-detail') return [];
      return [];
    },
    addEventListener() {},
    _elements: elements,
    _labelEl: labelEl,
  };
}

async function main() {
  const ids = [
    'config-modal', 'cfg-codex-subscription-profile',
    'cfg-codex-profile-default-label', 'cfg-codex-profile-second-label',
    'cfg-claude-backend', 'cfg-claude-key', 'cfg-claude-url', 'cfg-claude-model',
    'cfg-claude-subscription-card', 'cfg-claude-api-card', 'cfg-claude-route-note',
    'cfg-summary-claude', 'cfg-status-claude',
    'cfg-codex-profile-second-home', 'cfg-codex-backend',
    'cfg-codex-key', 'cfg-codex-model', 'cfg-summary-codex',
    'cfg-status-codex', 'cfg-detail-status', 'cfg-proxy',
    'cfg-deepseek-key', 'cfg-codex-url',
  ];
  const document = makeDocument(ids);
  const providerModes = { codex: 'subscription' };
  let usageRendered = 0;
  const ipcRenderer = {
    async invoke(channel) {
      assert.strictEqual(channel, 'get-hub-config-raw');
      return {
        claudeBackend: 'subscription',
        claudeApiKey: 'sk-claude',
        claudeApiBaseUrl: 'http://3.142.133.116:8080',
        claudeApiModel: 'claude-fable-5',
        codexBackend: 'api',
        codexSubscriptionProfile: 'second',
        codexSubscriptionProfiles: [
          { id: 'default', label: 'Main', home: '' },
          { id: 'second', label: 'Nightly', home: 'C:\\Users\\lintian\\.codex-profiles\\second' },
        ],
        codexApiKey: 'sk-test',
        codexApiModel: 'gpt-5.5',
      };
    },
  };

  const controller = createConfigModalController({
    document,
    ipcRenderer,
    providerModes,
    renderAccountUsage() { usageRendered += 1; },
  });

  controller.setCodexProfileForm([
    { id: 'second', label: 'Nightly', home: 'C:\\Users\\lintian\\.codex-profiles\\second' },
  ], 'second');
  assert.strictEqual(document.getElementById('cfg-codex-subscription-profile').value, 'second');
  assert.strictEqual(document.getElementById('cfg-codex-profile-second-label').value, 'Nightly');
  assert.strictEqual(document._labelEl.textContent, 'Nightly');

  await controller.open();
  assert.strictEqual(providerModes.claude, 'subscription');
  assert.strictEqual(providerModes.codex, 'api');
  assert.strictEqual(document.getElementById('config-modal')._classes.has('hidden'), false);
  assert.strictEqual(document.getElementById('cfg-claude-backend').value, 'subscription');
  assert.strictEqual(document.getElementById('cfg-claude-key').value, 'sk-claude');
  assert.strictEqual(document.getElementById('cfg-claude-model').value, 'claude-fable-5');
  assert.strictEqual(document.getElementById('cfg-claude-key').disabled, true);
  assert.strictEqual(document.getElementById('cfg-summary-claude').textContent, '订阅模式 · claude-opus-5[1m]');
  document.getElementById('cfg-claude-backend').value = 'api';
  controller.updateClaudeBackendControls();
  controller.updateSummaries();
  assert.strictEqual(document.getElementById('cfg-claude-key').disabled, false);
  assert.strictEqual(document.getElementById('cfg-claude-route-note').className, 'config-note warning');
  assert.strictEqual(document.getElementById('cfg-summary-claude').textContent, '同事中转 · Fable 5 · 1M');
  assert.strictEqual(document.getElementById('cfg-status-claude').textContent, '中转');
  assert.strictEqual(document.getElementById('cfg-codex-key').value, 'sk-test');
  assert.strictEqual(document.getElementById('cfg-status-codex').textContent, 'API');
  assert.strictEqual(document.getElementById('cfg-status-codex').className, 'config-ai-status api');
  assert.strictEqual(usageRendered, 0);

  console.log('unit-config-modal-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
