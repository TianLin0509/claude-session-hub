'use strict';

// One-shot repair for a running production installation. It fixes Windows
// shortcuts and Jump List metadata without touching or restarting the Hub PID.
const path = require('path');
const { app, shell } = require('electron');
const {
  HUB_APP_USER_MODEL_ID,
  ensureWindowsShellIntegration,
} = require('../core/windows-shell-integration.js');

const appRoot = path.resolve(__dirname, '..');
const iconPath = path.join(appRoot, 'claude-wx.ico');

if (process.platform === 'win32') app.setAppUserModelId(HUB_APP_USER_MODEL_ID);

app.whenReady().then(() => {
  const result = ensureWindowsShellIntegration({
    app,
    shell,
    appRoot,
    execPath: process.execPath,
    isPackaged: false,
    iconPath,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
