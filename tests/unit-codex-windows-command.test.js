'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveWindowsCodex } = require('../main/codex-windows-command');

test('Windows resolves the selected shim binary directly, preserving managed update root and path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-command-'));
  try {
    const bin = path.join(root, 'versioned', 'bin');
    const vendor = path.join(root, 'versioned', 'vendor', 'x86_64-pc-windows-msvc');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(vendor, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(vendor, 'path'));
    const script = path.join(bin, 'codex-managed.js');
    const managed = path.join(root, 'npm-update-authority');
    fs.writeFileSync(script, 'CODEX_MANAGED_PACKAGE_ROOT: ' + JSON.stringify(managed));
    const exe = path.join(vendor, 'bin', 'codex.exe');
    fs.writeFileSync(exe, 'fixture');
    const shim = path.join(root, 'codex.cmd');
    fs.writeFileSync(shim, 'node "' + script + '" %*');
    const env = { Path: 'existing-path', CODEX_HOME: 'isolated-home' };
    const result = resolveWindowsCodex(env, { shim, arch: 'x64' });
    assert.equal(result.command, exe);
    assert.deepEqual(result.args, []);
    assert.equal(result.env.CODEX_MANAGED_PACKAGE_ROOT, managed);
    assert.equal(result.env.CODEX_HOME, env.CODEX_HOME);
    assert.equal(result.env.Path, path.join(vendor, 'path') + path.delimiter + env.Path);
    assert.equal(env.Path, 'existing-path');
    fs.unlinkSync(exe);
    assert.throws(() => resolveWindowsCodex(env, { shim, arch: 'x64' }), /原生程序不存在/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 原生安装（只有 codex.exe，没有 npm 启动器）与 npm 安装共用同一套查找 ──
const { locateWindowsCodex, ensureCodexOnSessionPath } = require('../main/codex-windows-command');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub codex locate '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = rel => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); return file; };
  return { root, make, env: { APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), Path: path.join(root, 'empty') } };
}

test('native install in the official default folder resolves without any npm shim', t => {
  const { make, env } = sandbox(t);
  const exe = make('local/Programs/OpenAI/Codex/bin/codex.exe');
  assert.deepEqual(locateWindowsCodex(env), { kind: 'native', command: exe, source: 'official-installer' });
  const launch = resolveWindowsCodex(env);
  assert.equal(launch.command, exe);
  assert.deepEqual(launch.args, []);
  assert.equal(launch.env.CODEX_MANAGED_BY_NPM, undefined, 'a native install is not marked as npm-managed');
});

test('CODEX_INSTALL_DIR and PATH natives resolve to the same file the lookup reports', t => {
  const { make, env } = sandbox(t);
  const onPath = make('tools/codex.exe');
  const explicit = make('chosen/codex.exe');
  assert.equal(resolveWindowsCodex({ ...env, Path: path.dirname(onPath) }).command, onPath);
  assert.equal(resolveWindowsCodex({ ...env, Path: path.dirname(onPath), CODEX_INSTALL_DIR: path.dirname(explicit) }).command, explicit,
    'an explicitly chosen install wins over PATH');
});

test('the npm shim keeps priority over other installs, as before', t => {
  const { root, make, env } = sandbox(t);
  make('local/Programs/OpenAI/Codex/bin/codex.exe');
  const shim = path.join(env.APPDATA, 'npm', 'codex.cmd');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, 'fixture');
  assert.deepEqual(locateWindowsCodex(env), { kind: 'npm', shim, source: 'APPDATA' });
  assert.ok(root);
});

test('no install gives a plain-language error instead of ENOENT on a shim path', t => {
  const { env } = sandbox(t);
  assert.equal(locateWindowsCodex(env), null);
  assert.throws(() => resolveWindowsCodex(env), /未找到 Codex CLI/);
});

test('a PTY session gets the native install folder on PATH only when it is missing', t => {
  const { make, env } = sandbox(t);
  const exe = make('local/Programs/OpenAI/Codex/bin/codex.exe');
  const sessionEnv = { ...env };
  assert.equal(ensureCodexOnSessionPath(sessionEnv), true);
  assert.equal(sessionEnv.Path.split(path.delimiter)[0], path.dirname(exe));
  assert.equal(ensureCodexOnSessionPath(sessionEnv), false, 'already reachable through PATH');
});
