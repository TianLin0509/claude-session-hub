'use strict';

// One real Codex DRAFT -> Hook run inside an isolated Hub and temporary league root.
// It reads the production Chuxin API, but never writes production Hub/league state.
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
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-real-turn-${process.pid}-${STAMP}`);
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-real-turn-${STAMP}`);

function chinaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const row = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${row.year}-${row.month}-${row.day}`;
}

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

async function waitEval(client, expression, label, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await client.eval(expression);
      if (value) return value;
    } catch {}
    await _waitMs(1000);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

function safeRemoveTemp() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith('agent-league-real-turn-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  store.createAgent({
    id: 'real-codex-baseline', name: '真实 Codex 探针', provider: 'codex-cli', kind: 'codex',
    model: 'gpt-5.6-sol', philosophy: getPhilosophy('chuxin-value-speculation'), initialCash: 500000,
  });
  const decisionDate = chinaDate();
  const port = await freePort();
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'agent-league-real-turn',
      windowMode: 'hidden',
      extraEnv: {
        CHUXIN_AGENT_LEAGUE_DIR: LEAGUE_ROOT,
        CHUXIN_DIR: 'C:\\Users\\lintian\\chuxin-research',
        CHUXIN_API_BASE: 'http://127.0.0.1:3004',
        CHUXIN_WEB_BASE: 'http://127.0.0.1:3003',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    const started = await client.eval(`require('electron').ipcRenderer.invoke('agent-league:run-day', { trigger: 'real-e2e', force: true, decisionDate: ${JSON.stringify(decisionDate)} })`);
    assert.equal(started.ok, true, JSON.stringify(started));
    const finished = await waitEval(client, `(async()=>{
      const value=await require('electron').ipcRenderer.invoke('agent-league:list',{});
      return !value.run && ['completed','failed','partial'].includes(value.schedule.lastRunStatus) ? value : null;
    })()`, 'real Codex daily completion');
    assert.equal(finished.schedule.lastRunStatus, 'completed', JSON.stringify(finished.agents.map((row) => row.latestDaily)));
    const agent = finished.agents.find((row) => row.id === 'real-codex-baseline');
    assert(agent && agent.latestDaily && agent.latestDaily.hook, 'Hook result missing');
    assert(['PASS', 'REVISE', 'HOLD'].includes(agent.latestDaily.hook.verdict));
    assert(agent.latestDaily.dailyBrief && agent.latestDaily.dailyBrief.body.length >= 80);
    assert(agent.session && agent.session.hubSessionId);

    const executed = await client.eval(`require('electron').ipcRenderer.invoke('agent-league:execute-open', { trigger: 'real-e2e', force: true, decisionDate: ${JSON.stringify(decisionDate)} })`);
    assert.equal(executed.ok, true, JSON.stringify(executed));
    const closed = await client.eval(`require('electron').ipcRenderer.invoke('agent-league:record-close', { trigger: 'real-e2e', force: true, decisionDate: ${JSON.stringify(decisionDate)} })`);
    assert.equal(closed.ok, true, JSON.stringify(closed));

    await waitEval(client, `document.getElementById('btn-chuxin') || document.getElementById('btn-research')`, 'Chuxin launch button');
    await client.eval(`(document.getElementById('btn-chuxin') || document.getElementById('btn-research')).click()`);
    await waitEval(client, `document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'Agent League tab');
    await client.eval(`document.querySelector('.cx-primary-tab[data-tab="league"]').click()`);
    await waitEval(client, `document.querySelector('[data-agent-row="real-codex-baseline"]')`, 'real Agent row');
    await client.eval(`document.querySelector('[data-agent-row="real-codex-baseline"]').click()`);
    await waitEval(client, `!document.querySelector('[data-role="detail-overlay"]').hidden && document.querySelector('.cxl-brief')`, 'real daily brief drawer');
    const shot = await screenshot(client, 'real-codex-daily-hook.png');
    const finalState = await client.eval(`require('electron').ipcRenderer.invoke('agent-league:list', {})`);
    const finalAgent = finalState.agents.find((row) => row.id === 'real-codex-baseline');
    const summary = {
      ok: true,
      decisionDate,
      sessionId: finalAgent.session.hubSessionId,
      hookVerdict: finalAgent.latestDaily.hook.verdict,
      headline: finalAgent.latestDaily.dailyBrief.headline,
      targets: (finalAgent.latestDaily.decision.targets || []).map((row) => ({ symbol: row.symbol, weight: row.target_weight })),
      trades: finalAgent.recentTrades,
      nav: finalAgent.stats.nav,
      screenshot: shot,
      output: OUTPUT,
    };
    fs.writeFileSync(path.join(OUTPUT, 'real-run-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    const dailyPath = path.join(LEAGUE_ROOT, 'agents', 'real-codex-baseline', 'daily', `${decisionDate}.md`);
    if (fs.existsSync(dailyPath)) fs.copyFileSync(dailyPath, path.join(OUTPUT, 'real-codex-daily.md'));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    safeRemoveTemp();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
