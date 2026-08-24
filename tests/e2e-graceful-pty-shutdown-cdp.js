'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-graceful-pty-shutdown-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'isolated-home');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const BIN_DIR = path.join(TEMP_ROOT, 'bin');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'graceful-pty-shutdown');
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port for graceful shutdown E2E');
}

async function waitFor(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(expression)) return; } catch {}
    await _waitMs(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIN_DIR, 'codex.cmd'), [
    '@echo off',
    'echo ISOLATED_FAKE_CODEX_READY',
    'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 60"',
    '',
  ].join('\r\n'), 'utf8');

  const port = await availablePort(Number(process.env.HUB_GRACEFUL_SHUTDOWN_E2E_PORT || 19741));
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, resultPath: RESULT_PATH };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'graceful-pty-shutdown',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        CODEX_HOME: HOME_DIR,
        DEEPSEEK_API_KEY: '',
        PATH: `${BIN_DIR};${process.env.PATH || ''}`,
      },
    });
    result.pid = hub.pid;

    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await waitFor(client, `document.readyState === 'complete'`, 'main renderer');

    const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'codex',
      opts: { title: 'Graceful shutdown Codex PTY E2E', cwd: ${JSON.stringify(WORK_DIR)} }
    })`);
    assert.ok(session && session.id, JSON.stringify(session));
    result.sessionId = session.id;

    await waitFor(
      client,
      `window.__hubE2E?.terminalCacheStats().ids.includes(${JSON.stringify(session.id)})`,
      'live Codex terminal',
    );
    await waitFor(
      client,
      `window.__hubE2E?.terminalBufferText(${JSON.stringify(session.id)}).includes('ISOLATED_FAKE_CODEX_READY')`,
      'isolated fake Codex process',
    );
    const statePath = path.join(DATA_DIR, 'state.json');
    const stateHasSession = () => {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return Array.isArray(state.sessions)
          && state.sessions.some(item => item && (item.hubId || item.id) === session.id);
      } catch {
        return false;
      }
    };
    const persistDeadline = Date.now() + 10000;
    while (!stateHasSession() && Date.now() < persistDeadline) await _waitMs(100);
    assert.equal(stateHasSession(), true, 'Codex session must be persisted before shutdown starts');

    await client.close();
    client = null;
    const shutdownStartedAt = Date.now();
    result.exit = await gracefulQuit(hub);
    result.shutdownDurationMs = Date.now() - shutdownStartedAt;
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    result.cleanShutdown = persistedState.cleanShutdown === true;
    result.persistedSessionPresent = Array.isArray(persistedState.sessions)
      && persistedState.sessions.some(item => item && (item.hubId || item.id) === session.id);
    assert.equal(result.cleanShutdown, true, 'final state must record a clean shutdown');
    assert.equal(result.persistedSessionPresent, true, 'PTY drainage must not delete the logical session');
    result.success = true;
    hub = null;

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-graceful-pty-shutdown-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
