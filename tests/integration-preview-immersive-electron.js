'use strict';
// Native window transitions on an invisible, nonfocusable test window. The
// regular background Hub deliberately suppresses fullscreen on the desktop.
const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const { registerPreviewImmersiveIpc } = require('../main/ipc/preview-immersive-handlers');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 650, x: -24000, y: -24000, show: false, focusable: false, skipTaskbar: true, opacity: 0 });
  let handler;
  registerPreviewImmersiveIpc({ handle: (_name, fn) => { handler = fn; } }, { getMainWindow: () => win });
  const original = win.getBounds();
  assert.equal(handler({ sender: win.webContents }, true).ok, true);
  await wait(250);
  assert.equal(win.isFullScreen(), true);
  assert.equal(win.isVisible(), false);
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  assert.deepEqual(bounds, display.bounds, 'native fullscreen covers the monitor including taskbar');
  assert.equal(handler({ sender: win.webContents }, false).ok, true);
  await wait(250);
  assert.equal(win.isFullScreen(), false);
  assert.deepEqual(win.getBounds(), original);
  win.hide();
  console.log(JSON.stringify({ passed: true, invisible: !win.isVisible(), fullScreenBounds: bounds, displayBounds: display.bounds, restored: win.getBounds() }));
  win.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
