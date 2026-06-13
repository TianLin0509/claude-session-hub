'use strict';

// Browser-level E2E for cold-start PWA history sync and existing-session control.
// It creates a temporary desktop PowerShell session before PWA opens, pairs once,
// reloads from persisted token, then verifies the historical drawer row can be
// selected and controlled through the public VPS path.
//
// Usage:
//   node mobile/tests/probe-pwa-history-session-browser.js <hubId> <hubCdpPort> <screenshotPath>

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const HUB_ID = process.argv[2];
const HUB_CDP_PORT = Number(process.argv[3] || 0);
const SCREENSHOT = process.argv[4] || 'C:\\Users\\lintian\\pwa-history-session-e2e-20260612.png';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const VIEWPORT_MODE = String(process.env.PWA_VIEWPORT || 'mobile').toLowerCase();
const DESKTOP_VIEWPORT = VIEWPORT_MODE === 'desktop';
const PIN = '063551';
const DEBUG_PORT = Number(process.env.PWA_DEBUG_PORT || 28754);
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-history-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!HUB_ID || !HUB_CDP_PORT) {
  console.error('Usage: node mobile/tests/probe-pwa-history-session-browser.js <hubId> <hubCdpPort> <screenshotPath>');
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

async function connectFirstPage(port, predicate = null) {
  const tabs = await getTabs(port);
  const tab = (predicate && tabs.find(predicate))
    || tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    || tabs.find(t => t.webSocketDebuggerUrl);
  if (!tab) throw new Error(`No page target on ${port}`);
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

async function waitForHubBuffer(hub, sessionId, marker, timeoutMs = 18000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await hub.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const buffer = await ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sessionId)}).catch(e => ({ err: String(e) }));
      const lastWrite = await ipcRenderer.invoke('debug:get-last-session-write').catch(e => ({ err: String(e) }));
      return {
        buffer: typeof buffer === 'string' ? buffer.slice(-4000) : '',
        bufferErr: buffer && buffer.err || null,
        lastWrite,
      };
    })()`);
    if (last && last.buffer && last.buffer.includes(marker)) return { ok: true, ...last };
    await sleep(500);
  }
  return { ok: false, ...(last || {}) };
}

async function closeHubSession(hub, sessionId) {
  try {
    await hub.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('close-session', ${JSON.stringify(sessionId)}).catch(() => {});
      await new Promise(r => setTimeout(r, 1200));
      const all = await ipcRenderer.invoke('get-sessions').catch(() => []);
      return { exists: Array.isArray(all) && all.some(s => s.id === ${JSON.stringify(sessionId)}), count: Array.isArray(all) ? all.length : null };
    })()`);
  } catch {}
}

async function main() {
  if (await portOpen(DEBUG_PORT)) throw new Error(`debug port ${DEBUG_PORT} is already in use`);

  const hub = await connectFirstPage(HUB_CDP_PORT, t => t.type === 'page' && String(t.url || '').includes('renderer/index.html'));
  let session = null;
  let chrome = null;
  let pwa = null;

  try {
    const marker = `PWA_HISTORY_E2E_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
    const title = `PWA History Probe ${marker.slice(-6)}`;
    session = await hub.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const s = await ipcRenderer.invoke('create-session', { kind: 'powershell', opts: { title: ${JSON.stringify(title)} } });
      return { id: s && s.id, title: s && s.title, kind: s && s.kind };
    })()`);
    if (!session || !session.id) throw new Error(`create-session failed: ${JSON.stringify(session)}`);
    await sleep(1500);

    chrome = spawn(CHROME_EXE, [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      DESKTOP_VIEWPORT ? '--window-size=1365,900' : '--window-size=420,900',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    chrome.unref();

    pwa = await connectFirstPage(DEBUG_PORT);
    await pwa.send('Page.enable');
    await pwa.send('Runtime.enable');
    await pwa.send('Network.enable');
    await pwa.send('Emulation.setDeviceMetricsOverride', DESKTOP_VIEWPORT ? {
      width: 1365,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { angle: 0, type: 'landscapePrimary' },
    } : {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    if (!DESKTOP_VIEWPORT) {
      await pwa.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await pwa.send('Network.setUserAgentOverride', {
      userAgent: DESKTOP_VIEWPORT
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HubHistoryE2E/0.1'
        : 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36 HubHistoryE2E/0.1',
    });

    await pwa.send('Page.navigate', { url: PWA_URL });
    await sleep(3500);
    await pwa.eval(`(async () => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch {}
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch {}
      location.reload();
    })()`);
    await sleep(3000);

    const selectedHub = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui) return { ok: false, reason: 'ui missing' };
      for (let i = 0; i < 40; i++) {
        if (typeof window.ui.refreshPairHubs === 'function') await window.ui.refreshPairHubs();
        if ((window.ui.pairHubs || []).some(h => h.hubId === targetHub)) break;
        await wait(250);
      }
      const exists = (window.ui.pairHubs || []).some(h => h.hubId === targetHub);
      if (!exists) return { ok: false, reason: 'target pair hub missing', hubs: (window.ui.pairHubs || []).map(h => h.hubId) };
      window.ui.pairTargetHubId = targetHub;
      if (typeof window.ui._renderPairHubs === 'function') window.ui._renderPairHubs();
      return { ok: true, pairTargetHubId: window.ui.pairTargetHubId };
    })()`);
    if (!selectedHub || !selectedHub.ok) throw new Error(`pair target failed: ${JSON.stringify(selectedHub)}`);

    for (const digit of PIN) {
      const ok = await pwa.eval(`(() => {
        const btn = document.querySelector('.key[data-key="${digit}"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (!ok) throw new Error(`PIN key not found: ${digit}`);
      await sleep(140);
    }
    await sleep(3500);

    // Cold-start proof: reload after token is persisted. The following checks must pass
    // without entering the PIN again.
    await pwa.send('Page.reload', { ignoreCache: true });
    await sleep(4500);

    const browserResult = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const targetSession = ${JSON.stringify(session.id)};
      const targetTitle = ${JSON.stringify(session.title)};
      const marker = ${JSON.stringify(marker)};
      const isDesktopViewport = ${JSON.stringify(DESKTOP_VIEWPORT)};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || !window.ui.client) return { ok: false, reason: 'ui missing after cold reload' };

      for (let i = 0; i < 60; i++) {
        window.ui.client.requestHubList();
        if (targetHub) {
          window.ui.client.requestSessionList(targetHub);
          window.ui.client.requestMeetingList(targetHub);
          window.ui.client.requestHubSnapshot(targetHub);
        }
        const found = (window.ui.sessions || []).some(s => s.id === targetSession);
        if (window.ui.activeHubId === targetHub && found) break;
        await wait(350);
      }

      const sessionObj = (window.ui.sessions || []).find(s => s.id === targetSession) || null;
      if (!sessionObj) {
        return {
          ok: false,
          reason: 'historical session missing after cold reload',
          activeHubId: window.ui.activeHubId,
          hubCount: (window.ui.hubs || []).length,
          sessionCount: (window.ui.sessions || []).length,
          sessions: (window.ui.sessions || []).slice(0, 12).map(s => ({ id: s.id, title: s.title, source: s.source, hubId: s.hubId })),
        };
      }

      if (isDesktopViewport && typeof window.ui._syncDesktopDrawerMode === 'function') window.ui._syncDesktopDrawerMode();
      window.ui.openDrawer();
      await wait(450);
      let row = document.querySelector('.dsess[data-sid="' + targetSession + '"]');
      if (!row) {
        window.ui._renderDrawerList();
        await wait(100);
        row = document.querySelector('.dsess[data-sid="' + targetSession + '"]');
      }
      if (!row) return { ok: false, reason: 'historical drawer row missing', sessionObj };

      row.click();
      for (let i = 0; i < 30; i++) {
        if (window.ui.activeSessionId === targetSession) break;
        await wait(120);
      }
      const selected = window.ui.activeSessionId === targetSession;
      const navTitle = document.getElementById('nav-title-name')?.textContent || '';
      const ptyVisibleAfterSwitch = document.getElementById('pty-panel')?.hidden === false;

      const ackPromise = new Promise(resolve => {
        const timer = setTimeout(() => {
          window.ui.client.removeEventListener('command-ack', handler);
          resolve({ timeout: true });
        }, 20000);
        const handler = (e) => {
          const d = e.detail || {};
          if (d.targetId && d.targetId !== targetSession) return;
          clearTimeout(timer);
          window.ui.client.removeEventListener('command-ack', handler);
          resolve(d);
        };
        window.ui.client.addEventListener('command-ack', handler);
      });
      window.ui.sendInputText('Write-Output "' + marker + '"');
      const ack = await ackPromise;
      let ptyText = '';
      for (let i = 0; i < 30; i++) {
        ptyText = (document.getElementById('pty-panel')?.textContent || '')
          + '\\n'
          + Array.from(document.querySelectorAll('#pty-screen .xterm-rows div')).map(el => el.textContent || '').join('\\n');
        if (ptyText.includes(marker)) break;
        await wait(400);
      }
      const streamText = document.getElementById('stream')?.textContent || '';
      const drawerRows = Array.from(document.querySelectorAll('.dsess')).map(el => ({
        sid: el.dataset.sid || '',
        text: el.textContent || '',
        active: el.classList.contains('active'),
      }));
      const overlay = document.getElementById('drawer-overlay');
      const panel = overlay && overlay.querySelector('.drawer-panel');
      const panelRect = panel ? panel.getBoundingClientRect() : null;
      const desktopSidebarOk = !isDesktopViewport || !!(
        overlay
        && panel
        && overlay.classList.contains('desktop-persistent')
        && overlay.getAttribute('aria-hidden') === 'false'
        && panelRect
        && panelRect.width >= 320
      );

      return {
        ok: window.ui.activeHubId === targetHub
          && selected
          && !!ack
          && ack.ok === true
          && ack.targetId === targetSession
          && sessionObj.source === 'desktop'
          && sessionObj.hubId === targetHub
          && drawerRows.some(r => r.sid === targetSession && r.active)
          && (streamText.includes(marker) || ptyText.includes(marker))
          && desktopSidebarOk
          && typeof PWA_VERSION !== 'undefined' && PWA_VERSION === 'v0.5.83'
          && typeof PWA_SW_CACHE !== 'undefined' && PWA_SW_CACHE === 'hub-mobile-v110',
        marker,
        pwaVersion: typeof PWA_VERSION !== 'undefined' ? PWA_VERSION : null,
        pwaSwCache: typeof PWA_SW_CACHE !== 'undefined' ? PWA_SW_CACHE : null,
        viewportMode: isDesktopViewport ? 'desktop' : 'mobile',
        activeHubId: window.ui.activeHubId,
        selected,
        navTitle,
        targetTitle,
        ptyVisibleAfterSwitch,
        sessionObj,
        ack,
        streamHasMarker: streamText.includes(marker),
        ptyTextHasMarker: ptyText.includes(marker),
        ptyTail: ptyText.slice(-800),
        drawerRows: drawerRows.slice(0, 12),
        desktopSidebarOk,
        pinCellsVisibleAfterReload: document.querySelectorAll('#pair-pin .pin-cell').length > 0 && getComputedStyle(document.getElementById('view-pairing')).display !== 'none',
      };
    })()`);

    const bufferResult = await waitForHubBuffer(hub, session.id, marker);
    await sleep(700);
    await pwa.screenshot(SCREENSHOT);

    const ok = !!(browserResult && browserResult.ok && bufferResult && bufferResult.ok);
    console.log(JSON.stringify({
      ok,
      screenshot: SCREENSHOT,
      session,
      browserResult,
      bufferResult: {
        ok: bufferResult && bufferResult.ok,
        bufferHasMarker: !!(bufferResult && bufferResult.buffer && bufferResult.buffer.includes(marker)),
        lastWrite: bufferResult && bufferResult.lastWrite,
        bufferTail: bufferResult && bufferResult.buffer ? bufferResult.buffer.slice(-800) : null,
        bufferErr: bufferResult && bufferResult.bufferErr,
      },
    }, null, 2));
    process.exitCode = ok ? 0 : 1;
  } finally {
    if (session && session.id) await closeHubSession(hub, session.id);
    try { if (pwa) pwa.close(); } catch {}
    try { if (hub) hub.close(); } catch {}
    if (chrome && chrome.pid) {
      spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err && err.stack || String(err));
  process.exit(1);
});
