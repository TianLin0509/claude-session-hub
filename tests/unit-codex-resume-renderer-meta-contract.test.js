'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Running codex resume renderer meta contract tests...');

test('session-meta-updated overwrites stale codexSid', () => {
  assert.match(
    RENDERER_SRC,
    /if \(ev\.codexSid\) s\.codexSid = ev\.codexSid;/,
    'renderer must overwrite stale codexSid when CodexTap binds the selected rollout',
  );
});

console.log('All passed.');
