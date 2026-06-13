'use strict';

// Browser-level E2E for the public PWA xterm PTY mirror.
// Uses an isolated Chrome profile and CDP, not the user's normal browser.
//
// Usage:
//   node mobile/tests/probe-pwa-xterm-browser.js <hubId> <cdpPort> <screenshotPath>

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const HUB_ID = process.argv[2];
const HUB_CDP_PORT = Number(process.argv[3] || 0);
const SCREENSHOT = process.argv[4] || 'C:\\Users\\lintian\\pwa-hub-xterm-e2e-20260612.png';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const VIEWPORT_MODE = String(process.env.PWA_VIEWPORT || 'mobile').toLowerCase();
const DESKTOP_VIEWPORT = VIEWPORT_MODE === 'desktop';
const PIN = '063551';
const DEBUG_PORT = Number(process.env.PWA_DEBUG_PORT || 28746);
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-xterm-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!HUB_ID || !HUB_CDP_PORT) {
  console.error('Usage: node mobile/tests/probe-pwa-xterm-browser.js <hubId> <hubCdpPort> <screenshotPath>');
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
  for (let i = 0; i < 40; i++) {
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
      }, 30000);
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

  const hub = await connectFirstPage(HUB_CDP_PORT);
  const marker = `PWA_XTERM_BROWSER_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const probeTitle = `PWA Xterm Browser Probe ${marker.slice(-6)}`;
  const session = await hub.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    const s = await ipcRenderer.invoke('create-session', { kind: 'powershell', opts: { title: ${JSON.stringify(probeTitle)} } });
    return { id: s && s.id, title: s && s.title, kind: s && s.kind };
  })()`);
  if (!session || !session.id) throw new Error(`create-session failed: ${JSON.stringify(session)}`);

  const chrome = spawn(CHROME_EXE, [
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

  let pwa;
  try {
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
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HubXtermE2E/0.1'
        : 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36 HubXtermE2E/0.1',
    });

    await pwa.send('Page.navigate', { url: PWA_URL });
    await sleep(3500);
    await pwa.eval('localStorage.clear(); location.reload();');
    await sleep(2500);
    const selectedHub = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui) return { ok: false, reason: 'ui missing' };
      if (typeof window.ui.refreshPairHubs === 'function') {
        await window.ui.refreshPairHubs();
      }
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
      await sleep(150);
    }
    await sleep(3500);

    const result = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const targetSession = ${JSON.stringify(session.id)};
      const marker = ${JSON.stringify(marker)};
      const isDesktopViewport = ${JSON.stringify(DESKTOP_VIEWPORT)};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || !window.ui.client) return { ok: false, reason: 'ui missing' };
      for (let i = 0; i < 30; i++) {
        window.ui.client.requestHubList();
        await wait(300);
        if (window.ui.activeHubId === targetHub) break;
      }
      if (window.ui.activeHubId !== targetHub) {
        window.ui.activeHubId = targetHub;
        localStorage.setItem('hub-mobile/active-hub', targetHub);
        window.ui.client.requestSessionList(targetHub);
        window.ui.client.requestMeetingList(targetHub);
        window.ui.client.requestHubSnapshot(targetHub);
        await wait(800);
      }
      if (window.ui.activeHubId !== targetHub) {
        return {
          ok: false,
          reason: 'wrong active hub',
          activeHubId: window.ui.activeHubId,
          hubs: (window.ui.hubs || []).map(h => ({ hubId: h.hubId, pid: h.pid, connectedAt: h.connectedAt, startedAt: h.startedAt })),
        };
      }
      window.ui.client.requestHubSnapshot(targetHub);
      for (let i = 0; i < 40; i++) {
        const s = (window.ui.sessions || []).find(x => (x.targetId || x.id) === targetSession || x.id === targetSession);
        if (s) break;
        await wait(500);
        window.ui.client.requestHubSnapshot(targetHub);
      }
      const s = (window.ui.sessions || []).find(x => (x.targetId || x.id) === targetSession || x.id === targetSession);
      if (!s) return { ok: false, reason: 'session not found', sessionCount: (window.ui.sessions || []).length };
      let desktopSidebar = null;
      if (isDesktopViewport) {
        if (typeof window.ui._syncDesktopDrawerMode === 'function') window.ui._syncDesktopDrawerMode();
        window.ui.openDrawer();
        await wait(450);
        const overlay = document.getElementById('drawer-overlay');
        const panel = overlay && overlay.querySelector('.drawer-panel');
        const stream = document.getElementById('stream');
        const composer = document.querySelector('#view-main .composer');
        const menuBtn = document.getElementById('btn-menu');
        const overlayStyle = overlay ? getComputedStyle(overlay) : null;
        const menuStyle = menuBtn ? getComputedStyle(menuBtn) : null;
        const panelRect = panel ? panel.getBoundingClientRect() : null;
        const streamRect = stream ? stream.getBoundingClientRect() : null;
        const composerRect = composer ? composer.getBoundingClientRect() : null;
        const targetRow = document.querySelector('.dsess[data-sid="' + s.id + '"]');
        desktopSidebar = {
          ok: !!(
            matchMedia('(min-width: 960px)').matches
            && overlay
            && panel
            && panelRect
            && streamRect
            && composerRect
            && overlayStyle.visibility === 'visible'
            && overlayStyle.pointerEvents !== 'none'
            && overlay.classList.contains('desktop-persistent')
            && overlay.getAttribute('aria-hidden') === 'false'
            && !overlay.classList.contains('on')
            && panelRect.left <= 2
            && panelRect.width >= 320
            && Math.abs(panelRect.right - 340) <= 4
            && streamRect.left >= panelRect.right - 2
            && composerRect.left >= panelRect.right - 2
            && menuStyle
            && menuStyle.display === 'none'
            && !!targetRow
            && window.ui.drawerHistoryActive === false
            && window.ui.drawerHistoryClosing === false
          ),
          overlayVisible: overlayStyle && overlayStyle.visibility,
          pointerEvents: overlayStyle && overlayStyle.pointerEvents,
          desktopPersistentClass: !!(overlay && overlay.classList.contains('desktop-persistent')),
          ariaHidden: overlay ? overlay.getAttribute('aria-hidden') : null,
          overlayOn: !!(overlay && overlay.classList.contains('on')),
          menuDisplay: menuStyle && menuStyle.display,
          panelRect: panelRect && { left: panelRect.left, right: panelRect.right, width: panelRect.width },
          streamLeft: streamRect && streamRect.left,
          composerLeft: composerRect && composerRect.left,
          targetRowText: targetRow ? targetRow.textContent : '',
          drawerHistoryActive: !!window.ui.drawerHistoryActive,
          drawerHistoryClosing: !!window.ui.drawerHistoryClosing,
        };
        if (!desktopSidebar.ok) return { ok: false, reason: 'desktop sidebar failed', desktopSidebar };
      }
      window.ui.switchSession(s.id);
      await wait(1800);
      const before = {
        hasXterm: !!document.querySelector('#pty-screen .xterm'),
        ptyUseXterm: !!window.ui.ptyUseXterm,
        ptySessionId: window.ui.ptySessionId,
      };
      window.ui._sendPtyRaw('\\x03\\rWrite-Output "' + marker + '"\\r');
      for (let i = 0; i < 40; i++) {
        const tail = document.getElementById('pty-screen')?.dataset?.ptyTail || '';
        const xtermText = Array.from(document.querySelectorAll('#pty-screen .xterm-rows div')).map(el => el.textContent || '').join('\\n');
        if ((tail.includes(marker) || xtermText.includes(marker)) && !/ObjectNotFound|无法将/.test(tail + xtermText)) break;
        await wait(500);
      }
      const screen = document.getElementById('pty-screen');
      const tail = screen?.dataset?.ptyTail || '';
      const xtermText = Array.from(document.querySelectorAll('#pty-screen .xterm-rows div')).map(el => el.textContent || '').join('\\n');
      const commandError = /ObjectNotFound|无法将/.test(tail + xtermText);
      return {
        ok: !!document.querySelector('#pty-screen .xterm') && !!window.ui.ptyUseXterm && (tail.includes(marker) || xtermText.includes(marker)) && !commandError && (!isDesktopViewport || !!(desktopSidebar && desktopSidebar.ok)),
        marker,
        viewportMode: isDesktopViewport ? 'desktop' : 'mobile',
        conn: document.getElementById('nav-title')?.getAttribute('data-conn'),
        pwaVersion: typeof PWA_VERSION !== 'undefined' ? PWA_VERSION : null,
        activeHubId: window.ui.activeHubId,
        activeSessionId: window.ui.activeSessionId,
        ptySessionId: window.ui.ptySessionId,
        ptyUseXterm: !!window.ui.ptyUseXterm,
        hasXterm: !!document.querySelector('#pty-screen .xterm'),
        ptyTitle: document.getElementById('pty-title-text')?.textContent,
        navTitle: document.getElementById('nav-title-name')?.textContent,
        tailHasMarker: tail.includes(marker),
        xtermTextHasMarker: xtermText.includes(marker),
        commandError,
        desktopSidebar,
        ptyTail: tail.slice(-500),
        xtermTail: xtermText.slice(-500),
        before,
      };
    })()`);

    await sleep(700);
    await pwa.screenshot(SCREENSHOT);
    console.log(JSON.stringify({ ok: !!(result && result.ok), screenshot: SCREENSHOT, session, result }, null, 2));
    process.exitCode = result && result.ok ? 0 : 1;
  } finally {
    try { if (pwa) pwa.close(); } catch {}
    try { hub.close(); } catch {}
    if (chrome && chrome.pid) {
      spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
