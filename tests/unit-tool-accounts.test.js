'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { buildToolAccounts } = require('../core/tool-accounts');
const { dependencyFor } = require('../core/tool-account-catalog');
const { collectCapabilities } = require('../core/capability-catalog');
const { toolAccountsHtml } = require('../renderer/tool-accounts-view');
const row = (name, type = 'skill', extra = {}) => ({ id: type + ':' + name, name, type, sources: [{ enabled: true }], ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
  return { root, write, options: { root, homeDir: root, env: {} } };
}
test('API/native/host dependencies never become website login or success', t => {
  const f = fixture(t);
  f.write('.bailian/config.json', { api_key: 'SECRET-DO-NOT-RENDER', access_token: 'SECRET-TOKEN' });
  const result = buildToolAccounts({ rows: [row('bailian-gen'), row('imagegen'), row('browser')] }, f.options);
  const bl = result.services.find(s => s.id === 'bailian');
  assert.equal(bl.status, 'native'); assert.equal(bl.credential, 'record_found'); assert.equal(bl.authentication, 'not_checked');
  assert.equal(result.services.find(s => s.id === 'hostImage').status, 'host');
  assert.equal(result.services.find(s => s.id === 'hostBrowser').status, 'host');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.services.find(s => s.id === 'roundtable').identities[0].identity, 'main');
});
test('real config drift invalidates image binding; artifacts alone do not prove sharing', t => {
  const f = fixture(t), config = f.write('settings.json', { cli_entry: 'old' }), entry = f.write('entry.cjs', '// wrapper');
  f.write('tool-bindings.json', { tools: [{ tool: 'images', identity: 'alt', config, entry }] });
  const catalog = { rows: [row('chatgpt-web-images', 'mcp')] };
  assert.equal(buildToolAccounts(catalog, f.options).services.find(s => s.id === 'images').status, 'changed');
  fs.writeFileSync(config, JSON.stringify({ cli_entry: entry }));
  const bound = buildToolAccounts(catalog, f.options).services.find(s => s.id === 'images');
  assert.equal(bound.status, 'bound'); assert.equal(bound.authentication, 'not_checked');
  assert.equal(bound.identities[0].identity, 'alt');
});
test('unknown and disabled capabilities remain explicit; plugins inherit child dependencies', t => {
  const f = fixture(t), plugin = row('custom@personal', 'plugin');
  const child = row('chatgpt-web-images', 'skill', { sources: [{ plugin: plugin.name, enabled: true }] });
  assert.deepEqual(dependencyFor(plugin, [plugin, child]), { state: 'reviewed', services: ['images'] });
  assert.equal(dependencyFor(row('future-unreviewed')).state, 'unknown');
  const result = buildToolAccounts({ rows: [row('future-unreviewed'), row('yuque', 'skill', { sources: [{ enabled: false }] })] }, f.options);
  assert.equal(result.counts.unknown, 1); assert.ok(!result.services.some(s => s.id === 'yuque'));
});
test('mcporter MCPs participate without exposing commands, API keys or environment values', t => {
  const f = fixture(t);
  f.write('.mcporter/mcporter.json', { mcpServers: { douyin: { command: 'SECRET-COMMAND', env: { DASHSCOPE_API_KEY: 'SECRET-KEY' } } } });
  const catalog = collectCapabilities({ homeDir: f.root, dataDir: f.root });
  assert.equal(catalog.rows.find(r => r.id === 'mcp:douyin').accountDependency.services[0], 'bailian');
  assert.ok(!JSON.stringify(catalog).includes('SECRET'));
});
test('unreadable credential source is explicit and renderer escapes all metadata', t => {
  const f = fixture(t); f.write('.bailian/config.json', '{bad');
  const data = buildToolAccounts({ rows: [row('bailian-cli'), row('<img onerror=alert(1)>')] }, f.options);
  assert.equal(data.services.find(s => s.id === 'bailian').credential, 'read_error');
  const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const html = toolAccountsHtml(data, esc);
  assert.ok(html.includes('读取失败')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img'));
});
