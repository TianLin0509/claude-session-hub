'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('main process preserves the desktop multi-instance startup contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /app\.requestSingleInstanceLock\(\)/,
    'desktop Hub must not reject a second production instance');
  assert.doesNotMatch(source, /app\.on\('second-instance'/,
    'desktop Hub must not redirect a second launch back to the first window');
});
