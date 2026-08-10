'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const SESSION_CAPABILITIES_SRC = fs.readFileSync(path.join(ROOT, 'core', 'session-capabilities.js'), 'utf8');
const SESSION_MANAGER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'session-manager.js'), 'utf8');
const RESUME_IPC_SRC = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'resume-session-handlers.js'), 'utf8');
const PERSISTENCE_SRC = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'persistence-handlers.js'), 'utf8');

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
  assert.match(RENDERER_SRC, /buildSessionResumeMeta\(dormant\)/);
  assert.match(SESSION_CAPABILITIES_SRC, /userRenamed:\s*!!session\.userRenamed/);
  assert.match(SESSION_CAPABILITIES_SRC, /autoTitleGenerated:\s*!session\.branchAutoTitlePending\s*\n?\s*&&\s*\(!!session\.autoTitleGenerated\s*\|\|\s*isStableSessionTitle\(session\.title,\s*session\.kind\)\)/);
});

test('dormant restore treats stable persisted titles as protected', () => {
  assert.match(RENDERER_SRC, /autoTitleGenerated:\s*!meta\.branchAutoTitlePending\s*&&\s*\(!!meta\.autoTitleGenerated\s*\|\|\s*isStableSessionTitle\(meta\.title,\s*meta\.kind\)\)/);
});

test('backend resume and session manager preserve title protection flags', () => {
  assert.match(RESUME_IPC_SRC, /userRenamed:\s*!!meta\.userRenamed/);
  assert.match(RESUME_IPC_SRC, /autoTitleGenerated:\s*!meta\.branchAutoTitlePending\s*&&\s*\(!!meta\.autoTitleGenerated\s*\|\|\s*isStableSessionTitle\(meta\.title,\s*meta\.kind\)\)/);
  assert.match(SESSION_MANAGER_SRC, /\.\.\.\(opts\.userRenamed \? \{ userRenamed: true \} : \{\}\)/);
});

test('pending branch auto-title state survives persist and resume', () => {
  assert.match(PERSISTENCE_SRC, /'branchSourceSessionId'/);
  assert.match(PERSISTENCE_SRC, /'branchAutoTitlePending'/);
  assert.match(RENDERER_SRC, /branchSourceSessionId:\s*s\.branchSourceSessionId \|\| null/);
  assert.match(RENDERER_SRC, /branchAutoTitlePending:\s*!!s\.branchAutoTitlePending/);
  assert.match(SESSION_CAPABILITIES_SRC, /branchSourceSessionId:\s*session\.branchSourceSessionId \|\| null/);
  assert.match(RESUME_IPC_SRC, /branchAutoTitlePending:\s*meta\.branchAutoTitlePending/);
});

console.log('Resume title preservation contract tests passed.');
