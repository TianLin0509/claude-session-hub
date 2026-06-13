'use strict';

// Browser-level E2E for public PWA artifact preview/history.
// Usage:
//   node mobile/tests/probe-pwa-artifact-browser.js <hubId> <screenshotPath>

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const HUB_ID = process.argv[2];
const SCREENSHOT = process.argv[3] || 'C:\\Users\\lintian\\pwa-artifact-e2e-20260612.png';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const PWA_DEVICE_TOKEN = process.env.PWA_DEVICE_TOKEN || '';
const PWA_VIEWPORT = (process.env.PWA_VIEWPORT || 'desktop').toLowerCase();
const IS_DESKTOP = PWA_VIEWPORT === 'desktop';
const PIN = '063551';
const DEBUG_PORT = Number(process.env.PWA_DEBUG_PORT || 28748);
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-artifact-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!HUB_ID) {
  console.error('Usage: node mobile/tests/probe-pwa-artifact-browser.js <hubId> <screenshotPath>');
  process.exit(2);
}

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

function ensureSampleArtifact() {
  const root = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';
  fs.mkdirSync(root, { recursive: true });
  const marker = `PWA_ARTIFACT_E2E_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const filePath = path.join(root, `pwa-artifact-e2e-${marker.slice(-6)}.html`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title><style>body{font-family:Segoe UI,Arial,sans-serif;padding:32px}h1{font-size:24px;color:#0a66c2}</style></head><body><h1>${marker}</h1><p>Public PWA artifact preview E2E.</p></body></html>`;
  fs.writeFileSync(filePath, html, 'utf8');
  return { marker, filePath };
}

async function main() {
  if (await portOpen(DEBUG_PORT)) throw new Error(`debug port ${DEBUG_PORT} is already in use`);
  const sample = ensureSampleArtifact();

  const chrome = spawn(CHROME_EXE, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    IS_DESKTOP ? '--window-size=1365,900' : '--window-size=420,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  let pwa;
  try {
    pwa = await connectFirstPage(DEBUG_PORT);
    await pwa.send('Page.enable');
    await pwa.send('Runtime.enable');
    await pwa.send('Network.enable');
    if (IS_DESKTOP) {
      await pwa.send('Emulation.setDeviceMetricsOverride', {
        width: 1365,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
        screenOrientation: { angle: 0, type: 'landscapePrimary' },
      });
      await pwa.send('Network.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HubArtifactE2E/0.1',
      });
    } else {
      await pwa.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        screenOrientation: { angle: 0, type: 'portraitPrimary' },
      });
      await pwa.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await pwa.send('Network.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36 HubArtifactE2E/0.1',
      });
    }

    await pwa.send('Page.navigate', { url: PWA_URL });
    await sleep(3500);
    await pwa.eval(`(() => {
      localStorage.clear();
      const token = ${JSON.stringify(PWA_DEVICE_TOKEN)};
      if (token) localStorage.setItem('hub-mobile/device-token', token);
      location.reload();
    })()`);
    await sleep(2500);

    if (!PWA_DEVICE_TOKEN) {
      const selectedHub = await pwa.eval(`(async () => {
        const targetHub = ${JSON.stringify(HUB_ID)};
        const wait = ms => new Promise(r => setTimeout(r, ms));
        if (!window.ui) return { ok: false, reason: 'ui missing' };
        if (typeof window.ui.refreshPairHubs === 'function') await window.ui.refreshPairHubs();
        for (let i = 0; i < 40; i++) {
          if ((window.ui.pairHubs || []).some(h => h.hubId === targetHub)) break;
          if (typeof window.ui.refreshPairHubs === 'function') await window.ui.refreshPairHubs();
          await wait(250);
        }
        const exists = (window.ui.pairHubs || []).some(h => h.hubId === targetHub);
        if (!exists) return { ok: false, reason: 'target pair hub missing', hubs: (window.ui.pairHubs || []).map(h => h.hubId) };
        window.ui.pairTargetHubId = targetHub;
        if (typeof window.ui._renderPairHubs === 'function') window.ui._renderPairHubs();
        return { ok: true, pairTargetHubId: window.ui.pairTargetHubId };
      })()`);
      if (!selectedHub || !selectedHub.ok) throw new Error('PWA pairing target hub selection failed: ' + JSON.stringify(selectedHub));
      for (const digit of PIN) {
        const ok = await pwa.eval(`(() => {
          const btn = document.querySelector('.key[data-key="${digit}"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        if (!ok) throw new Error(`PIN key not found: ${digit}`);
        await sleep(120);
      }
    }

    await sleep(3500);
    const result = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const artifactPath = ${JSON.stringify(sample.filePath)};
      const marker = ${JSON.stringify(sample.marker)};
      const isDesktopViewport = ${JSON.stringify(IS_DESKTOP)};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || !window.ui.client) return { ok: false, reason: 'ui missing' };
      window.ui.activeHubId = targetHub;
      localStorage.setItem('hub-mobile/active-hub', targetHub);

      window.ui._showArtifactLoading(artifactPath);
      await wait(80);
      const loadingBeforeClose = !!document.getElementById('artifact-overlay');
      document.querySelector('#artifact-overlay .nav-back')?.click();
      await wait(120);
      const loadingAfterClose = !!document.getElementById('artifact-overlay');
      const pendingAfterLoadingClose = window.ui.pendingArtifacts ? window.ui.pendingArtifacts.size : null;

      window.ui.openArtifact(artifactPath);
      let iframeText = '';
      let overlayTitle = '';
      for (let i = 0; i < 80; i++) {
        const iframe = document.querySelector('#artifact-overlay iframe');
        overlayTitle = document.querySelector('#artifact-overlay .af-bar-title .t')?.textContent || '';
        try { iframeText = iframe && iframe.contentDocument ? iframe.contentDocument.body.textContent : ''; } catch (_) {}
        if (iframeText && iframeText.includes(marker)) break;
        await wait(250);
      }
      const previewShown = iframeText.includes(marker);
      const overlayBeforePreviewClose = !!document.getElementById('artifact-overlay');
      document.querySelector('#artifact-overlay .nav-back')?.click();
      await wait(120);
      const overlayAfterPreviewClose = !!document.getElementById('artifact-overlay');

      window.ui.showArtifactHistory();
      let historyCount = 0;
      let historyHasSample = false;
      for (let i = 0; i < 40; i++) {
        const items = Array.from(document.querySelectorAll('#artifact-history .art-item'));
        historyCount = items.length;
        historyHasSample = items.some(item => (item.textContent || '').includes(artifactPath.split(/[\\\\/]/).pop()));
        if (historyHasSample) break;
        await wait(250);
      }
      const sampleItem = Array.from(document.querySelectorAll('#artifact-history .art-item'))
        .find(item => (item.textContent || '').includes(artifactPath.split(/[\\\\/]/).pop()));
      if (sampleItem) sampleItem.click();
      let historyIframeText = '';
      for (let i = 0; i < 60; i++) {
        const iframe = document.querySelector('#artifact-overlay iframe');
        try { historyIframeText = iframe && iframe.contentDocument ? iframe.contentDocument.body.textContent : ''; } catch (_) {}
        if (historyIframeText && historyIframeText.includes(marker)) break;
        await wait(250);
      }
      const historyOpenOk = historyIframeText.includes(marker);

      const debug = {
        pwaVersion: typeof PWA_VERSION !== 'undefined' ? PWA_VERSION : null,
        pwaSwCache: typeof PWA_SW_CACHE !== 'undefined' ? PWA_SW_CACHE : null,
        drawerVersion: document.getElementById('drawer-ver')?.textContent || null,
      };
      const desktopSidebar = isDesktopViewport ? (() => {
        window.ui.openDrawer();
        const overlay = document.getElementById('drawer-overlay');
        const panel = overlay && overlay.querySelector('.drawer-panel');
        const menuBtn = document.getElementById('btn-menu');
        const panelRect = panel ? panel.getBoundingClientRect() : null;
        return {
          ok: !!overlay && getComputedStyle(overlay).visibility === 'visible'
            && !!panelRect && Math.round(panelRect.width) === 340
            && getComputedStyle(menuBtn).display === 'none',
          panelWidth: panelRect ? Math.round(panelRect.width) : null,
          menuDisplay: menuBtn ? getComputedStyle(menuBtn).display : null,
        };
      })() : null;

      return {
        ok: loadingBeforeClose === true
          && loadingAfterClose === false
          && pendingAfterLoadingClose === 0
          && previewShown === true
          && overlayBeforePreviewClose === true
          && overlayAfterPreviewClose === false
          && historyHasSample === true
          && historyOpenOk === true
          && debug.pwaVersion === 'v0.5.83'
          && debug.pwaSwCache === 'hub-mobile-v110'
          && (!isDesktopViewport || (desktopSidebar && desktopSidebar.ok)),
        marker,
        artifactPath,
        loadingBeforeClose,
        loadingAfterClose,
        pendingAfterLoadingClose,
        previewShown,
        overlayTitle,
        iframeText: iframeText.slice(0, 160),
        overlayBeforePreviewClose,
        overlayAfterPreviewClose,
        historyCount,
        historyHasSample,
        historyOpenOk,
        debug,
        desktopSidebar,
        activeHubId: window.ui.activeHubId,
      };
    })()`);

    await sleep(700);
    await pwa.screenshot(SCREENSHOT);
    console.log(JSON.stringify({ ok: !!(result && result.ok), screenshot: SCREENSHOT, sample, result }, null, 2));
    process.exitCode = result && result.ok ? 0 : 1;
  } finally {
    if (pwa) pwa.close();
    spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});


