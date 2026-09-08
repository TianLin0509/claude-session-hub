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
    querySelector() { return null; },
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

  // T2（2026-09-08）：头部的模型徽章删了。模型名在界面上只剩 composer 底栏那个
  // chip，所以 controller 不再自己造节点，只负责请 composer 重画一遍。
  const terminalPanelEl = { querySelector() { return null; } };
  const composerRepaints = [];
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
    repaintActiveComposer: (session) => composerRepaints.push(session),
  });

  ui.updateActiveModelChip();
  assert.strictEqual(composerRepaints.length, 1, '模型名变化必须让 composer 重画');
  assert.strictEqual(composerRepaints[0].currentModel.displayName, 'Sonnet 4.6');

  // 选择器仍然由 attachModelPickerHandler 挂在调用方给的节点上（现在是 composer
  // 的 chip），行为与从前一致：点开菜单 → 选一项 → 走真实 PTY。
  const chip = makeElement();
  ui.attachModelPickerHandler(chip, 's1');
  assert.ok(chip._classes.has('clickable'));
  chip._listeners.click[0]({ stopPropagation() {} });
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
