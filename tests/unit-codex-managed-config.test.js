'use strict';
// Hub 生成的 Codex config.toml（DeepSeek、API 模式）只接管自己的顶层键，其余原文保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeHubManagedCodexConfig } = require('../core/codex-managed-config');
const { parseTomlWithPython } = require('../core/codex-hook-integration');

const HUB = [
  'model = "m"',
  'approval_policy = "never"',
  '',
  '[notice]',
  'hide_full_access_warning = true',
  '',
  '[projects."C:\\\\w"]',
  'trust_level = "trusted"',
  '',
].join('\n');

test('non-Hub root keys and tables survive; Hub-owned top-level keys are regenerated', () => {
  const old = [
    'model = "stale"',
    'features.hooks = true',
    "hooks.state.'k0'.trusted_hash = \"sha256:dotted\"",
    '',
    '[notice]',
    'hide_full_access_warning = false',
    '',
    '[projects."C:\\\\old"]',
    'trust_level = "trusted"',
    '',
    "[hooks.state.'k1']",
    'trusted_hash = "sha256:one"',
    '',
    '[tui]',
    'screen_reader_detection_done = true',
  ].join('\r\n');
  const result = mergeHubManagedCodexConfig(old, HUB, { parse: parseTomlWithPython });
  assert.equal(result.warning, null);
  assert.deepEqual(result.preserved.sort(), ['features', 'hooks', 'tui']);
  const doc = parseTomlWithPython(result.text);
  assert.equal(doc.model, 'm');
  assert.deepEqual(doc.notice, { hide_full_access_warning: true });
  assert.deepEqual(Object.keys(doc.projects), ['C:\\w'], 'project trust list is Hub-owned, as before');
  assert.deepEqual(doc.features, { hooks: true });
  assert.deepEqual(doc.hooks.state, { k0: { trusted_hash: 'sha256:dotted' }, k1: { trusted_hash: 'sha256:one' } });
  assert.deepEqual(doc.tui, { screen_reader_detection_done: true });
  // 再合一次结果不变（幂等）。
  assert.equal(mergeHubManagedCodexConfig(result.text, HUB, { parse: parseTomlWithPython }).text, result.text);
});

test('nothing to keep, empty or unreadable old file: plain Hub text, as before', () => {
  assert.equal(mergeHubManagedCodexConfig('', HUB).text, HUB);
  assert.equal(mergeHubManagedCodexConfig('model = "x"\n[notice]\na = 1\n', HUB).text, HUB);
  const bad = mergeHubManagedCodexConfig('[tui\nx = 1\n', HUB);
  assert.equal(bad.text, HUB);
  assert.match(bad.warning, /无法识别/);
});

test('the merge is gated on a semantic diff and falls back to Hub text when it does not match', () => {
  const old = '[tui]\na = 1\n';
  let calls = 0;
  const lying = text => { calls += 1; const doc = parseTomlWithPython(text); if (calls === 3) doc.tui.a = 2; return doc; };
  const result = mergeHubManagedCodexConfig(old, HUB, { parse: lying });
  assert.equal(result.text, HUB);
  assert.match(result.warning, /语义与预期不一致/);
});

test('the Codex API profile also goes through the preserving writer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const body = src.slice(src.indexOf('function ensureCodexApiProfile'), src.indexOf('function isCodexApiBackend'));
  assert.match(body, /writeHubManagedCodexConfig\(path\.join\(codexHome, 'config\.toml'\)/);
  assert.doesNotMatch(body, /writeFileSync\(path\.join\(codexHome, 'config\.toml'\)/);
});
