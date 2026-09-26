'use strict';
const { test } = require('node:test');
const { execFileSync } = require('child_process');
const path = require('path');
test('shared browser migration respects queue ownership, identity and config changes', () => {
  execFileSync('python', [path.join(__dirname, 'unit-hub-browser-migration.py')], { windowsHide: true, timeout: 30000, env: { ...process.env, PYTHONUTF8: '1' } });
});
