'use strict';

// Isolated real-Hub E2E for the native Chuxin Agent League tab.
// Production Hub/data are untouched; one real Codex PTY is created without sending a model prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const { PHILOSOPHY_TEMPLATES } = require('../core/agent-league-philosophies.js');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-e2e-${process.pid}-${STAMP}`);
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-${STAMP}`);

function freePort(start = 25280) {
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

async function waitEval(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

function seedLeague() {
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  const providers = [
    ['codex-cli', 'codex', 'gpt-5.6-sol'],
    ['claude-cli', 'claude', 'claude-opus-5[1m]'],
    ['gemini-cli', 'gemini', 'gemini-3-pro-preview'],
  ];
  const returns = [0.0312, 0.0274, 0.0231, 0.0144, 0.0089, 0.0042, -0.0018, -0.0054, -0.0112, -0.0205];
  const names = ['衡策', '逐浪', '远见', '守拙', '知止', '拾贝', '破浪', '矩衡', '慎行', '择时'];
  for (let index = 0; index < 10; index += 1) {
    const philosophy = PHILOSOPHY_TEMPLATES[index % PHILOSOPHY_TEMPLATES.length];
    const provider = providers[index % providers.length];
    const id = `fixture-agent-${String(index + 1).padStart(2, '0')}`;
    store.createAgent({
      id,
      name: names[index],
      provider: provider[0],
      kind: provider[1],
      model: provider[2],
      philosophy,
      initialCash: 1_000_000,
    });
    const nav = 1_000_000 * (1 + returns[index]);
    store.savePortfolio(id, {
      initialCash: 1_000_000,
      cash: nav,
      positions: [],
      pendingDecision: null,
      navHistory: [{ date: '2026-08-25', nav, cash: nav, marketValue: 0, dailyReturn: returns[index] / 4 }],
    });
  }
}

function removeTempRoot() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep)) return;
  if (!path.basename(resolved).startsWith('agent-league-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  seedLeague();
  const port = await freePort();
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'agent-league',
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
    await waitEval(client, 'document.getElementById("btn-chuxin") && document.querySelector(".cx-primary-tab[data-tab=league]")', 'Agent League tab');
    await client.eval(`(() => {
      window.__agentLeagueErrors = [];
      window.addEventListener('error', event => window.__agentLeagueErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', event => window.__agentLeagueErrors.push(String(event.reason)));
      document.getElementById('btn-chuxin').click();
      document.querySelector('.cx-primary-tab[data-tab="league"]').click();
    })()`);
    await waitEval(client, 'document.querySelectorAll(".cxl-row").length === 10', 'ten leaderboard rows');
    const ranking = await client.eval(`(() => {
      const list = document.querySelector('.cxl-ranking');
      return {
        rows: document.querySelectorAll('.cxl-row').length,
        first: document.querySelector('.cxl-row .cxl-agent b')?.textContent,
        viewWidth: Math.round(document.querySelector('.cx-view-league').getBoundingClientRect().width),
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        visibleRows: Math.floor(list.clientHeight / 58),
        aggregateTotalVisible: document.querySelector('.cxl-root').innerText.includes('模拟总资产'),
      };
    })()`);
    assert.equal(ranking.rows, 10);
    assert.equal(ranking.first, '衡策');
    assert.equal(ranking.scrollHeight, 580);
    assert.equal(ranking.aggregateTotalVisible, false);
    assert(ranking.viewWidth > 800, JSON.stringify(ranking));
    assert(ranking.visibleRows >= 6 && ranking.visibleRows <= 8, JSON.stringify(ranking));
    const leaderboardShot = await screenshot(client, '01-leaderboard.png');

    await client.eval(`document.querySelector('.cxl-row').click()`);
    await waitEval(client, '!document.querySelector("[data-role=detail-overlay]").hidden && document.querySelector(".cxl-drawer")', 'Agent detail drawer');
    assert.equal(await client.eval(`document.querySelector('.cxl-drawer').innerText.includes('打开卡片 Session')`), true);
    assert.equal(await client.eval(`document.querySelector('.cxl-drawer').innerText.includes('打开 PTY')`), true);
    const detailShot = await screenshot(client, '02-detail.png');
    await client.eval(`document.querySelector('[data-action="close-detail"]').click()`);

    // Electron is a desktop shell, so validate its real narrow-window CSS path
    // instead of forcing mobile-browser viewport semantics onto index.html.
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await _waitMs(250);
    const mobile = await client.eval(`({
      viewport: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      rows: document.querySelectorAll('.cxl-row').length,
      sidebarDisplay: getComputedStyle(document.getElementById('session-sidebar')).display,
      leagueWidth: Math.round(document.querySelector('.cx-view-league').getBoundingClientRect().width),
      rankingClientHeight: document.querySelector('.cxl-ranking').clientHeight,
      rankingScrollHeight: document.querySelector('.cxl-ranking').scrollHeight
    })`);
    assert.equal(mobile.viewport, 390);
    assert.equal(mobile.pageScrollWidth, 390);
    assert.equal(mobile.rows, 10);
    assert.equal(mobile.sidebarDisplay, 'none');
    assert.equal(mobile.leagueWidth, 390);
    assert(mobile.rankingScrollHeight > mobile.rankingClientHeight);
    const mobileShot = await screenshot(client, '03-mobile-leaderboard.png');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await _waitMs(250);

    await client.eval(`document.querySelector('[data-action="new-agent"]').click()`);
    await waitEval(client, '!document.querySelector("[data-role=create-overlay]").hidden && document.querySelector("[data-role=create-form] [name=model] option")', 'create Agent form');
    await client.eval(`(() => {
      const form = document.querySelector('[data-role="create-form"]');
      form.elements.name.value = '会话探针';
      form.elements.id.value = 'session-probe';
      form.elements.provider.value = 'codex-cli';
      form.elements.provider.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.model.value = 'gpt-5.6-sol';
      form.elements.philosophyKey.value = 'trend-confirmation';
      form.elements.initialCash.value = '1000000';
      form.requestSubmit();
    })()`);
    await waitEval(client, `document.querySelector('[data-agent-row="session-probe"]')`, 'created Agent leaderboard row');
    const sessionId = await client.eval(`(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).find(row => row.title === 'Agent · 会话探针')?.id || '')()`);
    assert(sessionId, 'created Agent session id is missing');
    await waitEval(client, `(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).some(row => row.id === ${JSON.stringify(sessionId)} && row.purpose === 'agent-league' && !row.hiddenFromSidebar))()`, 'visible ordinary Agent session');
    const opened = await client.eval(`window.__chuxinSessionBridge.open(${JSON.stringify(sessionId)}, 'card')`);
    assert.equal(opened.ok, true);
    await waitEval(client, 'getComputedStyle(document.getElementById("chuxin-panel")).display === "none" && getComputedStyle(document.getElementById("terminal-panel")).display !== "none"', 'ordinary Session surface');
    assert.equal(await client.eval(`document.getElementById('session-list').innerText.includes('Agent · 会话探针')`), true);
    const sessionShot = await screenshot(client, '04-ordinary-session.png');
    assert.deepEqual(await client.eval('window.__agentLeagueErrors'), []);

    console.log(JSON.stringify({
      ok: true,
      ranking,
      mobile,
      sessionId,
      screenshots: [leaderboardShot, detailShot, mobileShot, sessionShot],
      output: OUTPUT,
    }, null, 2));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    removeTempRoot();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
