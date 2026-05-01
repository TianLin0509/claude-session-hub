'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dismissCodexUpdatePrompt } = require('../core/session-manager.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-version-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function readVersion(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.codex', 'version.json'), 'utf8'));
}

function testDismissesLatestVersion() {
  const home = makeHome();
  fs.writeFileSync(
    path.join(home, '.codex', 'version.json'),
    JSON.stringify({
      latest_version: '0.128.0',
      last_checked_at: '2026-05-01T02:57:01.713222200Z',
      dismissed_version: '0.125.0',
    }),
    'utf8'
  );

  assert.strictEqual(dismissCodexUpdatePrompt(home), true);
  assert.strictEqual(readVersion(home).dismissed_version, '0.128.0');
  fs.rmSync(home, { recursive: true, force: true });
}

function testNoopsWhenAlreadyDismissed() {
  const home = makeHome();
  fs.writeFileSync(
    path.join(home, '.codex', 'version.json'),
    JSON.stringify({ latest_version: '0.128.0', dismissed_version: '0.128.0' }),
    'utf8'
  );

  assert.strictEqual(dismissCodexUpdatePrompt(home), false);
  assert.strictEqual(readVersion(home).dismissed_version, '0.128.0');
  fs.rmSync(home, { recursive: true, force: true });
}

function testBadJsonDoesNotThrow() {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.codex', 'version.json'), '{bad json', 'utf8');

  assert.doesNotThrow(() => dismissCodexUpdatePrompt(home));
  assert.strictEqual(dismissCodexUpdatePrompt(home), false);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('Running codex update-dismiss unit tests...');
testDismissesLatestVersion();
console.log('  ✓ testDismissesLatestVersion');
testNoopsWhenAlreadyDismissed();
console.log('  ✓ testNoopsWhenAlreadyDismissed');
testBadJsonDoesNotThrow();
console.log('  ✓ testBadJsonDoesNotThrow');
console.log('All passed.');
