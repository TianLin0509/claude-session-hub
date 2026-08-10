'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ELECTRON_EXE = path.join(HUB_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

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

function spawnSecond(dataDir, port) {
  const child = spawn(ELECTRON_EXE, [HUB_ROOT, `--remote-debugging-port=${port}`], {
    cwd: HUB_ROOT,
    env: {
      ...process.env,
      CLAUDE_HUB_DATA_DIR: dataDir,
      CLAUDE_HUB_E2E: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null) return child.exitCode;
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
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

    secondary = spawnSecond(dataDir, secondaryPort);
    const secondaryExitCode = await waitForExit(secondary.child);
    if (secondaryExitCode == null) {
      secondary.child.kill('SIGTERM');
      throw new Error(`secondary Hub did not yield ownership\n${secondary.output()}`);
    }
    await _waitMs(500);

    assert.equal(secondaryExitCode, 0, `secondary should exit cleanly\n${secondary.output()}`);
    assert.equal(primary.isAlive(), true, 'primary owner must remain alive');
    assert.equal(await canListen(secondaryPort), true, 'secondary must not leave a CDP/browser process behind');

    const controlDir = path.join(dataDir, 'control');
    const controlFiles = fs.existsSync(controlDir)
      ? fs.readdirSync(controlDir).filter(name => name.endsWith('.json'))
      : [];
    assert.equal(controlFiles.length, 1, `only the owner may create control metadata: ${controlFiles.join(', ')}`);
    assert.ok(controlFiles[0].startsWith(String(primary.pid)), 'control metadata must belong to the primary PID');

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      primaryPid: primary.pid,
      secondaryPid: secondary.child.pid,
      secondaryExitCode,
      controlFiles,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (primary) console.error(primary.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (secondary && secondary.child.exitCode == null) {
      try { secondary.child.kill('SIGTERM'); } catch {}
    }
    if (primary) await gracefulQuit(primary);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-owner-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
