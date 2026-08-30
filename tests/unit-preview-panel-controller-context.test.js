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
    this.dataset = {};
    this.attributes = {};
    this.className = '';
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
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  focus() { this._focused = true; }
  scrollIntoView() {}
  querySelector(selector) {
    if (selector === 'webview') return this.children.find(child => child.tagName === 'webview') || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.preview-quick-open-item') {
      return this.children.filter(child => String(child.className || '').includes('preview-quick-open-item'));
    }
    return [];
  }
  getBoundingClientRect() { return { left: 0, width: 500 }; }
  get isConnected() { return this.parentNode !== null; }
  set innerHTML(value) {
    this._innerHTML = value;
    this.children.forEach(child => { child.parentNode = null; });
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
    'preview-tabs',
    'preview-new-tab',
    'preview-layout-split',
    'preview-layout-full',
    'preview-close',
    'preview-open-external',
    'preview-open-path',
    'preview-copy-content',
    'preview-copy-path',
    'preview-show-in-folder',
    'preview-zoom-out',
    'preview-zoom-in',
    'preview-zoom-reset',
    'btn-preview-path',
    'preview-quick-open',
    'preview-quick-open-input',
    'preview-quick-open-results',
    'preview-quick-open-status',
    'preview-quick-open-close',
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
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = String(text); return node; },
    addEventListener() {},
    _ids: ids,
  };
}

function makeController(document, getActiveSessionId, options = {}) {
  return createPreviewPanelController({
    document,
    ipcRenderer: options.ipcRenderer || {
      async invoke(channel) {
        if (channel === 'read-file') return { content: '# ok\n\nbody' };
        if (channel === 'preview:search-paths') return { results: [], indexedCount: 0 };
        return null;
      },
    },
    shell: { openExternal() {} },
    clipboard: options.clipboard || { writeText() {} },
    fs: {
      statSync() { return { size: 32, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1, dev: 1, ino: 1 }; },
      watch() { return { on() { return this; }, unref() {}, close() {} }; },
    },
    marked: { parse: (text) => `<p>${text}</p>` },
    DOMPurify: { sanitize: (html) => html },
    getActiveSessionId,
    getActiveMeetingId: () => null,
    getActiveCwd: () => 'C:\\tmp',
    openPath: async filePath => options.openedPaths && options.openedPaths.push(filePath),
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
  assert.strictEqual(terminal.style.display, 'none');
  assert.strictEqual(controller.getPreviewState('session:s1').isFullscreen, true);
  assert.strictEqual(document.getElementById('preview-layout-full').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(document.getElementById('preview-layout-split').getAttribute('aria-pressed'), 'false');

  document.getElementById('preview-layout-split').listeners.click();
  assert.strictEqual(controller.getPreviewState('session:s1').isFullscreen, false);
  assert.strictEqual(terminal.style.display, '');
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

async function testExplicitSplitOverride() {
  const document = makeDocument();
  const controller = makeController(document, () => 'explicit-split');
  await controller.openPreviewPanel('C:\\tmp\\split.md', { fullscreen: false });
  const state = controller.getPreviewState('session:explicit-split');
  assert.strictEqual(state.isFullscreen, false);
  assert.strictEqual(document.getElementById('preview-layout-split').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(document.getElementById('preview-layout-full').getAttribute('aria-pressed'), 'false');
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

async function testMultipleTabsReuseAndClose() {
  const document = makeDocument();
  const controller = makeController(document, () => 'tabs');
  await controller.openPreviewPanel('C:\\tmp\\a.md');
  await controller.openPreviewPanel('C:\\tmp\\b.md');
  let state = controller.getPreviewState('session:tabs');
  assert.strictEqual(state.tabs.length, 2);
  assert.strictEqual(state.tabs.find(tab => tab.id === state.activeTabId).path, 'C:\\tmp\\b.md');

  document.getElementById('preview-body').scrollTop = 88;
  const firstTabId = state.tabs[0].id;
  await controller.switchPreviewTab(firstTabId);
  state = controller.getPreviewState('session:tabs');
  assert.strictEqual(state.tabs[1].scroll.y, 88, 'switching tabs must retain the old tab scroll');
  assert.strictEqual(document.getElementById('preview-body').scrollTop, 0, 'a fresh tab must not inherit another tab scroll');

  await controller.openPreviewPanel('C:\\tmp\\b.md');
  state = controller.getPreviewState('session:tabs');
  assert.strictEqual(state.tabs.length, 2, 'opening the same path must reuse its tab');
  await controller.closePreviewTab(firstTabId);
  state = controller.getPreviewState('session:tabs');
  assert.strictEqual(state.tabs.length, 1);
  assert.strictEqual(state.tabs[0].path, 'C:\\tmp\\b.md');
}

async function testTemporaryTabReuseAndPinning() {
  const document = makeDocument();
  const controller = makeController(document, () => 'temporary-tabs');
  await controller.openPreviewPanel('C:\\tmp\\preview-a.md', { preview: true });
  let state = controller.getPreviewState('session:temporary-tabs');
  const temporaryId = state.tabs[0].id;
  assert.strictEqual(state.tabs.length, 1);
  assert.strictEqual(state.tabs[0].pinned, false);

  await controller.openPreviewPanel('C:\\tmp\\preview-b.md', { preview: true });
  state = controller.getPreviewState('session:temporary-tabs');
  assert.strictEqual(state.tabs.length, 1, 'a second preview must reuse the single temporary tab');
  assert.strictEqual(state.tabs[0].id, temporaryId);
  assert.strictEqual(state.tabs[0].path, 'C:\\tmp\\preview-b.md');
  assert.strictEqual(state.tabs[0].pinned, false);

  assert.strictEqual(controller.pinPreviewTab(temporaryId), true);
  state = controller.getPreviewState('session:temporary-tabs');
  assert.strictEqual(state.tabs[0].pinned, true);

  await controller.openPreviewPanel('C:\\tmp\\preview-c.md', { preview: true });
  state = controller.getPreviewState('session:temporary-tabs');
  assert.strictEqual(state.tabs.length, 2, 'pinning frees a new temporary preview slot');
  assert.strictEqual(state.tabs.find(tab => tab.path.endsWith('preview-c.md')).pinned, false);
  await controller.openPreviewPanel('C:\\tmp\\preview-c.md', { pinned: true });
  state = controller.getPreviewState('session:temporary-tabs');
  assert.strictEqual(state.tabs.find(tab => tab.path.endsWith('preview-c.md')).pinned, true);
}

async function testContextRestoresTabSetsIndependently() {
  let activeSessionId = 's1';
  const document = makeDocument();
  const controller = makeController(document, () => activeSessionId);
  await controller.openPreviewPanel('C:\\tmp\\one.md');
  await controller.openPreviewPanel('C:\\tmp\\two.md');
  await controller.savePreviewState();
  controller.clearPreviewUI();

  activeSessionId = 's2';
  await controller.openPreviewPanel('C:\\tmp\\other.md');
  await controller.savePreviewState();
  controller.clearPreviewUI();

  activeSessionId = 's1';
  await controller.restorePreviewForContext('session:s1');
  const restored = controller.getPreviewState('session:s1');
  assert.deepStrictEqual(restored.tabs.map(tab => tab.path), ['C:\\tmp\\one.md', 'C:\\tmp\\two.md']);
  assert.strictEqual(restored.tabs.find(tab => tab.id === restored.activeTabId).path, 'C:\\tmp\\two.md');
}

async function testCopyActionsUseRawTextAndPath() {
  const copied = [];
  const document = makeDocument();
  const controller = makeController(document, () => 'copy', {
    clipboard: { writeText(text) { copied.push(text); } },
  });
  await controller.openPreviewPanel('C:\\tmp\\copy.md');
  await controller.copyPreviewContent();
  await controller.copyPreviewPath();
  assert.deepStrictEqual(copied, ['# ok\n\nbody', 'C:\\tmp\\copy.md']);
}

async function testSlowReadCannotOverwriteNewerTab() {
  let resolveSlow;
  const slow = new Promise(resolve => { resolveSlow = resolve; });
  const document = makeDocument();
  const controller = makeController(document, () => 'race', {
    ipcRenderer: {
      async invoke(channel, target) {
        if (channel !== 'read-file') return null;
        if (target.endsWith('slow.md')) return slow;
        return { content: 'FAST' };
      },
    },
  });
  const slowOpen = controller.openPreviewPanel('C:\\tmp\\slow.md');
  await Promise.resolve();
  const fastOpen = controller.openPreviewPanel('C:\\tmp\\fast.md');
  resolveSlow({ content: 'SLOW' });
  await Promise.all([slowOpen, fastOpen]);
  const state = controller.getPreviewState('session:race');
  assert.strictEqual(state.tabs.find(tab => tab.id === state.activeTabId).path, 'C:\\tmp\\fast.md');
  assert.match(document.getElementById('preview-body').children[0].innerHTML, /FAST/);
  assert.doesNotMatch(document.getElementById('preview-body').children[0].innerHTML, /SLOW/);
}

async function testQuickOpenSearchIsCancelledOnContextSwitch() {
  let activeSessionId = 'search-a';
  let resolveSearch;
  const delayedSearch = new Promise(resolve => { resolveSearch = resolve; });
  const document = makeDocument();
  const controller = makeController(document, () => activeSessionId, {
    ipcRenderer: {
      async invoke(channel) {
        if (channel === 'preview:search-paths') return delayedSearch;
        if (channel === 'read-file') return { content: '# ok' };
        return null;
      },
    },
  });
  controller.openQuickOpen();
  const input = document.getElementById('preview-quick-open-input');
  input.value = 'old-workspace-report';
  input.listeners.input();
  await new Promise(resolve => setTimeout(resolve, 170));

  activeSessionId = 'search-b';
  controller.clearPreviewUI();
  resolveSearch({
    results: [{ path: 'C:\\old\\report.md', name: 'report.md', relativePath: 'report.md' }],
    indexedCount: 1,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(document.getElementById('preview-quick-open').style.display, 'none');

  controller.openQuickOpen();
  const resultRows = document.getElementById('preview-quick-open-results').children
    .filter(child => child.dataset && child.dataset.resultIndex !== undefined);
  assert.strictEqual(resultRows.length, 0, 'old workspace results must not leak into the new context');
  controller.closeQuickOpen({ restoreFocus: false });
}

async function testCopyIsCancelledWhenActiveTabChanges() {
  const copied = [];
  let copyReadResolve;
  let copyReads = 0;
  const document = makeDocument();
  const controller = makeController(document, () => 'copy-race', {
    clipboard: { writeText(text) { copied.push(text); } },
    ipcRenderer: {
      async invoke(channel, target) {
        if (channel !== 'read-file') return null;
        if (target.endsWith('copy-race.md')) {
          copyReads += 1;
          if (copyReads === 1) return { content: 'INITIAL' };
          return new Promise(resolve => { copyReadResolve = resolve; });
        }
        return { content: 'NEXT' };
      },
    },
  });
  await controller.openPreviewPanel('C:\\tmp\\copy-race.md');
  const copying = controller.copyPreviewContent();
  await Promise.resolve();
  await controller.openPreviewPanel('C:\\tmp\\next.md');
  copyReadResolve({ content: 'STALE COPY' });
  await copying;
  assert.deepStrictEqual(copied, [], 'a stale tab must never overwrite the clipboard');
}

async function testDroppingClosedContextRemovesItsTabs() {
  const document = makeDocument();
  const controller = makeController(document, () => 'closed');
  await controller.openPreviewPanel('C:\\tmp\\closed.md');
  assert.strictEqual(controller.dropPreviewContext('session:closed'), true);
  assert.strictEqual(controller.getPreviewState('session:closed'), null);
  assert.strictEqual(document.getElementById('preview-panel').style.display, 'none');
}

async function testLateWebviewLoadCannotClearNewerFailure() {
  const document = makeDocument();
  const controller = makeController(document, () => 'webview-race');
  await controller.openPreviewPanel('C:\\tmp\\page.html');
  const oldWebview = document.getElementById('preview-body').querySelector('webview');
  assert.strictEqual(await controller.reloadActivePreview(), true, 'async reload reports accepted');
  const currentWebview = document.getElementById('preview-body').querySelector('webview');
  assert.notStrictEqual(currentWebview, oldWebview);
  currentWebview.listeners['did-fail-load']({
    isMainFrame: true,
    errorCode: -2,
    errorDescription: 'current load failed',
  });
  oldWebview.listeners['did-finish-load']();
  const state = controller.getPreviewState('session:webview-race');
  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  assert.match(active.loadError, /current load failed/);
}

async function testNavigationSaveDoesNotWaitForWebviewScroll() {
  const document = makeDocument();
  const controller = makeController(document, () => 'nonblocking-save');
  await controller.openPreviewPanel('C:\\tmp\\page.html');
  const webview = document.getElementById('preview-body').querySelector('webview');
  let resolveCapture;
  webview.executeJavaScript = () => new Promise(resolve => { resolveCapture = resolve; });

  const completedQuickly = await Promise.race([
    controller.savePreviewState({ nonBlocking: true }).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 25)),
  ]);
  assert.strictEqual(completedQuickly, true, 'session navigation must not wait for webview IPC');

  resolveCapture({ x: 4, y: 321 });
  await new Promise(resolve => setImmediate(resolve));
  const state = controller.getPreviewState('session:nonblocking-save');
  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  assert.deepStrictEqual(active.scroll, { type: 'webview', x: 4, y: 321 });
}

async function main() {
  await testSessionScopedBodyPreview();
  await testExplicitSplitOverride();
  await testWebviewScrollRestore();
  await testMultipleTabsReuseAndClose();
  await testTemporaryTabReuseAndPinning();
  await testContextRestoresTabSetsIndependently();
  await testCopyActionsUseRawTextAndPath();
  await testSlowReadCannotOverwriteNewerTab();
  await testQuickOpenSearchIsCancelledOnContextSwitch();
  await testCopyIsCancelledWhenActiveTabChanges();
  await testDroppingClosedContextRemovesItsTabs();
  await testLateWebviewLoadCannotClearNewerFailure();
  await testNavigationSaveDoesNotWaitForWebviewScroll();
  console.log('unit-preview-panel-controller-context OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
