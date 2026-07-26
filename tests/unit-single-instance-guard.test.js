'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('main process rejects a second Hub sharing the same Electron userData', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /app\.on\('second-instance'/);
  assert.match(source, /if \(!hasSingleInstanceLock\) return;/);
  assert.match(source, /mainWindow\.focus\(\)/);
});
