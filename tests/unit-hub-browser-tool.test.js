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
// Shared challenge/handoff rules (core/web-risk-guard.js) at the transport every tool uses.
const guard = require('../core/web-risk-guard');
function pageTool(binding, page) {
  const hub = { endpoint: async () => ({ port: 1, ws: 'ws://x' }), markerUrl: () => 'file:///m', lifecycle: fn => fn() };
  const tool = new BrowserTool(binding, { env: {}, hub });
  tool.target = async () => ({ targetId: 'T', ep: { port: 1 } });
  tool.connectPage = async target => { assert.equal(target.targetId, 'T'); return { page, close: async () => {} }; };
  return tool;
}
test('steps are refused while a person has the browser, with a category tools can map', async t => {
  const binding = fixture(t), visited = [];
  const tool = pageTool(binding, { url: () => 'https://chatgpt.com/', goto: async u => visited.push(u), evaluate: async () => ({ challenge: false }) });
  const lease = guard.startHandoff(binding.root, { identity: 'alt', site: 'chatgpt' });
  await assert.rejects(tool.execute(['goto', 'https://chatgpt.com/']), /^Error: Human handoff/);
  await assert.rejects(tool.execute(['open', 'about:blank']), /^Error: Human handoff/);
  assert.deepEqual(visited, []);
  guard.endHandoff(binding.root, lease.id);
  await tool.execute(['goto', 'https://chatgpt.com/']);
  assert.deepEqual(visited, ['https://chatgpt.com/']);
});
test('a navigation that meets a challenge leaves the page and pauses only that identity and site', async t => {
  const binding = fixture(t), visited = [];
  const tool = pageTool(binding, { url: () => 'https://chatgpt.com/', goto: async u => visited.push(u), evaluate: async () => ({ challenge: true, kind: 'cloudflare' }) });
  await assert.rejects(tool.execute(['goto', 'https://chatgpt.com/']), /^Error: Site challenged/);
  assert.deepEqual(visited, ['https://chatgpt.com/', 'about:blank']);
  assert.ok(guard.blocked(binding.root, 'main', 'chatgpt'));
  await assert.rejects(tool.execute(['goto', 'https://chatgpt.com/c/next']), /^Error: Site challenged/);
  assert.equal(visited.length, 2, 'a paused site is not visited again');
});
test('tool code reporting a challenge gets the same treatment as a navigation', async t => {
  const binding = fixture(t), visited = [], file = path.join(binding.root, 'probe.js');
  fs.writeFileSync(file, 'async page => ({ challenge: true, auth_state: "browser_challenge" })');
  const tool = pageTool(binding, { url: () => 'https://chatgpt.com/', goto: async u => visited.push(u) });
  const result = await tool.execute(['run-code', '--filename', file]);
  assert.equal(result.auth_state, 'browser_challenge');
  assert.deepEqual(visited, ['about:blank']);
  assert.ok(guard.blocked(binding.root, 'main', 'chatgpt'));
});
test('a person finishing releases their site but keeps its strikes', async t => {
  const binding = fixture(t);
  guard.recordChallenge(binding.root, { identity: 'main', site: 'chatgpt' });
  guard.startHandoff(binding.root, { identity: 'main', site: 'chatgpt' });
  const tool = new BrowserTool(binding, { env: {}, hub: { endpoint: async () => null } });
  assert.deepEqual(await tool.execute(['human-done', 'https://chatgpt.com/']), { handoff: false, site: 'chatgpt' });
  assert.equal(guard.handoff(binding.root), null);
  assert.equal(guard.blocked(binding.root, 'main', 'chatgpt'), null);
  assert.equal(guard.read(binding.root).sites['main:chatgpt'].strikes, 1);
});
test('the per-step entry prints the handoff and challenge categories', async t => {
  const binding = fixture(t);
  guard.startHandoff(binding.root, { identity: 'main', site: 'chatgpt' });
  const { execFileSync } = require('child_process');
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../core/hub-browser-tool.js'))}).main(${JSON.stringify(binding)}, ['open','about:blank'])`;
  let out;
  try { out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }); } catch (e) { out = e.stdout; }
  assert.deepEqual(JSON.parse(out), { isError: true, error: 'Human handoff' });
});
test('download scripts ask for Playwright download handling; ordinary scripts attach without defaults', async t => {
  const binding = fixture(t), seen = [];
  const tool = new BrowserTool(binding, { env: {}, hub: { endpoint: async () => null } });
  tool.withPage = async (fn, options) => { seen.push(!!options?.downloads); return null; };
  const download = path.join(binding.root, 'download.js'), plain = path.join(binding.root, 'plain.js');
  fs.writeFileSync(download, "async page => { const d = page.waitForEvent('download'); return null; }");
  fs.writeFileSync(plain, 'async page => ({ ok: true })');
  await tool.execute(['run-code', '--filename', download]);
  await tool.execute(['run-code', '--filename', plain]);
  assert.deepEqual(seen, [true, false]);
});
test('the company bridge reports its page steps to the account page; images and a person holding the browser do not', t => {
  const { noteActivity } = require('../core/hub-browser-tool');
  const binding = { ...fixture(t), id: 'company-bridge', tool: 'bridge' };
  const file = path.join(binding.root, 'account-activity', 'main-chatgpt-bridge.json');
  noteActivity(binding, ['--session', 'chatgpt-bridge', '--json', 'run-code', '--filename', 'x.js'], 'success');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).outcome, 'success');
  noteActivity(binding, ['goto', 'https://chatgpt.com/'], null);
  noteActivity(binding, ['close'], 'failed');
  noteActivity({ ...binding, tool: 'images' }, ['run-code', '--filename', 'x.js'], 'failed');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).outcome, 'success');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['main-chatgpt-bridge.json']);
});
