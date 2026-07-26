'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

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

console.log('Running native session fork command contract tests...');

test('Claude branches use --resume <id> plus --fork-session', () => {
  assert.match(
    SRC,
    /claude --resume \$\{opts\.forkCCSessionId\} --fork-session --model \$\{model\}\$\{effortFlag\}/,
    'Claude branch command must inherit the source transcript under a fresh native session id',
  );
});

test('Codex branches use codex fork and preserve model/reasoning/permission flags', () => {
  assert.match(
    SRC,
    /codex fork \$\{opts\.codexForkSid\} --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}\$\{codexReasoningArg\}/,
    'Codex branch command must create a fresh task while preserving Hub launch policy',
  );
});

test('fork source ids are launch-only and are not persisted as the new branch id', () => {
  const infoBlock = SRC.slice(SRC.indexOf('const info = {'), SRC.indexOf('const pendingTimers = []'));
  assert.doesNotMatch(infoBlock, /forkCCSessionId/);
  assert.doesNotMatch(infoBlock, /codexForkSid/);
});

console.log('All native session fork command contract tests passed.');
