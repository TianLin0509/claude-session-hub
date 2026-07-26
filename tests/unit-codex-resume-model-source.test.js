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
    'codex resume picker variants must bind old rollout files by fresh mtime after user selects a session',
  );
});

test('codex PTY sessions default to xhigh reasoning effort and silent full access', () => {
  assert.match(
    SRC,
    /model_reasoning_effort="\$\{effort\}"/,
    'codex command builder must define a reasoning-effort override',
  );
  assert.match(
    SRC,
    /approval_policy="never"/,
    'codex command builder must force approval_policy=never',
  );
  assert.match(
    SRC,
    /sandbox_mode="danger-full-access"/,
    'codex command builder must force sandbox_mode=danger-full-access',
  );
  assert.match(
    SRC,
    /windows\.sandbox="unelevated"/,
    'codex command builder must avoid elevated Windows sandbox setup',
  );
  assert.match(
    SRC,
    /notice\.hide_full_access_warning=true/,
    'codex command builder must hide full-access warning UI',
  );
  assert.match(
    SRC,
    /const CODEX_REASONING_EFFORT = 'xhigh';/,
    'codex reasoning-effort override must default to xhigh',
  );
  const commandUses = SRC.match(/\$\{codexReasoningArg\}/g) || [];
  assert.ok(commandUses.length >= 6, 'new/resume/relaunch codex commands must include dynamic reasoning override');
});

test('group-chat Codex sessions cannot downgrade reasoning effort', () => {
  const groupReasoningConst = 'CODEX_GROUP_CHAT_' + 'REASONING_EFFORT';
  assert.doesNotMatch(
    SRC,
    new RegExp(groupReasoningConst),
    'group-chat Codex must not have a separate lower reasoning tier',
  );
  assert.doesNotMatch(
    SRC,
    /meetingId\s*\?\s*[^:]+:\s*CODEX_REASONING_EFFORT/,
    'meeting sessions must not branch to a lower Codex reasoning effort',
  );
  assert.match(
    SRC,
    /const codexReasoningArg = buildCodexReasoningConfigArg\(CODEX_REASONING_EFFORT\);/,
    'fresh/resume/relaunch Codex commands must all use the shared xhigh effort',
  );
});

test('codex API profile uses the same xhigh reasoning effort default', () => {
  assert.match(
    SRC,
    /model_reasoning_effort = \$\{tomlString\(CODEX_REASONING_EFFORT\)\}/,
    'isolated Codex API profile config.toml must use the shared reasoning-effort default',
  );
  assert.match(
    SRC,
    /'sandbox = "unelevated"'/,
    'isolated Codex API profile config.toml must avoid elevated Windows sandbox setup',
  );
});

console.log('All passed.');
