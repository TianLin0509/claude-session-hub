'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const snapshotPath = path.resolve(__dirname, '..', 'core', 'terminal-snapshot.js');
const managerPath = path.resolve(__dirname, '..', 'core', 'session-manager.js');
const originalLoad = Module._load;

try {
  Module._load = function missingSnapshotDependency(request, parent, isMain) {
    if (request === '@xterm/headless' || request === '@xterm/addon-serialize') {
      const error = new Error(`Cannot find module '${request}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[snapshotPath];
  delete require.cache[managerPath];

  // Importing SessionManager must remain safe even when snapshot acceleration
  // is unavailable. Its per-session constructor guard owns the raw-ring fallback.
  assert.doesNotThrow(() => require(managerPath));
  const { TerminalSnapshot } = require(snapshotPath);
  assert.throws(
    () => new TerminalSnapshot(),
    error => error && error.code === 'TERMINAL_SNAPSHOT_DEPENDENCY_MISSING'
      && /Cannot find module '@xterm\/headless'/.test(error.message),
  );
} finally {
  Module._load = originalLoad;
  delete require.cache[snapshotPath];
  delete require.cache[managerPath];
}

console.log('unit-terminal-snapshot-dependency-fallback: PASS');
