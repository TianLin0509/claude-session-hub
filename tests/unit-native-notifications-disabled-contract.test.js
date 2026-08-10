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

assert.ok(
  !rendererSource.includes("ipcRenderer.send('show-notification'"),
  'renderer must not request native toast notifications',
);
assert.ok(
  !utilitySource.includes("ipcMain.on('show-notification'"),
  'main process must not expose native toast notification IPC',
);

console.log('PASS native Hub toast notifications stay disabled');
