const assert = require('assert');
const path = require('path');

const { createPreviewPanelController } = require(path.join(__dirname, '..', 'renderer', 'preview-panel-controller.js'));

global.requestAnimationFrame = (fn) => { fn(); return 1; };
global.cancelAnimationFrame = () => {};

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, enabled) {
    if (enabled) this.add(name);
    else this.remove(name);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toLowerCase();
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.listeners = {};
    this.textContent = '';
    this.title = '';
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 100;
    this._innerHTML = '';
    this._executedScripts = [];
    this._scrollY = 0;
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...items) { items.forEach(item => this.appendChild(item)); }
  querySelector(selector) {
    if (selector === 'webview') return this.children.find(child => child.tagName === 'webview') || null;
    return null;
  }
  getBoundingClientRect() { return { left: 0, width: 500 }; }
  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
  }
  get innerHTML() { return this._innerHTML; }
  async executeJavaScript(code) {
    this._executedScripts.push(code);
    if (code.includes('window.scrollX') || code.includes('document.documentElement')) {
      return { x: 0, y: this._scrollY || 0 };
    }
    const match = /window\.scrollTo\((\d+),\s*(\d+)\)/.exec(code);
    if (match) {
      this._restoredX = Number(match[1]);
      this._restoredY = Number(match[2]);
    }
    return null;
  }
}

function makeDocument() {
  const ids = {};
  const required = [
    'preview-panel',
    'preview-title',
    'preview-body',
    'preview-splitter',
    'preview-zoom-label',
    'preview-file-badge',
    'preview-file-meta',
    'preview-toggle-layout',
    'preview-close',
    'preview-open-external',
    'preview-zoom-out',
    'preview-zoom-in',
    'preview-zoom-reset',
    'meeting-room-panel',
    'terminal-panel',
    'empty-state',
  ];
  for (const id of required) ids[id] = new FakeElement();
  ids['meeting-room-panel'].style.display = 'none';
  ids['terminal-panel'].style.display = '';
  return {
    body: new FakeElement('body'),
    getElementById(id) { return ids[id] || null; },
    createElement(tag) { return new FakeElement(tag); },
    addEventListener() {},
    _ids: ids,
  };
}

function makeController(document, getActiveSessionId) {
  return createPreviewPanelController({
    document,
    ipcRenderer: {
      async invoke(channel) {
        if (channel === 'read-file') return { content: '# ok\n\nbody' };
        return null;
      },
    },
    shell: { openExternal() {} },
    fs: { statSync() { throw new Error('not needed'); } },
    marked: { parse: (text) => `<p>${text}</p>` },
    DOMPurify: { sanitize: (html) => html },
    getActiveSessionId,
    getActiveMeetingId: () => null,
    refitActiveTerminal: () => {},
  });
}

async function testSessionScopedBodyPreview() {
  let activeSessionId = 's1';
  const document = makeDocument();
  const controller = makeController(document, () => activeSessionId);
  const body = document.getElementById('preview-body');
  const panel = document.getElementById('preview-panel');
  const terminal = document.getElementById('terminal-panel');

  await controller.openPreviewPanel('C:\\tmp\\a.md');
  assert.strictEqual(panel.style.display, 'flex');
  assert.strictEqual(terminal.style.flex, '0.5');

  body.scrollTop = 321;
  await controller.savePreviewState();
  controller.clearPreviewUI();
  assert.strictEqual(panel.style.display, 'none');
  assert.strictEqual(terminal.style.flex, '');

  activeSessionId = 's2';
  await controller.restorePreviewForContext('session:s2');
  assert.strictEqual(panel.style.display, 'none', 'session without preview must stay full-width');

  activeSessionId = 's1';
  await controller.restorePreviewForContext('session:s1');
  assert.strictEqual(panel.style.display, 'flex');
  assert.strictEqual(body.scrollTop, 321);
}

async function testWebviewScrollRestore() {
  let activeSessionId = 'html';
  const document = makeDocument();
  const controller = makeController(document, () => activeSessionId);
  const body = document.getElementById('preview-body');

  await controller.openPreviewPanel('C:\\tmp\\page.html');
  const originalWebview = body.querySelector('webview');
  originalWebview._scrollY = 777;
  await controller.savePreviewState();
  controller.clearPreviewUI();

  await controller.restorePreviewForContext('session:html');
  const restoredWebview = body.querySelector('webview');
  assert.ok(restoredWebview, 'restore should recreate the webview');
  restoredWebview.listeners['dom-ready']();
  assert.strictEqual(restoredWebview._restoredY, 777);
}

async function main() {
  await testSessionScopedBodyPreview();
  await testWebviewScrollRestore();
  console.log('unit-preview-panel-controller-context OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
