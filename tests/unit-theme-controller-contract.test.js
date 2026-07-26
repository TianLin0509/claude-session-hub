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
  assert.deepStrictEqual(Object.keys(XTERM_THEMES), ['default']);

  const elements = new Map([
    ['btn-options', makeElement()],
    ['options-menu', makeElement()],
    ['options-settings', makeElement()],
  ]);
  const body = makeElement();
  const terminal = { options: {} };
  let settingsOpened = 0;
  const controller = createThemeController({
    document: {
      body,
      getElementById(id) { return elements.get(id) || null; },
      addEventListener() {},
    },
    terminalCache: new Map([['s1', { terminal }]]),
    openConfigModal() { settingsOpened += 1; },
  });

  assert.strictEqual(terminal.options.theme, XTERM_THEMES.default);

  controller.applyTheme();
  assert.strictEqual(terminal.options.theme, XTERM_THEMES.default);

  elements.get('options-settings')._listeners.click({ stopPropagation() {} });
  assert.strictEqual(settingsOpened, 1);

  console.log('unit-theme-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
