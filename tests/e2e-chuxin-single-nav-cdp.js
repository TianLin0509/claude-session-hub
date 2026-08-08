'use strict';

// Real isolated Electron verification for the Chuxin single-navigation shell.
// It reuses the already-running research backend, never production Hub state.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `chuxin-single-nav-${STAMP}`);
const TEMP_ROOT = path.join(os.tmpdir(), `chuxin-single-nav-e2e-${process.pid}-${STAMP}`);

function freePort(start = 24961) {
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

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitEval(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(`Boolean(${expression})`)) return;
    } catch { /* retry while renderer settles */ }
    await _waitMs(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

function removeTempRoot() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep)) return;
  if (!path.basename(resolved).startsWith('chuxin-single-nav-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  assert((await getJson('http://127.0.0.1:3004/health'))?.status === 'ok', 'research API 3004 is not healthy');
  fs.mkdirSync(OUTPUT, { recursive: true });
  const port = await freePort();
  let hub = null;
  let client = null;
  let embeddedClient = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'chuxin-single-nav',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CHUXIN_API_BASE: 'http://127.0.0.1:3004',
        CHUXIN_WEB_BASE: 'http://127.0.0.1:3003',
      },
    });
    client = await connectFirstPage(hub, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitEval(client, 'document.getElementById("btn-chuxin") && document.querySelector(".cx-status")', 'research entry');
    await _waitMs(2000);
    await client.eval(`(() => {
      window.__singleNavErrors = [];
      window.addEventListener('error', (event) => window.__singleNavErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', (event) => window.__singleNavErrors.push(String(event.reason)));
      document.getElementById('btn-chuxin').click();
    })()`);
    await waitEval(client, 'getComputedStyle(document.getElementById("chuxin-panel")).display !== "none"', 'visible research panel');
    try {
      await waitEval(client, 'document.querySelector(".cx-status.online")', 'online research panel');
    } catch (error) {
      const diagnostic = await client.eval(`({
        panelDisplay: getComputedStyle(document.getElementById('chuxin-panel')).display,
        status: document.querySelector('.cx-status')?.outerHTML || '',
        startError: document.querySelector('.cx-start-error')?.textContent || '',
        bodyText: document.body.innerText.slice(0, 1200)
      })`);
      await screenshot(client, '00-online-timeout.png');
      error.message += `\n${JSON.stringify(diagnostic, null, 2)}\nHub log:\n${hub.log().slice(-30).join('\n')}`;
      throw error;
    }

    const labels = await client.eval(`[...document.querySelectorAll('.cx-primary-tab')].map((node) => node.textContent.trim())`);
    assert.deepStrictEqual(labels, ['今日概况', '技术雷达', '消息雷达', '观察池', '持仓信息', '知识积累']);
    assert.strictEqual(await client.eval(`document.querySelectorAll('.cx-primary-nav').length`), 1);
    assert.strictEqual(await client.eval(`document.querySelectorAll('.cx-tabs,.cx-tab').length`), 0);

    const expected = {
      today: '#today',
      technical: '#technical',
      news: '#news',
      targets: '#watch',
      holding: '#holding',
      notes: '#notes',
    };
    await waitEval(client, `document.querySelector('.cx-view-frame[data-view="workbench"] iframe')`, 'shared workbench iframe');
    await client.eval(`document.querySelector('.cx-view-frame iframe').__stableMarker = 'same-frame'`);
    for (const [tab, hash] of Object.entries(expected)) {
      await client.eval(`document.querySelector('.cx-primary-tab[data-tab="${tab}"]').click()`);
      await waitEval(client, `document.querySelector('.cx-view-frame[data-view="workbench"] iframe').src.endsWith('${hash}')`, `${tab} route`);
      const src = await client.eval(`document.querySelector('.cx-view-frame[data-view="workbench"] iframe').src`);
      assert(src.includes('embed=hub'), `${tab} did not enter embedded mode`);
      assert(src.endsWith(hash), `${tab} routed to ${src}`);
    }
    assert.strictEqual(await client.eval(`document.querySelectorAll('.cx-view-frame iframe').length`), 1);
    assert.strictEqual(await client.eval(`document.querySelector('.cx-view-frame iframe').__stableMarker`), 'same-frame');
    assert.strictEqual(
      await client.eval(`new URL(document.querySelector('.cx-view-frame iframe').src).searchParams.get('workspace')`),
      'hub-primary-workspace',
    );

    await client.eval(`document.querySelector('.cx-primary-tab[data-tab="today"]').click()`);
    // Wait for the real embedded dashboard, not merely for the iframe element.
    // The previous test captured too early and could approve an empty canvas.
    await _waitMs(500);
    const embeddedTarget = (await listCdpTargets(hub)).find((target) => (target.url || '').includes('embed=hub') && (target.url || '').endsWith('#today'));
    let embeddedVerified = false;
    if (embeddedTarget?.webSocketDebuggerUrl) {
      embeddedClient = await connectCDP(embeddedTarget.webSocketDebuggerUrl);
      await embeddedClient.send('Runtime.enable');
      await waitEval(embeddedClient, 'document.documentElement.classList.contains("hub-embed")', 'embedded mode class');
      await waitEval(embeddedClient, 'document.querySelector("#feed .today-stat-grid") && document.getElementById("view-title")?.textContent === "今日概况"', 'rendered today dashboard');
      const embeddedState = await embeddedClient.eval(`({
        topbar: getComputedStyle(document.querySelector('.topbar')).display,
        mobileNav: getComputedStyle(document.querySelector('.mobile-nav')).display
      })`);
      assert.deepStrictEqual(embeddedState, { topbar: 'none', mobileNav: 'none' });
      embeddedVerified = true;
    }
    const observeScreenshot = await screenshot(client, '01-observe-single-nav.png');

    assert.deepStrictEqual(await client.eval('window.__singleNavErrors'), []);
    console.log(JSON.stringify({
      ok: true,
      labels,
      embeddedVerified,
      screenshots: [observeScreenshot],
      output: OUTPUT,
    }, null, 2));
  } finally {
    if (embeddedClient) await embeddedClient.close();
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    removeTempRoot();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
