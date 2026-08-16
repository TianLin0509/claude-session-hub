'use strict';

// Historical filename retained for existing scripts. The product contract is
// now deliberately multi-owner: each Hub owns its own hook/CDP/control record,
// while state-store serializes and merges writes to the shared data directory.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePorts(preferred, count) {
  const ports = [];
  for (let port = preferred; port < preferred + 100 && ports.length < count; port += 1) {
    if (await canListen(port)) ports.push(port);
  }
  if (ports.length !== count) throw new Error('not enough free CDP ports');
  return ports;
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-owner-e2e-${stamp}`);
  const [primaryPort, secondaryPort] = await availablePorts(
    Number(process.env.HUB_OWNER_E2E_PORT || 19631),
    2,
  );
  let primary = null;
  let secondary = null;
  try {
    primary = await launchIsolatedHub({
      dataDir,
      port: primaryPort,
      label: 'same-data-dir-primary',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });

    secondary = await launchIsolatedHub({
      dataDir,
      port: secondaryPort,
      label: 'same-data-dir-secondary',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    await _waitMs(500);

    assert.equal(primary.isAlive(), true, 'primary Hub must remain alive');
    assert.equal(secondary.isAlive(), true, 'secondary Hub sharing the data directory must remain alive');
    assert.equal(await canListen(primaryPort), false, 'primary CDP must remain bound');
    assert.equal(await canListen(secondaryPort), false, 'secondary CDP must remain bound');

    const controlDir = path.join(dataDir, 'control');
    const controlFiles = fs.existsSync(controlDir)
      ? fs.readdirSync(controlDir).filter(name => name.endsWith('.json'))
      : [];
    assert.equal(controlFiles.length, 2, `both Hub processes need per-PID control metadata: ${controlFiles.join(', ')}`);
    assert.ok(controlFiles.some(name => name.startsWith(String(primary.pid))), 'control metadata must include the primary PID');
    assert.ok(controlFiles.some(name => name.startsWith(String(secondary.pid))), 'control metadata must include the secondary PID');
    const controls = controlFiles.map(name => JSON.parse(fs.readFileSync(path.join(controlDir, name), 'utf8')));
    assert.equal(new Set(controls.map(item => item.hookPort)).size, 2,
      'each Hub must own a distinct hook port');

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      primaryPid: primary.pid,
      secondaryPid: secondary.pid,
      primaryAlive: primary.isAlive(),
      secondaryAlive: secondary.isAlive(),
      controlFiles,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (primary) console.error(primary.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (secondary) await gracefulQuit(secondary);
    if (primary) await gracefulQuit(primary);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-owner-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
