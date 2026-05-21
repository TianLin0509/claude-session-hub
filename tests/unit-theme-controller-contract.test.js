const assert = require('assert');
const path = require('path');

const { XTERM_THEMES, createThemeController } = require(path.join(__dirname, '..', 'renderer', 'theme-controller.js'));

function makeElement() {
  const listeners = {};
  const classes = new Set();
  return {
    style: { display: 'none' },
    dataset: {},
    classList: {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      toggle(cls, on) { if (on) classes.add(cls); else classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    contains() { return false; },
    querySelectorAll() { return []; },
    _classes: classes,
    _listeners: listeners,
  };
}

async function main() {
  assert.ok(XTERM_THEMES.default);
  assert.ok(XTERM_THEMES.aurora);

  const elements = new Map([
    ['btn-options', makeElement()],
    ['options-menu', makeElement()],
    ['options-theme', makeElement()],
    ['theme-picker-popup', makeElement()],
    ['options-settings', makeElement()],
  ]);
  const body = makeElement();
  const store = new Map([['claude-hub-theme', 'aurora']]);
  const terminal = { options: {} };
  let settingsOpened = 0;
  const controller = createThemeController({
    document: {
      body,
      getElementById(id) { return elements.get(id) || null; },
      addEventListener() {},
    },
    localStorage: {
      getItem(key) { return store.get(key) || null; },
      setItem(key, value) { store.set(key, value); },
    },
    terminalCache: new Map([['s1', { terminal }]]),
    openConfigModal() { settingsOpened += 1; },
  });

  assert.ok(body._classes.has('theme-aurora'));
  assert.strictEqual(terminal.options.theme, XTERM_THEMES.aurora);

  controller.applyTheme('obsidian');
  assert.ok(body._classes.has('theme-obsidian'));
  assert.strictEqual(store.get('claude-hub-theme'), 'obsidian');
  assert.strictEqual(terminal.options.theme, XTERM_THEMES.obsidian);

  elements.get('options-settings')._listeners.click({ stopPropagation() {} });
  assert.strictEqual(settingsOpened, 1);

  console.log('unit-theme-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
