'use strict';

// Keep test/branch Hubs on an isolated Chromium profile before main.js starts.
// Production Hubs intentionally share the normal profile and Hub data directory:
// desktop multi-instance startup is a product contract. Shared state is protected
// by state-store's file lock + read/merge/write path, while hook/control resources
// are allocated per process. Do not add requestSingleInstanceLock here again.
const { app } = require('electron');
const path = require('path');

const configuredDataDir = String(process.env.CLAUDE_HUB_DATA_DIR || '').trim();
if (configuredDataDir) {
  app.setPath('userData', path.join(configuredDataDir, 'electron-userdata'));
}

require('./main.js');
