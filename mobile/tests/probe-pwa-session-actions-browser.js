'use strict';

// Browser-level E2E for public PWA session row actions.
// Usage:
//   node mobile/tests/probe-pwa-session-actions-browser.js <hubId> <screenshotPath>

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const HUB_ID = process.argv[2];
const SCREENSHOT = process.argv[3] || 'C:\\Users\\lintian\\pwa-session-actions-e2e-20260612.png';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const PWA_DEVICE_TOKEN = process.env.PWA_DEVICE_TOKEN || '';
const PIN = '063551';
const DEBUG_PORT = Number(process.env.PWA_DEBUG_PORT || 28749);
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-session-actions-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!HUB_ID) {
  console.error('Usage: node mobile/tests/probe-pwa-session-actions-browser.js <hubId> <screenshotPath>');
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

async function main() {
  if (await portOpen(DEBUG_PORT)) throw new Error(`debug port ${DEBUG_PORT} is already in use`);

  const chrome = spawn(CHROME_EXE, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--window-size=1365,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  let pwa;
  try {
    pwa = await connectFirstPage(DEBUG_PORT);
    await pwa.send('Page.enable');
    await pwa.send('Runtime.enable');
    await pwa.send('Network.enable');
    await pwa.send('Emulation.setDeviceMetricsOverride', {
      width: 1365,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { angle: 0, type: 'landscapePrimary' },
    });
    await pwa.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HubSessionActionsE2E/0.1',
    });

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
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const initialTitle = 'PWA Action Probe ' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(8, 14);
      const renamedTitle = initialTitle + ' Renamed';
      if (!window.ui || !window.ui.client) return { ok: false, reason: 'ui missing' };
      window.ui.activeHubId = targetHub;
      localStorage.setItem('hub-mobile/active-hub', targetHub);

      const createdPromise = new Promise(resolve => {
        const handler = ev => {
          window.ui.client.removeEventListener('session-created', handler);
          resolve(ev.detail || {});
        };
        window.ui.client.addEventListener('session-created', handler);
        setTimeout(() => {
          window.ui.client.removeEventListener('session-created', handler);
          resolve(null);
        }, 12000);
      });
      window.ui.client.requestNewSession('powershell', initialTitle, targetHub);
      const created = await createdPromise;
      if (!created || !created.id) return { ok: false, reason: 'session create failed', created };
      const sid = created.id;
      for (let i = 0; i < 20; i++) {
        if ((window.ui.sessions || []).some(s => s.id === sid)) break;
        window.ui.client.requestSessionList(targetHub);
        await wait(250);
      }
      window.ui.openDrawer();
      await wait(200);
      let row = document.querySelector('.dsess[data-sid="' + sid + '"]');
      if (!row) return { ok: false, reason: 'row missing after create', sid, sessions: (window.ui.sessions || []).slice(0, 8).map(s => ({ id: s.id, title: s.title })) };

      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 80, clientY: 220 }));
      await wait(150);
      const rightClickSheet = !!document.querySelector('.sheet-overlay');
      const actionTexts = Array.from(document.querySelectorAll('.sheet-action')).map(el => el.textContent.trim());

      document.querySelector('.sheet-action[data-act="rename"]')?.click();
      await wait(120);
      const renameModalShown = !!document.querySelector('.rename-overlay');
      const input = document.querySelector('.rename-input');
      if (input) {
        input.value = renamedTitle;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('.rename-modal')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 30; i++) {
        window.ui.client.requestSessionList(targetHub);
        await wait(250);
        const s = (window.ui.sessions || []).find(x => x.id === sid);
        if (s && s.title === renamedTitle) break;
      }
      const renamed = (window.ui.sessions || []).find(x => x.id === sid);
      const renameOk = !!renamed && renamed.title === renamedTitle;

      row = document.querySelector('.dsess[data-sid="' + sid + '"]');
      if (!row) {
        window.ui._renderDrawerList();
        row = document.querySelector('.dsess[data-sid="' + sid + '"]');
      }
      if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 80, clientY: 220 }));
      await wait(150);
      document.querySelector('.sheet-action[data-act="pin"]')?.click();
      for (let i = 0; i < 30; i++) {
        window.ui.client.requestSessionList(targetHub);
        await wait(250);
        const s = (window.ui.sessions || []).find(x => x.id === sid);
        if (s && s.pinned) break;
      }
      const pinned = (window.ui.sessions || []).find(x => x.id === sid);
      window.ui._renderDrawerList();
      const rowTextAfterPin = document.querySelector('.dsess[data-sid="' + sid + '"]')?.textContent || '';
      const pinOk = !!pinned && !!pinned.pinned && (rowTextAfterPin.includes('📌') || rowTextAfterPin.includes('馃搶'));

      row = document.querySelector('.dsess[data-sid="' + sid + '"]');
      if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 80, clientY: 220 }));
      await wait(150);
      document.querySelector('.sheet-action[data-act="destroy"]')?.click();
      await wait(150);
      const confirmShown = !!document.querySelector('.modal-destroy');
      document.querySelector('.modal-destroy')?.click();
      for (let i = 0; i < 30; i++) {
        window.ui.client.requestSessionList(targetHub);
        await wait(250);
        if (!(window.ui.sessions || []).some(s => s.id === sid)) break;
      }
      const destroyOk = !(window.ui.sessions || []).some(s => s.id === sid);
      window.ui._renderDrawerList();
      const rowAfterDestroy = !!document.querySelector('.dsess[data-sid="' + sid + '"]');

      const debug = {
        pwaVersion: typeof PWA_VERSION !== 'undefined' ? PWA_VERSION : null,
        pwaSwCache: typeof PWA_SW_CACHE !== 'undefined' ? PWA_SW_CACHE : null,
        drawerVersion: document.getElementById('drawer-ver')?.textContent || null,
      };

      return {
        ok: rightClickSheet && renameModalShown && renameOk && pinOk && confirmShown && destroyOk && !rowAfterDestroy
          && debug.pwaVersion === 'v0.5.83'
          && debug.pwaSwCache === 'hub-mobile-v110',
        sid,
        initialTitle,
        renamedTitle,
        rightClickSheet,
        actionTexts,
        renameModalShown,
        renameOk,
        renamed,
        pinOk,
        pinned,
        confirmShown,
        destroyOk,
        rowAfterDestroy,
        debug,
        activeHubId: window.ui.activeHubId,
        drawerRows: Array.from(document.querySelectorAll('.dsess')).slice(0, 8).map(el => el.textContent || ''),
      };
    })()`);

    await sleep(700);
    await pwa.screenshot(SCREENSHOT);
    console.log(JSON.stringify({ ok: !!(result && result.ok), screenshot: SCREENSHOT, result }, null, 2));
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

