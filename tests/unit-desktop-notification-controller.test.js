'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createDesktopNotificationController,
  normalizeDesktopNotificationPayload,
  notificationBounds,
} = require('../main/desktop-notification-controller.js');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }
  send(...args) { this.messages.push(args); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.hidden = true;
    FakeWindow.instances.push(this);
  }
  loadFile(value) {
    this.loadedFile = value;
    if (FakeWindow.failLoad) return Promise.reject(new Error('fixture load failure'));
    queueMicrotask(() => this.webContents.emit('did-finish-load'));
    return Promise.resolve();
  }
  isDestroyed() { return this.destroyed; }
  setAlwaysOnTop(...args) { this.alwaysOnTop = args; }
  setMenuBarVisibility(value) { this.menuVisible = value; }
  setBounds(value) { this.bounds = value; }
  showInactive() { this.hidden = false; this.showInactiveCount = (this.showInactiveCount || 0) + 1; }
  hide() { this.hidden = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
FakeWindow.instances = [];
FakeWindow.failLoad = false;

function fakeIpc() {
  const emitter = new EventEmitter();
  return {
    on: (channel, fn) => emitter.on(channel, fn),
    removeListener: (channel, fn) => emitter.removeListener(channel, fn),
    emit: (channel, ...args) => emitter.emit(channel, ...args),
    listenerCount: channel => emitter.listenerCount(channel),
  };
}

test('payload normalization rejects missing session identity and clamps counts', () => {
  assert.equal(normalizeDesktopNotificationPayload({ title: 'missing' }), null);
  const value = normalizeDesktopNotificationPayload({
    sessionId: 's-1', title: ' A\n task ', body: ' done\r\n now ', readyCount: 400,
  });
  assert.equal(value.title, 'A task');
  assert.equal(value.body, 'done now');
  assert.equal(value.readyCount, 99);
});

test('notification anchors inside the main window display work area', () => {
  const bounds = notificationBounds({
    getDisplayMatching: () => ({ workArea: { x: 100, y: 50, width: 1200, height: 800 } }),
  }, { isDestroyed: () => false, getBounds: () => ({ x: 400, y: 200, width: 800, height: 600 }) });
  assert.deepEqual(bounds, { x: 890, y: 660, width: 392, height: 172 });
});

test('one custom BrowserWindow is reused and clicking routes to the exact session', async () => {
  FakeWindow.instances.length = 0;
  const ipcMain = fakeIpc();
  const rendererMessages = [];
  let focused = 0;
  const mainWebContents = {};
  const mainWindow = {
    webContents: mainWebContents,
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
  };
  const timers = [];
  const controller = createDesktopNotificationController({
    BrowserWindow: FakeWindow,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
    ipcMain,
    htmlPath: 'desktop-notification.html',
    preloadPath: 'desktop-notification-preload.js',
    getMainWindow: () => mainWindow,
    focusPrimaryWindow: () => { focused += 1; },
    sendToRenderer: (...args) => rendererMessages.push(args),
    setTimeoutFn: fn => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
    waitForPaint: async () => {},
  });

  await controller.show({ sessionId: 'one', title: 'First', body: 'Done' });
  await controller.show({ sessionId: 'two', title: 'Second', body: 'Done again', readyCount: 2 });
  assert.equal(FakeWindow.instances.length, 1);
  const win = FakeWindow.instances[0];
  assert.equal(win.showInactiveCount, 2);
  assert.equal(win.webContents.messages.length, 2);
  assert.equal(win.webContents.messages[1][1].sessionId, 'two');

  ipcMain.emit('desktop-notification:open', { sender: win.webContents }, { sessionId: 'two' });
  assert.equal(focused, 1);
  assert.deepEqual(rendererMessages, [['desktop-notification:open-session', { sessionId: 'two' }]]);
  assert.equal(win.destroyed, true);

  controller.dispose();
  assert.equal(ipcMain.listenerCount('desktop-notification:show'), 0);
});

test('show IPC rejects senders other than the main Hub renderer', async () => {
  FakeWindow.instances.length = 0;
  const ipcMain = fakeIpc();
  const mainWebContents = {};
  const controller = createDesktopNotificationController({
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 700 } }) },
    ipcMain,
    htmlPath: 'notification.html',
    preloadPath: 'preload.js',
    getMainWindow: () => ({ webContents: mainWebContents, isDestroyed: () => false, getBounds: () => ({}) }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    waitForPaint: async () => {},
  });
  ipcMain.emit('desktop-notification:show', { sender: {} }, { sessionId: 'blocked' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(FakeWindow.instances.length, 0);
  ipcMain.emit('desktop-notification:show', { sender: mainWebContents }, { sessionId: 'allowed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(FakeWindow.instances.length, 1);
  controller.dispose();
});

test('notification UI load failure settles instead of hanging the completion path', async () => {
  FakeWindow.instances.length = 0;
  FakeWindow.failLoad = true;
  const warnings = [];
  const controller = createDesktopNotificationController({
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 700 } }) },
    ipcMain: fakeIpc(),
    htmlPath: 'missing.html',
    preloadPath: 'preload.js',
    getMainWindow: () => null,
    logger: { warn: (...args) => warnings.push(args) },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    waitForPaint: async () => {},
  });
  assert.equal(await controller.show({ sessionId: 'load-failure' }), false);
  assert.equal(warnings.length, 1);
  controller.dispose();
  FakeWindow.failLoad = false;
});
