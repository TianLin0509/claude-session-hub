'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { alignClaudeProfile } = require('../core/claude-profile-align');

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-align-'));
  const primary = path.join(root, '.claude'); const profile = path.join(root, 'second');
  write(path.join(primary, 'settings.json'), JSON.stringify({ permissionMode: 'bypassPermissions', model: 'opus[1m]', hooks: { Stop: [] } }));
  write(path.join(root, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { email: 'primary' } }));
  write(path.join(primary, 'skills', 'ppt', 'SKILL.md'), 'ppt skill');
  write(path.join(primary, 'skills', '.archived', 'old', 'SKILL.md'), 'archived');
  write(path.join(primary, 'skills', 'tool', 'node_modules', 'x.js'), 'dep');
  write(path.join(primary, 'agents', 'reviewer.md'), 'agent');
  write(path.join(primary, 'plugins', 'installed_plugins.json'), '{"version":2}');
  write(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  write(path.join(profile, '.claude.json'), JSON.stringify({ oauthAccount: { email: 'second' }, projects: { a: 1 } }));
  write(path.join(profile, '.credentials.json'), 'second-secret');
  write(path.join(profile, 'skills', 'mine', 'SKILL.md'), 'created in profile');
  return { root, primary, profile, run: () => alignClaudeProfile({ primaryDir: primary, primaryStateFile: path.join(root, '.claude.json'), profileDir: profile }) };
}

test('the second account gets the primary settings, skills, agents, plugins and MCP servers', () => {
  const { profile, run } = setup();
  const report = run();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')),
    { theme: 'dark', permissionMode: 'bypassPermissions', model: 'opus[1m]', hooks: { Stop: [] } });
  assert.equal(fs.readFileSync(path.join(profile, 'skills', 'ppt', 'SKILL.md'), 'utf8'), 'ppt skill');
  assert.equal(fs.readFileSync(path.join(profile, 'agents', 'reviewer.md'), 'utf8'), 'agent');
  assert.equal(fs.existsSync(path.join(profile, 'skills', '.archived')), false, 'archived skills are not loaded, not copied');
  assert.equal(fs.existsSync(path.join(profile, 'skills', 'tool', 'node_modules')), false);
  assert.equal(fs.readFileSync(path.join(profile, 'plugins', 'installed_plugins.json'), 'utf8'), '{"version":2}');
  const state = JSON.parse(fs.readFileSync(path.join(profile, '.claude.json'), 'utf8'));
  assert.deepEqual(state.mcpServers, { playwright: { command: 'npx' } });
  assert.deepEqual(state.oauthAccount, { email: 'second' }, 'the account identity is untouched');
  assert.equal(fs.readFileSync(path.join(profile, '.credentials.json'), 'utf8'), 'second-secret');
  assert.ok(fs.existsSync(path.join(profile, '.hub-align-backup', 'settings.json')), 'original settings backed up once');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, '.hub-align-backup', 'settings.json'), 'utf8')).theme, 'dark');
});

test('later runs follow primary edits and deletions but keep files the profile created itself', () => {
  const { primary, profile, run } = setup();
  run();
  fs.rmSync(path.join(primary, 'skills', 'ppt'), { recursive: true });
  write(path.join(primary, 'skills', 'video', 'SKILL.md'), 'video skill');
  const report = run();
  assert.equal(report.backup, null, 'backup happens only the first time');
  assert.equal(fs.existsSync(path.join(profile, 'skills', 'ppt', 'SKILL.md')), false);
  assert.equal(fs.readFileSync(path.join(profile, 'skills', 'video', 'SKILL.md'), 'utf8'), 'video skill');
  assert.equal(fs.readFileSync(path.join(profile, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'created in profile');
  assert.equal(run().settings, false, 'idempotent once aligned');
});

test('the primary directory itself is never treated as a profile', () => {
  const { primary, root } = setup();
  const report = alignClaudeProfile({ primaryDir: primary, primaryStateFile: path.join(root, '.claude.json'), profileDir: primary });
  assert.equal(report.backup, null);
  assert.equal(fs.existsSync(path.join(primary, '.hub-align-backup')), false);
});
