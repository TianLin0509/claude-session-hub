'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dismissCodexRateLimitDialog } = require('../core/session-manager.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-rl-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function readConfig(home) {
  return fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
}

function assertSilentFullAccessConfig(c) {
  assert.match(c, /\[notice\]/);
  assert.match(c, /hide_rate_limit_model_nudge\s*=\s*true/);
  assert.match(c, /hide_full_access_warning\s*=\s*true/);
  assert.match(c, /\[windows\]/);
  assert.match(c, /sandbox\s*=\s*"unelevated"/);
}

function testCreatesFileWhenMissing() {
  const home = makeHome();
  assert.strictEqual(dismissCodexRateLimitDialog(home), true);
  assertSilentFullAccessConfig(readConfig(home));
  fs.rmSync(home, { recursive: true, force: true });
}

function testIdempotentWhenAllSettingsAlreadyTrue() {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
    'model = "gpt-5.5"',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
  ].join('\n'), 'utf8');
  const before = readConfig(home);
  assert.strictEqual(dismissCodexRateLimitDialog(home), false, 'already complete config should not rewrite');
  assert.strictEqual(readConfig(home), before, 'content must remain byte-for-byte unchanged');
  fs.rmSync(home, { recursive: true, force: true });
}

function testCompletesPartialExistingNoticeSection() {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
    'model = "gpt-5.5"',
    '',
    '[notice]',
    'some_other_setting = "x"',
    'hide_rate_limit_model_nudge = true',
    '',
  ].join('\n'), 'utf8');
  assert.strictEqual(dismissCodexRateLimitDialog(home), true);
  const c = readConfig(home);
  assert.strictEqual((c.match(/^\[notice\]$/gm) || []).length, 1, '[notice] should appear once');
  assert.match(c, /some_other_setting\s*=\s*"x"/);
  assertSilentFullAccessConfig(c);
  fs.rmSync(home, { recursive: true, force: true });
}

function testAppendsMissingSectionsAtEnd() {
  const home = makeHome();
  const original = [
    'model = "gpt-5.5"',
    'approval_policy = "never"',
    '',
    '[features]',
    'codex_hooks = true',
    '',
    "[projects.'C:\\\\Users\\\\lintian']",
    'trust_level = "trusted"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), original, 'utf8');

  assert.strictEqual(dismissCodexRateLimitDialog(home), true);
  const c = readConfig(home);
  assert.match(c, /model = "gpt-5.5"/);
  assert.match(c, /approval_policy = "never"/);
  assert.match(c, /\[features\]/);
  assert.match(c, /codex_hooks = true/);
  assert.match(c, /trust_level = "trusted"/);
  assert.strictEqual((c.match(/^\[notice\]$/gm) || []).length, 1);
  assert.strictEqual((c.match(/^\[windows\]$/gm) || []).length, 1);
  assertSilentFullAccessConfig(c);
  fs.rmSync(home, { recursive: true, force: true });
}

function testHonorsCustomConfigDir() {
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-api-'));
  assert.strictEqual(dismissCodexRateLimitDialog(undefined, customDir), true);
  assertSilentFullAccessConfig(fs.readFileSync(path.join(customDir, 'config.toml'), 'utf8'));
  fs.rmSync(customDir, { recursive: true, force: true });
}

function testDoesNotThrowOnIoError() {
  const bogus = path.join(os.tmpdir(), 'nonexistent-' + Date.now(), 'deeply', 'nested');
  assert.doesNotThrow(() => dismissCodexRateLimitDialog(undefined, bogus));
  fs.rmSync(bogus, { recursive: true, force: true });
}

console.log('Running codex silent full-access config unit tests...');
testCreatesFileWhenMissing();
console.log('  PASS testCreatesFileWhenMissing');
testIdempotentWhenAllSettingsAlreadyTrue();
console.log('  PASS testIdempotentWhenAllSettingsAlreadyTrue');
testCompletesPartialExistingNoticeSection();
console.log('  PASS testCompletesPartialExistingNoticeSection');
testAppendsMissingSectionsAtEnd();
console.log('  PASS testAppendsMissingSectionsAtEnd');
testHonorsCustomConfigDir();
console.log('  PASS testHonorsCustomConfigDir');
testDoesNotThrowOnIoError();
console.log('  PASS testDoesNotThrowOnIoError');
console.log('All passed.');
