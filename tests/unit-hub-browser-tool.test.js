'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { argumentsOf, validateBinding, BrowserTool, integrationStatus } = require('../core/hub-browser-tool');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tools-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, id: 'images-main-1', tool: 'images', identity: 'main', playwright: path.join(root, 'playwright.js') };
}
test('compatibility argument parsing accepts both existing Python call conventions', () => {
  assert.deepEqual(argumentsOf(['--session', 'chatgpt-bridge', '--json', 'run-code', '--filename', 'x.js']), ['run-code', '--filename', 'x.js']);
});
test('an isolated runtime cannot attach the production browser, even with a production binding', t => {
  const binding = fixture(t);
  assert.throws(() => validateBinding(binding, { CLAUDE_HUB_HOME_DIR: path.join(binding.root, 'isolated') }), /Isolated/);
  assert.throws(() => validateBinding({ ...binding, identity: 'guess' }, {}), /Invalid/);
});
test('shared mode never imports cookies and preserves standalone login snapshots', async t => {
  const binding = fixture(t), tool = new BrowserTool(binding, { env: {} });
  const state = path.join(binding.root, 'auth-state.json');
  const original = JSON.stringify({ cookies: [{ value: 'SECRET' }], origins: [] });
  fs.writeFileSync(state, original);
  assert.equal((await tool.execute(['state-load', state])).imported, false);
  assert.equal((await tool.execute(['state-save', state])).exported, false);
  assert.equal(fs.readFileSync(state, 'utf8'), original);
  await tool.execute(['state-save', state + '.new']);
  assert.equal(fs.readFileSync(state + '.new', 'utf8'), original);
});
test('integration badges require matching actual tool configuration, not just a manifest', t => {
  const b = fixture(t), config = path.join(b.root, 'config.json'), entry = path.join(b.root, 'entry.cjs');
  assert.equal(integrationStatus(b.root)[0].state, 'pending');
  fs.writeFileSync(path.join(b.root, 'tool-bindings.json'), JSON.stringify({ tools: [{ id: b.id, tool: 'images', identity: 'main', config, entry }] }));
  fs.writeFileSync(config, JSON.stringify({ cli_entry: entry }));
  assert.equal(integrationStatus(b.root)[0].state, 'changed');
  fs.writeFileSync(entry, 'fixture');
  assert.equal(integrationStatus(b.root)[0].state, 'connected');
  fs.writeFileSync(config, JSON.stringify({ cli_entry: 'different' }));
  assert.equal(integrationStatus(b.root)[0].state, 'changed');
});
