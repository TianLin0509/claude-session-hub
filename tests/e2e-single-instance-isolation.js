'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-single-instance-'));
  const dataDir = path.join(root, 'data');
  const firstPort = 19431;
  const secondPort = 19432;
  const hub = await launchIsolatedHub({
    dataDir,
    port: firstPort,
    label: 'single-instance-primary',
    extraEnv: { CLAUDE_HUB_E2E: '1' },
  });
  const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const second = spawn(electron, [path.resolve(__dirname, '..'), `--remote-debugging-port=${secondPort}`], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: dataDir, CLAUDE_HUB_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let secondExit = null;
  second.on('exit', code => { secondExit = code; });
  try {
    const deadline = Date.now() + 8000;
    while (secondExit === null && Date.now() < deadline) await _waitMs(100);
    assert.notEqual(secondExit, null, 'second instance should exit after failing the single-instance lock');
    assert.equal(hub.isAlive(), true, 'primary isolated Hub must remain alive');
    const version = await fetch(`http://127.0.0.1:${firstPort}/json/version`).then(response => response.json());
    assert.ok(version.webSocketDebuggerUrl, 'primary CDP remains responsive');
    let secondCdpReachable = true;
    try { await fetch(`http://127.0.0.1:${secondPort}/json/version`); }
    catch { secondCdpReachable = false; }
    assert.equal(secondCdpReachable, false, 'rejected second instance must not keep a CDP endpoint alive');
    console.log(JSON.stringify({ ok: true, primaryPid: hub.pid, secondPid: second.pid, secondExit }));
  } finally {
    if (secondExit === null) {
      try { second.kill('SIGTERM'); } catch {}
    }
    await gracefulQuit(hub);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
