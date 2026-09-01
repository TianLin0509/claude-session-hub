'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  createHtmlArtifactPreviewRenderer,
  isAllowedPreviewRequest,
} = require('../core/html-artifact-preview.js');

class FakeWebRequest {
  constructor() {
    this.listener = null;
  }

  onBeforeRequest(filter, listener) {
    if (filter === null) {
      this.listener = null;
      return;
    }
    this.filter = filter;
    this.listener = listener;
  }
}

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.webRequest = new FakeWebRequest();
  }

  setPermissionRequestHandler(handler) {
    this.permissionHandler = handler;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.session = new FakeSession();
  }

  setAudioMuted(value) { this.audioMuted = value; }
  setWindowOpenHandler(handler) { this.windowHandler = handler; }
  executeJavaScript() { return Promise.resolve(true); }
  capturePage() {
    return Promise.resolve({
      isEmpty: () => false,
      toPNG: () => Buffer.from('PNG-MOCK'),
    });
  }
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeBrowserWindow.latest = this;
  }

  loadURL(url) {
    this.loadedUrl = url;
    return Promise.resolve();
  }

  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-html-preview-'));
  try {
    const artifactDir = path.join(tempDir, 'artifact');
    const outputDir = path.join(tempDir, 'hub-data');
    fs.mkdirSync(artifactDir, { recursive: true });
    const htmlPath = path.join(artifactDir, '20260901-preview.html');
    const cssPath = path.join(artifactDir, 'style.css');
    const outsidePath = path.join(tempDir, 'outside.css');
    fs.writeFileSync(htmlPath, '<!doctype html><link rel="stylesheet" href="style.css"><h1>成果</h1>', 'utf8');
    fs.writeFileSync(cssPath, 'h1{color:green}', 'utf8');
    fs.writeFileSync(outsidePath, 'body{}', 'utf8');

    assert.equal(isAllowedPreviewRequest(pathToFileURL(cssPath).href, artifactDir), true);
    assert.equal(isAllowedPreviewRequest(pathToFileURL(outsidePath).href, artifactDir), false);
    assert.equal(isAllowedPreviewRequest('https://example.com/tracker.js', artifactDir), false);
    assert.equal(isAllowedPreviewRequest('data:image/png;base64,AA==', artifactDir), true);

    const render = createHtmlArtifactPreviewRenderer({
      BrowserWindow: FakeBrowserWindow,
      getOutputDir: () => outputDir,
      loadTimeoutMs: 2_000,
    });
    const previewPath = await render(htmlPath);
    assert.equal(fs.existsSync(previewPath), true);
    assert.equal(fs.readFileSync(previewPath, 'utf8'), 'PNG-MOCK');

    const win = FakeBrowserWindow.latest;
    assert.equal(win.options.show, false);
    assert.equal(win.options.width, PREVIEW_WIDTH);
    assert.equal(win.options.height, PREVIEW_HEIGHT);
    assert.equal(win.options.webPreferences.offscreen, true);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    assert.equal(win.options.webPreferences.webSecurity, true);
    assert.equal(win.webContents.audioMuted, true);
    assert.deepEqual(win.webContents.windowHandler(), { action: 'deny' });
    assert.equal(win.destroyed, true, 'only the preview window created by the renderer should be destroyed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('unit-html-artifact-preview.test.js OK');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
