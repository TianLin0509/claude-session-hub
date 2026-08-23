'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isPackagedHubRuntime } = require('../core/electron-runtime-mode.js');

test('renamed Electron default-app host remains source mode', () => {
  assert.equal(isPackagedHubRuntime({ appIsPackaged: true, defaultApp: true }), false);
});

test('real packaged Hub remains packaged mode', () => {
  assert.equal(isPackagedHubRuntime({ appIsPackaged: true, defaultApp: false }), true);
});

test('stock Electron source launch remains source mode', () => {
  assert.equal(isPackagedHubRuntime({ appIsPackaged: false, defaultApp: true }), false);
});

test('main routes shell and hook paths through the corrected runtime mode', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /const HUB_IS_PACKAGED = isPackagedHubRuntime\(/);
  assert.match(mainSource, /isPackaged:\s*HUB_IS_PACKAGED/);
  assert.doesNotMatch(mainSource, /isPackaged:\s*app\.isPackaged/);
  assert.equal((mainSource.match(/const (?:srcDir|hookSourceScriptsDir) = HUB_IS_PACKAGED/g) || []).length, 2);
});
