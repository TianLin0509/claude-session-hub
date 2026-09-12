'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildClaudeNativeArgs, prepareClaudeSettingsOverlay } = require('../core/claude-native-launch');

test('explicit model, effort and literal Windows paths survive transport launch', () => {
  const file = 'C:\\测试 项目\\settings.json';
  const args = buildClaudeNativeArgs({ model: 'claude-opus-5[1m]', effort: 'max',
    permissionMode: 'default', settingsFile: file, appendSystemPromptFile: 'C:\\规则\\prompt.md',
    mcpConfigPaths: ['C:\\测试 目录\\mcp.json'], strictMcpConfig: true });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5[1m]');
  assert.equal(args[args.indexOf('--settings') + 1], file);
  assert.equal(args[args.indexOf('--effort') + 1], 'max');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--bare') && !args.includes('--safe-mode') && !args.includes('bypassPermissions'));
  assert.throws(() => buildClaudeNativeArgs({ model: 'a', effort: 'invented' }), /effort/);
});

test('overlay preserves room plugin policy, fast mode, hooks and permission settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-settings-'));
  const room = path.join(directory, 'room.json');
  const fast = path.join(directory, 'fast.json');
  const settings = { enabledPlugins: { a: false, b: true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'test' }] }] },
    permissions: { allow: ['Read'] } };
  fs.writeFileSync(room, JSON.stringify(settings));
  fs.writeFileSync(fast, JSON.stringify({ fastMode: true }));
  const result = prepareClaudeSettingsOverlay([room, fast], { directory: path.join(directory, 'out'), sessionId: 'session-a' });
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { ...settings, fastMode: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(room, 'utf8')), settings);
  const disabled = prepareClaudeSettingsOverlay([room, fast], { directory: path.join(directory, 'out'), sessionId: 'session-b', overrides: { fastMode: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(disabled, 'utf8')), { ...settings, fastMode: false });
});

test('malformed overlay cannot silently replace configuration with an empty one', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-settings-'));
  const broken = path.join(directory, 'broken.json');
  fs.writeFileSync(broken, '{bad');
  const out = path.join(directory, 'out');
  assert.throws(() => prepareClaudeSettingsOverlay([broken], { directory: out, sessionId: 'session-a' }));
  assert.equal(fs.existsSync(out), false);
});
