'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  discoverSourceFiles,
  scanRepository,
} = require('../scripts/performance-audit.js');

const ROOT = path.resolve(__dirname, '..');

test('performance audit scans every discovered first-party code file exactly once', () => {
  const discovered = discoverSourceFiles(ROOT).map((filePath) => path.relative(ROOT, filePath).replace(/\\/g, '/'));
  const report = scanRepository(ROOT);
  const scanned = report.files.map((file) => file.path);

  assert.ok(discovered.length >= 300, `unexpectedly narrow audit scope: ${discovered.length}`);
  assert.deepEqual(scanned, discovered);
  assert.equal(new Set(scanned).size, scanned.length);
  assert.equal(report.summary.filesDiscovered, report.summary.filesScanned);
  assert.ok(report.files.every((file) => file.scanned && /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('performance audit includes every packaged runtime source root', () => {
  const report = scanRepository(ROOT);
  const runtimePaths = report.files.filter((file) => file.scope === 'runtime').map((file) => file.path);

  assert.ok(runtimePaths.includes('main.js'));
  assert.ok(runtimePaths.includes('main-bootstrap.js'));
  for (const prefix of ['core/', 'main/', 'renderer/', 'scripts/']) {
    assert.ok(runtimePaths.some((filePath) => filePath.startsWith(prefix)), `missing ${prefix}`);
  }
});
