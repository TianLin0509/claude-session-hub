'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rendererSource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'renderer.js'),
  'utf8',
);
const utilitySource = fs.readFileSync(
  path.join(__dirname, '..', 'main', 'ipc', 'app-utility-handlers.js'),
  'utf8',
);
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const desktopControllerSource = fs.readFileSync(
  path.join(__dirname, '..', 'main', 'desktop-notification-controller.js'),
  'utf8',
);

assert.ok(
  !rendererSource.includes("ipcRenderer.send('show-notification'"),
  'renderer must not request native toast notifications',
);
assert.ok(
  !utilitySource.includes("ipcMain.on('show-notification'"),
  'main process must not expose native toast notification IPC',
);
assert.ok(
  !/\bnew\s+Notification\s*\(/.test(mainSource + desktopControllerSource),
  'Windows-controlled Electron Notification UI must not return',
);
assert.match(
  mainSource,
  /createDesktopNotificationController\(/,
  'main process must install the Hub-rendered notification card',
);
assert.match(
  rendererSource,
  /createSessionReadyNotifier\(/,
  'renderer must gate notifications through completed-unread state transitions',
);
assert.match(
  desktopControllerSource,
  /desktop-notification:show/,
  'custom desktop notification IPC must be explicit',
);

console.log('PASS native toast stays disabled and Hub-rendered notification is enabled');
