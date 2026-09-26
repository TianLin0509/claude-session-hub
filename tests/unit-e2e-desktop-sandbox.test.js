'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const sandbox = require('../core/e2e-desktop-sandbox.js');
const { installRendererFakeClipboard } = require('../renderer/e2e-fake-clipboard.js');

const fakeNativeImage = {
  createEmpty: () => ({ isEmpty: () => true, toDataURL: () => '' }),
  createFromDataURL: url => ({ isEmpty: () => !url, toDataURL: () => url }),
};

function fakeWindow() {
  const calls = [];
  let bounds = { x: 100, y: 100, width: 1200, height: 800 };
  const win = {
    calls,
    getSize: () => [bounds.width, bounds.height],
    getBounds: () => ({ ...bounds }),
    setBounds: next => { bounds = { ...bounds, ...next }; calls.push(['setBounds', { ...bounds }]); },
    showInactive: () => calls.push(['showInactive']),
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
    moveTop: () => calls.push(['moveTop']),
    maximize: () => calls.push(['maximize']),
    setFullScreen: () => calls.push(['setFullScreen']),
    center: () => calls.push(['center']),
    setPosition: () => calls.push(['setPosition']),
    setAlwaysOnTop: () => calls.push(['setAlwaysOnTop']),
    flashFrame: () => calls.push(['flashFrame']),
    setSkipTaskbar: value => calls.push(['setSkipTaskbar', value]),
    setFocusable: value => calls.push(['setFocusable', value]),
    isFocused: () => false,
    webContents: {
      setBackgroundThrottling: value => calls.push(['backgroundThrottling', value]),
      debugger: {
        attach: () => calls.push(['debugger.attach']),
        sendCommand: (method, params) => { calls.push([method, params]); return Promise.resolve(); },
      },
    },
  };
  return win;
}

test('a background test window never activates, raises or lands on a monitor', () => {
  const win = sandbox.keepWindowInBackground(fakeWindow());
  win.maximize(); win.show(); win.focus(); win.moveTop(); win.setAlwaysOnTop(true); win.flashFrame(true);
  win.center(); win.setPosition(0, 0); win.setBounds({ x: 0, y: 0, width: 1600, height: 900 });
  const names = win.calls.map(call => call[0]);
  for (const forbidden of ['show', 'focus', 'moveTop', 'maximize', 'center', 'setPosition', 'setAlwaysOnTop', 'flashFrame']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not reach the OS window`);
  }
  assert.ok(names.includes('showInactive'));
  assert.deepEqual(win.calls.find(call => call[0] === 'setSkipTaskbar'), ['setSkipTaskbar', true]);
  assert.deepEqual(win.calls.find(call => call[0] === 'setFocusable'), ['setFocusable', false], 'OS-level no-activate');
  for (const [, bounds] of win.calls.filter(call => call[0] === 'setBounds')) {
    assert.equal(bounds.x, sandbox.OFFSCREEN.x); assert.equal(bounds.y, sandbox.OFFSCREEN.y);
  }
  assert.equal(win.getSize()[0], 1600, 'size requests still apply');
  // Renders and behaves as the focused foreground window.
  assert.deepEqual(win.calls.find(call => call[0] === 'backgroundThrottling'), ['backgroundThrottling', false]);
  assert.deepEqual(win.calls.find(call => call[0] === 'Emulation.setFocusEmulationEnabled'), ['Emulation.setFocusEmulationEnabled', { enabled: true }]);
  assert.equal(win.isFocused(), true);
  assert.equal(sandbox.keepWindowInBackground(win), win, 'idempotent');
});

test('the fake clipboard replaces Main clipboard methods and serves renderers the same store', () => {
  const clipboard = { readText: () => 'REAL', writeText: () => { throw new Error('real clipboard touched'); }, readBuffer() {}, writeBuffer() {}, clear() {} };
  const ipcMain = new EventEmitter();
  const fake = sandbox.installFakeClipboard({ clipboard, nativeImage: fakeNativeImage, ipcMain });
  assert.equal(sandbox.activeFakeClipboard(), fake);
  clipboard.writeText('from main');
  assert.equal(clipboard.readText(), 'from main');

  const rendererClipboard = { readText() { return 'REAL'; }, writeText() { throw new Error('real clipboard touched'); }, readBuffer() {}, writeBuffer() {} };
  const ipcRenderer = { sendSync: (channel, op, args) => { const event = {}; ipcMain.emit(channel, event, op, args); return event.returnValue; } };
  const navigator = { clipboard: { writeText: async () => { throw new Error('real clipboard touched'); }, readText: async () => 'REAL' } };
  installRendererFakeClipboard({ electron: { clipboard: rendererClipboard, ipcRenderer, nativeImage: fakeNativeImage }, navigator });
  assert.equal(rendererClipboard.readText(), 'from main');
  rendererClipboard.writeText('from renderer');
  assert.equal(clipboard.readText(), 'from renderer');
  rendererClipboard.writeBuffer('FileNameW', Buffer.from('C:\\a.txt'));
  assert.equal(rendererClipboard.readBuffer('FileNameW').toString(), 'C:\\a.txt');

  fake.writeFiles(['C:\\one.md', 'C:\\two.md']);
  assert.deepEqual(fake.readFiles(), ['C:\\one.md', 'C:\\two.md']);
  assert.equal(clipboard.readText(), '', 'a file copy replaces earlier text, like the system clipboard');
  return navigator.clipboard.writeText('via navigator').then(async () => {
    assert.equal(clipboard.readText(), 'via navigator');
    assert.equal(await navigator.clipboard.readText(), 'via navigator');
  });
});

test('unsupported renderer clipboard operations fail loudly instead of reaching the OS', () => {
  const ipcMain = new EventEmitter();
  sandbox.installFakeClipboard({ clipboard: {}, nativeImage: fakeNativeImage, ipcMain });
  const event = {};
  ipcMain.emit('e2e:fake-clipboard', event, 'writeFiles', [['C:\\x']]);
  assert.match(event.returnValue.error, /unsupported clipboard op/);
});
