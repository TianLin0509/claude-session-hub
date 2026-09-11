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
