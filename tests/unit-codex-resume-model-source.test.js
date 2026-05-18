'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

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

console.log('Running codex resume model source tests...');

test('precise codex resume carries explicit --model', () => {
  assert.match(
    SRC,
    /codex resume \$\{opts\.codexSid\} --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'codex resume <sid> must carry --model ${codexModel}',
  );
});

test('codex resume --last carries explicit --model', () => {
  assert.match(
    SRC,
    /codex resume --last --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'codex resume --last must carry --model ${codexModel}',
  );
});

test('codex picker resume carries explicit --model', () => {
  assert.match(
    SRC,
    /codex resume --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'codex resume picker path must carry --model ${codexModel}',
  );
});

test('codex picker resume enables mtime fallback binding', () => {
  assert.match(
    SRC,
    /\(kind === 'codex-resume'\s*\|\|\s*opts\.codexResumePicker\s*\|\|\s*\(opts\.useResume && !opts\.codexSid\)\)/,
    'codex-resume picker must bind old rollout files by fresh mtime after user selects a session',
  );
});

test('codex PTY sessions default to high reasoning effort', () => {
  assert.match(
    SRC,
    /CODEX_REASONING_CONFIG_ARG = ` -c 'model_reasoning_effort="\$\{CODEX_REASONING_EFFORT\}"'`/,
    'codex command builder must define a reasoning-effort override',
  );
  assert.match(
    SRC,
    /const CODEX_REASONING_EFFORT = 'high';/,
    'codex reasoning-effort override must default to high',
  );
  const commandUses = SRC.match(/\$\{CODEX_REASONING_CONFIG_ARG\}/g) || [];
  assert.ok(commandUses.length >= 6, 'new/resume/relaunch codex commands must include high reasoning override');
});

console.log('All passed.');
