'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPathLinkContextMenuController } = require('../renderer/path-link-context-menu.js');
const {
  parseCompanyDropOutput,
  registerPathIpc,
  resolveCompanyDropRuntime,
} = require('../main/ipc/path-handlers.js');

function makeElement(action = '') {
  const listeners = {};
  return {
    id: '',
    dataset: action ? { action } : {},
    style: {},
    textContent: '',
    children: [],
    addEventListener(type, handler) { listeners[type] = handler; },
    appendChild(child) { this.children.push(child); },
    contains() { return false; },
    getBoundingClientRect() { return { right: 180, bottom: 220, width: 160, height: 180 }; },
    setAttribute(name, value) { this[name] = value; },
    _listeners: listeners,
  };
}

test('path menu syncs a local path and shows success status', async () => {
  const copyButton = makeElement('copy-abs-path');
  copyButton.dataset.labelFile = '复制绝对路径';
  copyButton.dataset.labelUrl = '复制 URL';
  const syncButton = makeElement('sync-company');
  const fileOnly = [syncButton];
  const menu = makeElement();
  menu.querySelectorAll = (selector) => selector === '[data-file-only]'
    ? fileOnly
    : [copyButton, syncButton];
  menu.querySelector = selector => selector === '[data-action="copy-abs-path"]' ? copyButton : null;
  const body = makeElement();
  const document = {
    body,
    addEventListener() {},
    createElement: () => makeElement(),
  };
  const invocations = [];
  let invokeError = null;
  const controller = createPathLinkContextMenuController({
    document,
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      setTimeout: () => 1,
      clearTimeout() {},
    },
    menuEl: menu,
    clipboard: { writeText() {} },
    shell: {},
    ipcRenderer: {
      async invoke(channel, target) {
        invocations.push({ channel, target });
        if (invokeError) throw invokeError;
        return { success: true, filename: 'demo.html', inbox_url: 'https://example.test/drop/' };
      },
    },
    normalizeLocalPathForOpen: value => value,
    getSessionCwd: () => 'C:\\tmp',
    getActiveSessionId: () => 's1',
    requestAnimationFrameFn: handler => handler(),
  });

  assert.equal(controller.open('C:\\tmp\\demo.html', 10, 20), true);
  assert.equal(syncButton.style.display, '');
  await controller.runAction('sync-company');
  assert.deepEqual(invocations, [{
    channel: 'sync-path-to-company',
    target: 'C:\\tmp\\demo.html',
  }]);
  assert.equal(body.children.length, 1);
  assert.match(body.children[0].textContent, /已同步到公司收件箱/);

  invokeError = new Error('IPC unavailable');
  controller.open('C:\\tmp\\failed.html', 10, 20);
  await controller.runAction('sync-company');
  assert.equal(body.children[0].dataset.state, 'error');
  assert.match(body.children[0].textContent, /IPC unavailable/);

  controller.open('https://example.test/file', 10, 20);
  assert.equal(syncButton.style.display, 'none');
});

test('company-drop JSON parser enforces public HEAD verification', () => {
  const success = JSON.stringify({
    ok: true,
    command: 'send',
    data: {
      filename: 'demo.html',
      size: 12,
      public_head: { status: 200, content_length: 12 },
    },
  });
  assert.equal(parseCompanyDropOutput(success, '', 0).success, true);

  const mismatch = JSON.stringify({
    ok: true,
    command: 'send',
    data: {
      filename: 'demo.html',
      size: 12,
      public_head: { status: 200, content_length: 11 },
    },
  });
  assert.equal(parseCompanyDropOutput(mismatch, '', 0).code, 'public_verify_failed');
});

test('sync IPC validates the path and delegates to company-drop', async () => {
  const handlers = new Map();
  registerPathIpc({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    async runCompanyDrop(target) {
      return { success: true, filename: path.basename(target) };
    },
  });
  const handler = handlers.get('sync-path-to-company');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, __filename);
  assert.equal(result.success, true);
  assert.equal(result.filename, path.basename(__filename));
  assert.equal((await handler(null, 'relative.txt')).code, 'invalid_path');
});

test('preview path search IPC validates payload and delegates to the local searcher', async () => {
  const handlers = new Map();
  const calls = [];
  registerPathIpc({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    async searchPreviewPaths(payload) {
      calls.push(payload);
      return { results: [{ path: 'C:\\demo.md' }], source: 'workspace' };
    },
  });
  const handler = handlers.get('preview:search-paths');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, { query: 'demo', cwd: 'C:\\work', limit: 8 });
  assert.equal(result.results[0].path, 'C:\\demo.md');
  assert.deepEqual(calls, [{ query: 'demo', cwd: 'C:\\work', limit: 8 }]);
  assert.equal((await handler(null, null)).source, 'invalid');
});

test('runtime resolver honors explicit existing paths', () => {
  const pythonPath = 'C:\\tools\\python.exe';
  const clientPath = 'C:\\tools\\company_drop.py';
  const existing = new Set([pythonPath, clientPath]);
  assert.deepEqual(resolveCompanyDropRuntime({
    env: {
      COMPANY_DROP_PYTHON: pythonPath,
      COMPANY_DROP_CLIENT: clientPath,
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    },
    homeDir: 'C:\\Users\\test',
    existsSync: candidate => existing.has(candidate),
  }), { pythonPath, clientPath });
});

test('renderer HTML exposes the company sync action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /data-action="sync-company"[^>]*>同步到公司<\/button>/);
});
