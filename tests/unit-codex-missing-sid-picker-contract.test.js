'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RESUME_IPC_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'resume-session-handlers.js'), 'utf8');
const SESSION_MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

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

console.log('Running codex missing sid picker contract tests...');

test('main routes dormant codex without sid to picker resume', () => {
  assert.match(
    RESUME_IPC_SRC,
    /const codexMissingSid = \(isCodexBaseKind\(meta\.kind\) && !meta\.codexSid\);/,
    'resume-session must classify dormant Codex CLI records without codexSid',
  );
  assert.match(
    RESUME_IPC_SRC,
    /codexResumePicker: codexMissingSid,/,
    'resume-session must request Codex picker instead of silent --last for missing sid',
  );
});

test('session-manager supports codexResumePicker without changing kind', () => {
  assert.match(
    SESSION_MANAGER_SRC,
    /kind === 'codex-resume' \|\| kind === 'codex-web-resume' \|\| opts\.codexResumePicker/,
    'session-manager must use picker command for opts.codexResumePicker',
  );
});

console.log('All passed.');
