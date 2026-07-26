'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const SESSION_MANAGER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'session-manager.js'), 'utf8');
const RESUME_IPC_SRC = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'resume-session-handlers.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running resume title preservation contract tests...');

test('renderer guards OSC and statusline title sync with shared helper', () => {
  assert.match(RENDERER_SRC, /shouldAcceptExternalSessionTitle\(s,\s*clean\)/);
  assert.match(RENDERER_SRC, /shouldAcceptExternalSessionTitle\(session,\s*cleanSessionName\)/);
});

test('dormant resume forwards userRenamed and locks stable titles', () => {
  assert.match(RENDERER_SRC, /userRenamed:\s*!!dormant\.userRenamed/);
  assert.match(RENDERER_SRC, /autoTitleGenerated:\s*!!dormant\.autoTitleGenerated\s*\|\|\s*isStableSessionTitle\(dormant\.title,\s*dormant\.kind\)/);
});

test('dormant restore treats stable persisted titles as protected', () => {
  assert.match(RENDERER_SRC, /autoTitleGenerated:\s*!!meta\.autoTitleGenerated\s*\|\|\s*isStableSessionTitle\(meta\.title,\s*meta\.kind\)/);
});

test('backend resume and session manager preserve title protection flags', () => {
  assert.match(RESUME_IPC_SRC, /userRenamed:\s*!!meta\.userRenamed/);
  assert.match(RESUME_IPC_SRC, /autoTitleGenerated:\s*!!meta\.autoTitleGenerated\s*\|\|\s*isStableSessionTitle\(meta\.title,\s*meta\.kind\)/);
  assert.match(SESSION_MANAGER_SRC, /\.\.\.\(opts\.userRenamed \? \{ userRenamed: true \} : \{\}\)/);
});

console.log('Resume title preservation contract tests passed.');
