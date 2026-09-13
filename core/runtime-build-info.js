'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
let cached;
function runtimeBuildInfo() {
  if (cached) return cached;
  const root = path.resolve(__dirname, '..');
  const hash = createHash('sha256');
  // Read once: changing package.json cannot change a process's loaded code.
  for (const file of ['core/codex-runtime-broker.js', 'core/codex-native-session.js',
    'core/claude-native-session.js', 'core/claude-broker-session.js',
    'core/shared-content-codec.js', 'main/codex-runtime-broker-process.js']) {
    hash.update(file).update(fs.readFileSync(path.join(root, file)));
  }
  cached = Object.freeze({ version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    fingerprint: hash.digest('hex') });
  return cached;
}
module.exports = { runtimeBuildInfo };
