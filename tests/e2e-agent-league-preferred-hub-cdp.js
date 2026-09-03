'use strict';

// Two real isolated Electron Hubs share one data directory and one league
// vault. No model is called: this test only proves deterministic owner
// election, standby write rejection, and visible UI ownership state.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tempRoot = path.join(os.tmpdir(), `agent-league-preferred-hub-${process.pid}-${stamp}`);
const hubData = path.join(tempRoot, 'hub-data');
const leagueRoot = path.join(hubData, 'agent-league');
const contexts = [];

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > start + 100) return reject(new Error('no free CDP port'));
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitFor(work, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await work();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(250);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function launch(label, portStart) {
  const port = await freePort(portStart);
  const hub = await launchIsolatedHub({
    dataDir: hubData,
    port,
    label,
    windowMode: 'hidden',
    extraEnv: { CHUXIN_AGENT_LEAGUE_DIR: leagueRoot },
  });
  const client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
  await client.send('Runtime.enable');
  const context = { label, hub, client };
  contexts.push(context);
  return context;
}

async function list(context) {
  return context.client.eval(`require('electron').ipcRenderer.invoke('agent-league:list', {})`);
}

async function close(context) {
  if (!context) return;
  try { await context.client.close(); } catch {}
  await gracefulQuit(context.hub);
}

(async () => {
  fs.mkdirSync(hubData, { recursive: true });
  const first = await launch('preferred-hub-a', 58340);
  const second = await launch('preferred-hub-b', 58460);
  const preferredPid = Math.max(first.hub.pid, second.hub.pid);
  const standby = first.hub.pid === preferredPid ? second : first;
  const preferred = first.hub.pid === preferredPid ? first : second;

  const states = await waitFor(async () => {
    const rows = await Promise.all([list(first), list(second)]);
    const elections = rows.map(row => row.schedulerRuntime && row.schedulerRuntime.election);
    return elections.every(row => row && row.preferenceActive && row.preferred && row.preferred.pid === preferredPid)
      ? rows
      : null;
  }, 'both Hubs to agree on preferred PID');

  const standbyResult = await standby.client.eval(`require('electron').ipcRenderer.invoke('agent-league:run-day', {
    force: true,
    decisionDate: '2026-09-03'
  })`);
  assert.equal(standbyResult.ok, false);
  assert.equal(standbyResult.error, 'not-preferred-hub');
  assert.equal(standbyResult.preferred.pid, preferredPid);

  const preferredResult = await preferred.client.eval(`require('electron').ipcRenderer.invoke('agent-league:run-day', {
    force: true,
    decisionDate: '2026-09-03'
  })`);
  assert.equal(preferredResult.ok, false);
  assert.equal(preferredResult.error, 'no-agents', 'preferred Hub must pass election before ordinary validation');

  await waitFor(
    () => standby.client.eval(`!!(document.getElementById('btn-research') || document.getElementById('btn-chuxin'))`),
    'research entry button',
  );
  await standby.client.eval(`(document.getElementById('btn-research') || document.getElementById('btn-chuxin')).click()`);
  await waitFor(
    () => standby.client.eval(`document.querySelector('.cx-primary-tab[data-tab="league"]') && true`),
    'league tab',
  );
  await standby.client.eval(`document.querySelector('.cx-primary-tab[data-tab="league"]').click()`);
  const visibleSummary = await waitFor(
    () => standby.client.eval(`document.querySelector('[data-role="runtime-summary"]')?.textContent || ''`)
      .then(text => text.includes('本机只读候补') ? text : ''),
    'standby ownership summary',
  );
  const standbyButton = await standby.client.eval(`(() => {
    const button = document.querySelector('[data-action="run-day"]');
    return button ? { disabled: button.disabled, text: button.textContent, title: button.title } : null;
  })()`);
  assert.equal(standbyButton.disabled, true);
  assert.match(standbyButton.text, new RegExp(`主控 PID ${preferredPid}`));
  assert.match(standbyButton.title, /只读候补/);

  await close(preferred);
  const takeoverResult = await waitFor(async () => {
    const result = await standby.client.eval(`require('electron').ipcRenderer.invoke('agent-league:run-day', {
      force: true,
      decisionDate: '2026-09-03'
    })`);
    return result && result.error === 'no-agents' ? result : null;
  }, 'standby Hub to take over after preferred Hub exits');
  assert.equal(takeoverResult.error, 'no-agents');
  const takeoverState = await list(standby);
  assert.equal(takeoverState.schedulerRuntime.election.isPreferred, true);
  assert.equal(takeoverState.schedulerRuntime.election.preferred.pid, standby.hub.pid);

  console.log(JSON.stringify({
    ok: true,
    version: states[0].schedulerRuntime.durable.ownerVersion,
    firstPid: first.hub.pid,
    secondPid: second.hub.pid,
    preferredPid,
    standbyPid: standby.hub.pid,
    standbyError: standbyResult.error,
    preferredValidation: preferredResult.error,
    visibleSummary,
    standbyButton,
    takeoverPid: standby.hub.pid,
    takeoverValidation: takeoverResult.error,
  }, null, 2));
})().finally(async () => {
  for (const context of contexts.reverse()) {
    if (context.hub && context.hub.isAlive()) await close(context);
  }
  const resolved = path.resolve(tempRoot);
  const temp = path.resolve(os.tmpdir());
  if (resolved.startsWith(temp + path.sep) && path.basename(resolved).startsWith('agent-league-preferred-hub-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}).catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
