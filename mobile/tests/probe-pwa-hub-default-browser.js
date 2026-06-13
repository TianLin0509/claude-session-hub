'use strict';

// Browser-level read-only probe for public PWA default Hub selection.
// Usage:
//   node mobile/tests/probe-pwa-hub-default-browser.js [expectedHubId] [screenshotPath]

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const EXPECTED_HUB_ID = process.argv[2] || '';
const SCREENSHOT = process.argv[3] || '';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const DEBUG_PORT = Number(process.env.PWA_DEBUG_PORT || 28753);
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-default-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getTabs(port) {
  for (let i = 0; i < 50; i++) {
    try { return await getJson(`http://127.0.0.1:${port}/json/list`); } catch { await sleep(250); }
  }
  throw new Error(`CDP not responding on ${port}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!msg.id || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timeout`));
        }
      }, 45000);
    });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error('Eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result && r.result.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectFirstPage(port) {
  const tabs = await getTabs(port);
  const tab = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || tabs.find(t => t.webSocketDebuggerUrl);
  if (!tab) throw new Error(`No page target on ${port}`);
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

async function main() {
  if (await portOpen(DEBUG_PORT)) throw new Error(`debug port ${DEBUG_PORT} is already in use`);
  const chrome = spawn(CHROME_EXE, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--ignore-certificate-errors',
    PWA_URL,
  ], { stdio: 'ignore', detached: false });

  let cdp;
  try {
    cdp = await connectFirstPage(DEBUG_PORT);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.eval(`(async () => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch {}
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch {}
      return true;
    })()`);
    await cdp.send('Page.reload', { ignoreCache: true });

    const state = await cdp.eval(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 120; i++) {
        if (window.ui && Array.isArray(window.ui.pairHubs) && window.ui.pairHubs.length) break;
        if (window.ui && typeof window.ui.refreshPairHubs === 'function') {
          try { await window.ui.refreshPairHubs(); } catch {}
        }
        await sleep(250);
      }
      const hubs = (window.ui && window.ui.pairHubs || []).map(h => ({
        hubId: h.hubId,
        pid: h.pid || null,
        hostname: h.hostname || null,
        version: h.version || null,
        startedAt: h.startedAt || null,
        connectedAt: h.connectedAt || null,
        isLegacy: !!h.isLegacy,
        friendlyName: h.friendlyName || null,
      }));
      return {
        url: location.href,
        title: document.title,
        pairTargetHubId: window.ui ? window.ui.pairTargetHubId : null,
        activeHubId: window.ui ? window.ui.activeHubId : null,
        hubCount: hubs.length,
        hubs,
        selectedCardHubId: document.querySelector('.pair-hub-card.on') && document.querySelector('.pair-hub-card.on').dataset.hubid || null,
        versionText: document.querySelector('#ver') && document.querySelector('#ver').textContent || null,
        visiblePair: !!(document.querySelector('#view-pair') && document.querySelector('#view-pair').classList.contains('on')),
        bodyText: document.body ? document.body.innerText.slice(0, 500) : '',
      };
    })()`);

    if (SCREENSHOT) await cdp.screenshot(SCREENSHOT);

    const ok = state.hubCount > 0
      && state.pairTargetHubId
      && state.selectedCardHubId === state.pairTargetHubId
      && (!EXPECTED_HUB_ID || state.pairTargetHubId === EXPECTED_HUB_ID);

    console.log(JSON.stringify({
      ok,
      expectedHubId: EXPECTED_HUB_ID || null,
      screenshot: SCREENSHOT || null,
      state,
    }, null, 2));
    process.exit(ok ? 0 : 1);
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch {}
  }
}

main().catch((err) => {
  console.error(err && err.stack || String(err));
  process.exit(1);
});
