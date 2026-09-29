'use strict';
// First-run behaviour on a clean machine: readiness without Node/Git/Python,
// CLI discovery outside PATH, plain-language errors for missing CLIs, and a
// public audit that also works from a source ZIP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { requireCommand, assertProviderAvailable } = require('../core/community-provider');
const { inspectSetup } = require('../core/community-setup');

function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'community onboarding '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  return { root, env: { PATH: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'), USERPROFILE: root, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local') } };
}

test('the packaged app is ready with only Windows PowerShell available', t => {
  const { root, env } = environment(t);
  const result = inspectSetup({ packaged: true, root, env, platform: 'win32', version: '18.0.0' });
  assert.equal(result.runtime, 'bundled');
  assert.equal(result.hookRunner, 'powershell');
  assert.equal(result.requirements.powershell, true);
  assert.equal(result.requirements.node22, undefined, 'Node is only needed for source installs');
  assert.equal(result.ready, true);
  assert.ok(result.providers.every(p => !p.installed));
});

test('CLIs installed by the official installers are found before PATH is refreshed', t => {
  const { root, env } = environment(t);
  const codex = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const claude = path.join(root, '.local', 'bin', 'claude.exe');
  for (const file of [codex, claude]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  assert.equal(requireCommand('codex', env), codex);
  assert.equal(requireCommand('claude', env), claude);
});

test('a missing CLI is reported in plain words before anything starts', t => {
  const { env } = environment(t);
  for (const kind of ['claude', 'codex', 'claude-resume', 'codex-resume', 'kimi', 'gemini']) {
    assert.throws(() => assertProviderAvailable(kind, env), /未找到.*CLI/);
  }
  assert.doesNotThrow(() => assertProviderAvailable('powershell', env));
});

test('public audit runs from a source ZIP without Git and rejects account files', t => {
  const { root } = environment(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'audit-public.js');
  fs.copyFileSync(path.resolve(__dirname, '../scripts/audit-public.js'), script);
  fs.writeFileSync(path.join(root, 'README.md'), 'Install to C:\\Users\\you\\ai-hub-community\n');
  const run = () => spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  fs.writeFileSync(path.join(root, 'auth.json'), '{}');
  // Built at runtime so this test file itself contains no real-looking profile path.
  fs.writeFileSync(path.join(root, 'notes.md'), 'see ' + ['C:', 'Users', 'someone', 'secret', 'x'].join('\\') + '\n');
  const dirty = run();
  assert.equal(dirty.status, 1);
  const failures = JSON.parse(dirty.stdout).failures;
  assert.ok(failures.some(f => f.file === 'auth.json'));
  assert.ok(failures.some(f => f.file === 'notes.md' && f.rule === 'machine user path'));
});
