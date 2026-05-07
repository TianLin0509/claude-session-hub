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

console.log('All passed.');
