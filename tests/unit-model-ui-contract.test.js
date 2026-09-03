const assert = require('assert');
const path = require('path');

const { modelClass, modelShort, createModelUiController } = require(path.join(__dirname, '..', 'renderer', 'model-ui.js'));

function makeElement() {
  const listeners = {};
  const classes = new Set();
  return {
    className: '',
    textContent: '',
    title: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    _removed: false,
    classList: {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector(selector) {
      if (selector === '.terminal-model-badge') return this.children.find(c => String(c.className).includes('terminal-model-badge')) || null;
      return null;
    },
    contains(node) { return node === this || this.children.includes(node); },
    remove() { this._removed = true; },
    getBoundingClientRect() { return { left: 10, bottom: 20 }; },
    _listeners: listeners,
    _classes: classes,
  };
}

async function main() {
  assert.strictEqual(modelClass('claude-opus-4.6'), 'opus');
  assert.strictEqual(modelClass('gpt-5.5'), 'codex');
  assert.strictEqual(modelShort({ id: 'gemini-3-pro-preview' }), 'Gemini 3 pro preview');
  assert.strictEqual(modelShort({ id: 'claude-sonnet', displayName: 'Sonnet 4.6 (1M context)' }), 'Sonnet 4.6');

  const titleSection = makeElement();
  const terminalPanelEl = {
    querySelector(selector) {
      if (selector === '.terminal-title-section') return titleSection;
      return null;
    },
  };
  const sessions = new Map([['s1', { kind: 'claude', currentModel: { id: 'claude-sonnet-4.6', displayName: 'Sonnet 4.6' } }]]);
  const sent = [];
  const document = {
    body: makeElement(),
    createElement: makeElement,
    addEventListener() {},
    removeEventListener() {},
  };
  const ui = createModelUiController({
    document,
    ipcRenderer: { send(channel, payload) { sent.push({ channel, payload }); } },
    sessions,
    terminalPanelEl,
    getActiveSessionId: () => 's1',
    escapeHtml: (s) => String(s).replace(/[&<>]/g, ''),
    getTerminalScreenText: () => '/model claude-opus-5[1m]\nModel changed to opus\n❯',
    sleep: async () => {},
    setTimeoutFn: (fn) => fn(),
  });

  ui.updateActiveModelBadge();
  const badge = titleSection.children[0];
  assert.strictEqual(badge.textContent, 'Sonnet 4.6');
  assert.ok(badge._classes.has('clickable'));

  badge._listeners.click[0]({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  const menu = document.body.children[0];
  assert.ok(menu.children.length > 0, 'model picker should render options');
  const clickable = menu.children.find(child => child.dataset && child.dataset.modelId);
  assert.ok(clickable, 'expected at least one model option');
  clickable._listeners.click[0]({ stopPropagation() {} });
  assert.strictEqual(sent[0].channel, 'terminal-input');
  assert.ok(sent[0].payload.data.includes('/model '));

  console.log('unit-model-ui-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
