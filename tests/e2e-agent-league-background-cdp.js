'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const { getPhilosophy } = require('../core/agent-league-philosophies.js');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-background-${process.pid}-${STAMP}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const LEAGUE_ROOT = path.join(DATA_DIR, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-background-${STAMP}`);

function freePort(start = 25420) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > start + 50) return reject(new Error('no isolated CDP port available'));
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitEval(client, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function seed() {
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  store.createAgent({
    id: 'background-agent',
    name: '后台守护测试',
    provider: 'codex-cli',
    kind: 'codex',
    model: 'gpt-5.6-sol',
    philosophy: getPhilosophy('chuxin-value-speculation'),
  });
  store.saveSchedule({
    ...store.getSchedule(),
    enabled: true,
    keepAliveOnClose: true,
  });
}

function cleanup() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (resolved.startsWith(temp + path.sep) && path.basename(resolved).startsWith('agent-league-background-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  seed();
  const port = await freePort();
  let hub = null;
  let client = null;
  let explicitlyQuit = false;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'agent-league-background',
      windowMode: 'hidden',
      extraEnv: {
        CHUXIN_AGENT_LEAGUE_DIR: LEAGUE_ROOT,
        CHUXIN_API_BASE: 'http://127.0.0.1:3004',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await waitEval(client, `document.getElementById('btn-chuxin') && document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'league tab');
    await client.eval(`(() => {
      document.getElementById('btn-chuxin').click();
      document.querySelector('.cx-primary-tab[data-tab="league"]').click();
    })()`);
    await waitEval(client, `document.querySelectorAll('.cxl-row').length===1`, 'league row');
    const runtime = await client.eval(`require('electron').ipcRenderer.invoke('debug:agent-league-background-state')`);
    assert.equal(runtime.runtimeAvailable, true, JSON.stringify(runtime));
    assert.equal(runtime.scheduler.allowed, true, JSON.stringify(runtime));
    assert.equal(runtime.pid, hub.pid);

    await client.eval(`document.querySelector('[data-action="health-check"]').click()`);
    await waitEval(client, `!document.querySelector('[data-role="health"]').hidden && document.querySelectorAll('[data-role="health-checks"] article').length>=5`, 'health diagnostics');
    const shotData = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shot = path.join(OUTPUT, '01-health-and-background-controls.png');
    fs.writeFileSync(shot, Buffer.from(shotData.data, 'base64'));

    const hidden = await client.eval(`require('electron').ipcRenderer.invoke('debug:agent-league-close-window')`);
    assert.equal(hidden.windowVisible, false, JSON.stringify(hidden));
    assert.equal(hidden.trayActive, true, JSON.stringify(hidden));
    await _waitMs(400);
    assert.equal(hub.isAlive(), true, 'closing the window must not terminate the scheduled Hub');
    const background = await client.eval(`require('electron').ipcRenderer.invoke('debug:agent-league-background-state')`);
    assert.equal(background.windowVisible, false);
    assert.equal(background.trayActive, true);
    assert.equal(background.runtimeAvailable, true);

    await client.eval(`require('electron').ipcRenderer.invoke('debug:agent-league-explicit-quit')`);
    explicitlyQuit = true;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && hub.isAlive()) await _waitMs(150);
    assert.equal(hub.isAlive(), false, 'explicit quit must terminate the isolated Hub cleanly');
    console.log(JSON.stringify({ ok: true, pid: hub.pid, hidden, background, screenshot: shot }, null, 2));
  } finally {
    try { if (client) await client.close(); } catch {}
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: explicitlyQuit });
    cleanup();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
