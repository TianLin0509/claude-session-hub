'use strict';

// Acquire ownership before loading main.js. The runtime performs state repair,
// opens hook servers and constructs PTYs at module scope, so checking later in
// app.whenReady would still let a losing process touch the shared data dir.
const { app } = require('electron');
const path = require('path');

const configuredDataDir = String(process.env.CLAUDE_HUB_DATA_DIR || '').trim();
if (configuredDataDir) {
  app.setPath('userData', path.join(configuredDataDir, 'electron-userdata'));
}

const lockDataDir = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.resolve(app.getPath('userData'));
const hasPrimaryDataDirLock = app.requestSingleInstanceLock({ dataDir: lockDataDir });

if (!hasPrimaryDataDirLock) {
  // Focus is requested through Electron's second-instance event in the owner.
  // The losing process never imports the state/PTY runtime.
  app.quit();
} else {
  let runtime = null;
  let pendingFocus = false;
  app.on('second-instance', () => {
    if (runtime && typeof runtime.focusPrimaryWindow === 'function') {
      runtime.focusPrimaryWindow();
    } else {
      pendingFocus = true;
    }
  });

  runtime = require('./main.js');
  if (pendingFocus && runtime && typeof runtime.focusPrimaryWindow === 'function') {
    runtime.focusPrimaryWindow();
  }
}
