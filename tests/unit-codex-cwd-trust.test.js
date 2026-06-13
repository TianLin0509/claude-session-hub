'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _private } = require('../core/session-manager.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-trust-'));
const codexHome = path.join(tmp, 'codex-home');
const projectDir = path.join(tmp, 'Hub-Committee-Live', 'Workspaces', 'ABC-123');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });

const cfgPath = path.join(codexHome, 'config.toml');
const originalKey = path.resolve(projectDir);
fs.writeFileSync(cfgPath, `[projects.'${originalKey}']\ntrust_level = "trusted"\n`, 'utf8');

_private.ensureCodexCwdTrusted(projectDir, codexHome);

const cfg = fs.readFileSync(cfgPath, 'utf8');
assert.ok(
  cfg.includes(`[projects.'${originalKey}']`),
  'original-case Codex project trust entry should be preserved'
);
assert.ok(
  cfg.includes(`[projects.'${originalKey.toLowerCase()}']`),
  'lower-case Codex project trust entry should be added for Codex 0.137 cwd lookup'
);

_private.ensureCodexCwdTrusted(projectDir, codexHome);
const cfg2 = fs.readFileSync(cfgPath, 'utf8');
assert.strictEqual(
  (cfg2.match(/\[projects\.'/g) || []).length,
  2,
  'Codex project trust preflight should remain idempotent'
);

console.log('Codex cwd trust preflight: ok');
