'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerPreviewImmersiveIpc, bindPreviewImmersiveWindow } = require('../main/ipc/preview-immersive-handlers');
const { createPreviewImmersiveController } = require('../renderer/preview-immersive');

async function main() {
  const win = new EventEmitter();
  const transitions = [];
  let fullscreen = false;
  win.webContents = new EventEmitter();
  win.webContents.send = () => {};
  win.isDestroyed = () => false;
  win.isFullScreen = () => fullscreen;
  win.setFullScreen = value => { transitions.push(value); fullscreen = value; };
  bindPreviewImmersiveWindow(win);
  let handler;
  registerPreviewImmersiveIpc({ handle: (_name, fn) => { handler = fn; } }, { getMainWindow: () => win });
  assert.equal(handler({ sender: {} }, true).ok, false, 'guest cannot change the Hub window');
  assert.equal(handler({ sender: win.webContents }, 'true').ok, false);
  handler({ sender: win.webContents }, true);
  handler({ sender: win.webContents }, true);
  handler({ sender: win.webContents }, false);
  assert.deepEqual(transitions, [true, false], 'double entry must retain the original state');
  fullscreen = true;
  handler({ sender: win.webContents }, true);
  handler({ sender: win.webContents }, false);
  assert.equal(fullscreen, true, 'retain pre-existing system fullscreen');
  fullscreen = false;
  handler({ sender: win.webContents }, true);
  fullscreen = false;
  win.emit('leave-full-screen');
  handler({ sender: win.webContents }, true);
  handler({ sender: win.webContents }, false);
  assert.equal(fullscreen, false, 'external fullscreen exit releases ownership');
  const guest = new EventEmitter();
  win.webContents.emit('did-attach-webview', {}, guest);
  handler({ sender: win.webContents }, true);
  let prevented = false;
  guest.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, true);
  assert.equal(fullscreen, false, 'guest Escape exits before a page can intercept it');

  const classes = new Set();
  const listeners = {};
  const panel = { style: { display: 'flex' }, classList: { toggle: (key, value) => value ? classes.add(key) : classes.delete(key) } };
  const enter = { addEventListener: (_name, fn) => { listeners.enter = fn; }, setAttribute() {} };
  const exit = { addEventListener: (_name, fn) => { listeners.exit = fn; } };
  const pending = [];
  const controller = createPreviewImmersiveController({
    document: { body: panel, getElementById: id => ({ 'preview-panel': panel, 'preview-layout-immersive': enter, 'preview-immersive-exit': exit }[id]) },
    ipcRenderer: { invoke: (_name, value) => new Promise(resolve => pending.push({ value, resolve })), on() {} },
  });
  listeners.enter();
  controller.exit();
  assert.deepEqual(pending.map(item => item.value), [true, false]);
  pending[0].resolve({ ok: true });
  await Promise.resolve();
  assert.equal(controller.isActive(), false, 'late enter must not cover a closed/switched preview');
  pending[1].resolve({ ok: true });
  await Promise.resolve();
  assert.equal(enter.disabled, false);
  console.log('preview immersive: native ownership, authorization, external exit and navigation race PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
