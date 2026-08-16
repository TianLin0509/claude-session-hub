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

test('session-updated and dormant wake keep Codex resume identity synchronized', () => {
  assert.match(RENDERER_SRC, /if \(session\.codexSid\) local\.codexSid = session\.codexSid;/);
  assert.match(RENDERER_SRC, /if \(session\.codexProfile\) local\.codexProfile = session\.codexProfile;/);
  assert.match(RENDERER_SRC, /const existingPending = _pendingDormantResumes\.get\(hubId\);/);
  assert.match(RENDERER_SRC, /return existingPending\.promise \|\| null;/);
  assert.match(RENDERER_SRC, /pendingResume\.promise = ipcRenderer\.invoke\('resume-session'/);
});

console.log('All passed.');
