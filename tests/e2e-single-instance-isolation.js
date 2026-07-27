'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-single-instance-'));
  const dataDir = path.join(root, 'data');
  const firstPort = 19431;
  const secondPort = 19432;
  const primary = await launchIsolatedHub({
    dataDir,
    port: firstPort,
    label: 'multi-instance-primary',
    extraEnv: { CLAUDE_HUB_E2E: '1' },
  });
  let secondary = null;
  try {
    secondary = await launchIsolatedHub({
      dataDir,
      port: secondPort,
      label: 'multi-instance-secondary',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    assert.equal(primary.isAlive(), true, 'primary isolated Hub must remain alive');
    assert.equal(secondary.isAlive(), true, 'second Hub sharing the data directory must remain alive');
    const [firstVersion, secondVersion] = await Promise.all([
      fetch(`http://127.0.0.1:${firstPort}/json/version`).then(response => response.json()),
      fetch(`http://127.0.0.1:${secondPort}/json/version`).then(response => response.json()),
    ]);
    assert.ok(firstVersion.webSocketDebuggerUrl, 'primary CDP remains responsive');
    assert.ok(secondVersion.webSocketDebuggerUrl, 'secondary CDP remains responsive');
    console.log(JSON.stringify({
      ok: true,
      primaryPid: primary.pid,
      secondaryPid: secondary.pid,
      primaryAlive: primary.isAlive(),
      secondaryAlive: secondary.isAlive(),
    }));
  } finally {
    await gracefulQuit(secondary);
    await gracefulQuit(primary);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
