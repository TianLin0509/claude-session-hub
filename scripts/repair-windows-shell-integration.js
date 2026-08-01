'use strict';

// One-shot repair for a running production installation. It fixes Windows
// shortcuts and Jump List metadata without touching or restarting the Hub PID.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, shell } = require('electron');
const {
  HUB_APP_USER_MODEL_ID,
  ensureWindowsShellIntegration,
} = require('../core/windows-shell-integration.js');

const appRoot = path.resolve(__dirname, '..');
const iconPath = path.join(appRoot, 'claude-wx.ico');

// This helper is a separate Electron process. Keep Chromium caches isolated
// from every running production Hub while still using app.getPath('appData')
// for the real Start Menu location.
app.setPath('userData', path.join(os.tmpdir(), 'ai-hub-shell-repair'));

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
  result.shortcutExistsBeforeExit = !!(result.shortcutPath && fs.existsSync(result.shortcutPath));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setTimeout(() => {
    process.stdout.write(`shortcutExistsAfter1s=${!!(result.shortcutPath && fs.existsSync(result.shortcutPath))}\n`);
    app.exit(0);
  }, 1000);
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
