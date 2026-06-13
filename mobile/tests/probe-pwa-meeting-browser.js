'use strict';

// Browser-level E2E for the public PWA meeting controls.
// Usage:
//   node mobile/tests/probe-pwa-meeting-browser.js <hubId> <screenshotPath>

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const HUB_ID = process.argv[2];
const SCREENSHOT = process.argv[3] || 'C:\\Users\\lintian\\pwa-hub-meeting-e2e-20260612.png';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const PWA_DEVICE_TOKEN = process.env.PWA_DEVICE_TOKEN || '';
const PWA_VIEWPORT = (process.env.PWA_VIEWPORT || 'mobile').toLowerCase();
const IS_DESKTOP = PWA_VIEWPORT === 'desktop';
const PIN = '063551';
const DEBUG_PORT = 28747;
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-meeting-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!HUB_ID) {
  console.error('Usage: node mobile/tests/probe-pwa-meeting-browser.js <hubId> <screenshotPath>');
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
      await pwa.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await pwa.send('Network.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HubMeetingE2E/0.1',
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
        userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36 HubMeetingE2E/0.1',
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
        await sleep(120);
      }
    }
    await sleep(3500);

    const result = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const isDesktopViewport = ${JSON.stringify(IS_DESKTOP)};
      const marker = 'PWA_MEETING_E2E_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      const title = 'PWA Meeting E2E ' + marker.slice(-6);
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || !window.ui.client) return { ok: false, reason: 'ui missing' };

      for (let i = 0; i < 40; i++) {
        window.ui.client.requestHubList();
        await wait(300);
        if ((window.ui.hubs || []).some(h => h.hubId === targetHub)) break;
      }
      if (!(window.ui.hubs || []).some(h => h.hubId === targetHub)) {
        return { ok: false, reason: 'target hub missing', hubs: (window.ui.hubs || []).map(h => h.hubId) };
      }
      window.ui.activeHubId = targetHub;
      localStorage.setItem('hub-mobile/active-hub', targetHub);
      window.ui.client.requestSessionList(targetHub);
      window.ui.client.requestMeetingList(targetHub);
      window.ui.client.requestHubSnapshot(targetHub);
      await wait(600);
      let drawerBackClose = null;
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
        const drawerRows = document.querySelectorAll('.dsess').length;
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
            && drawerRows >= 1
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
          drawerRows,
          drawerHistoryActive: !!window.ui.drawerHistoryActive,
          drawerHistoryClosing: !!window.ui.drawerHistoryClosing,
        };
        if (!desktopSidebar.ok) return { ok: false, reason: 'desktop sidebar failed', desktopSidebar };
      } else {
        const menuBtn = document.getElementById('btn-menu');
        if (!menuBtn) return { ok: false, reason: 'menu button missing' };
        const before = Number(window.ui.drawerBackCloseCount) || 0;
        const beforeUrl = location.href;
        menuBtn.click();
        await wait(250);
        const overlay = document.getElementById('drawer-overlay');
        const beforeOpen = !!(overlay && overlay.classList.contains('on'));
        const beforeActive = !!window.ui.drawerHistoryActive;
        const beforeToken = window.ui.drawerHistoryToken || null;
        try { history.back(); } catch (e) {
          return { ok: false, reason: 'drawer history.back failed: ' + (e && e.message || e) };
        }
        for (let i = 0; i < 30; i++) {
          await wait(100);
          if (!(overlay && overlay.classList.contains('on'))) break;
        }
        const afterOpen = !!(overlay && overlay.classList.contains('on'));
        const after = Number(window.ui.drawerBackCloseCount) || 0;
        const afterUrl = location.href;
        drawerBackClose = {
          ok: beforeOpen === true
            && beforeActive === true
            && !!beforeToken
            && afterOpen === false
            && after >= before + 1
            && window.ui.drawerHistoryActive === false
            && window.ui.drawerHistoryClosing === false
            && afterUrl === beforeUrl,
          before,
          after,
          beforeUrl,
          afterUrl,
          beforeOpen,
          afterOpen,
          beforeActive,
          beforeToken,
          lastReason: window.ui.drawerBackCloseLastReason || '',
        };
        if (!drawerBackClose.ok) return { ok: false, reason: 'drawer back close failed', drawerBackClose };
      }

      const createdPromise = new Promise(resolve => {
        const timer = setTimeout(() => {
          window.ui.client.removeEventListener('meeting-created', handler);
          resolve({ timeout: true });
        }, 30000);
        const handler = (e) => {
          clearTimeout(timer);
          window.ui.client.removeEventListener('meeting-created', handler);
          resolve(e.detail || {});
        };
        window.ui.client.addEventListener('meeting-created', handler);
      });
      const newButton = document.getElementById('btn-new');
      if (!newButton) return { ok: false, reason: 'new button missing' };
      newButton.click();
      await wait(200);
      const meetingButton = document.querySelector('[data-meeting-mode="general"]');
      if (!meetingButton) return { ok: false, reason: 'meeting option missing' };
      meetingButton.click();
      const created = await createdPromise;
      if (!created || created.timeout || created.ok === false) {
        return { ok: false, reason: 'meeting create failed or timed out', created };
      }

      const meeting = created.meeting || created;
      const meetingId = meeting.id && String(meeting.id).startsWith('meeting:') ? meeting.id : 'meeting:' + meeting.id;
      for (let i = 0; i < 40; i++) {
        const s = (window.ui.sessions || []).find(x => x.id === meetingId || x.targetId === meeting.id || x.title === title);
        if (s) break;
        window.ui.client.requestMeetingList(targetHub);
        window.ui.client.requestHubSnapshot(targetHub);
        await wait(500);
      }
      const card = (window.ui.sessions || []).find(x => x.id === meetingId || x.targetId === meeting.id || x.title === title);
      if (!card) {
        return { ok: false, reason: 'meeting card not found', created, sessions: (window.ui.sessions || []).map(s => ({ id: s.id, title: s.title, targetType: s.targetType })) };
      }

      window.ui.switchSession(card.id);
      await wait(800);
      const firstMemberSid = (card.members && card.members[0] && card.members[0].sid)
        || (meeting.subSessions && meeting.subSessions[0])
        || null;
      let memberJumpOk = false;
      if (firstMemberSid) {
        for (let i = 0; i < 20; i++) {
          if ((window.ui.sessions || []).some(s => s.id === firstMemberSid || s.targetId === firstMemberSid)) break;
          window.ui.client.requestHubSnapshot(targetHub);
          await wait(400);
        }
        const chip = document.querySelector('.meeting-member-chip[data-sid="' + firstMemberSid + '"]');
        if (chip) {
          chip.click();
          await wait(600);
          memberJumpOk = window.ui.activeSessionId === firstMemberSid || ((window.ui.sessions || []).find(s => s.id === window.ui.activeSessionId)?.targetId === firstMemberSid);
          window.ui.switchSession(card.id);
          await wait(600);
        }
      }
      const ackPromise = new Promise(resolve => {
        const timer = setTimeout(() => {
          window.ui.client.removeEventListener('command-ack', handler);
          resolve({ timeout: true });
        }, 20000);
        const handler = (e) => {
          clearTimeout(timer);
          window.ui.client.removeEventListener('command-ack', handler);
          resolve(e.detail || {});
        };
        window.ui.client.addEventListener('command-ack', handler);
      });
      window.ui.sendInputText('E2E meeting command ' + marker);
      const ack = await ackPromise;
      for (let i = 0; i < 12; i++) {
        window.ui.client.requestHubSnapshot(targetHub);
        await wait(500);
        const rows = document.querySelectorAll('.meeting-timeline-row').length;
        if (rows >= 1) break;
      }
      const streamText = document.getElementById('stream')?.textContent || '';
      const stateEl = document.querySelector('[data-meeting-remote-state="true"]');
      const memberChipCount = document.querySelectorAll('.meeting-member-chip').length;
      const timelineRowCount = document.querySelectorAll('.meeting-timeline-row').length;
      const timelineEmpty = !!document.querySelector('.meeting-timeline .meeting-remote-empty');
      const drawerRows = Array.from(document.querySelectorAll('.dsess')).map(el => el.textContent || '');
      let debugSwCache = null;
      try {
        window.ui.showDebugPanel();
        await wait(350);
        const rows = Array.from(document.querySelectorAll('.dbg-row'));
        const swRow = rows.find(row => ((row.querySelector('.k')?.textContent || '').trim() === 'SW Cache') || (row.textContent || '').includes('SW Cache'));
        debugSwCache = swRow ? (swRow.querySelector('.v')?.textContent || '').trim() : null;
        document.querySelector('.dbg-close')?.click();
      } catch (e) {
        debugSwCache = 'ERR:' + ((e && e.message) || String(e));
      }
      return {
        ok: !!ack && ack.ok === true && window.ui.activeSessionId === card.id && streamText.includes(marker) && !!stateEl && memberChipCount >= 3 && timelineRowCount >= 1 && memberJumpOk && debugSwCache === 'hub-mobile-v110' && (isDesktopViewport ? !!(desktopSidebar && desktopSidebar.ok) : !!(drawerBackClose && drawerBackClose.ok)),
        marker,
        title,
        pwaVersion: typeof PWA_VERSION !== 'undefined' ? PWA_VERSION : null,
        pwaSwCache: typeof PWA_SW_CACHE !== 'undefined' ? PWA_SW_CACHE : null,
        pwaSwLabel: typeof PWA_SW_LABEL !== 'undefined' ? PWA_SW_LABEL : null,
        debugSwCache,
        viewportMode: isDesktopViewport ? 'desktop' : 'mobile',
        activeHubId: window.ui.activeHubId,
        activeSessionId: window.ui.activeSessionId,
        meetingCard: { id: card.id, targetId: card.targetId, title: card.title, targetType: card.targetType, subSessionCount: card.subSessionCount },
        created,
        ack,
        drawerBackClose,
        desktopSidebar,
        streamHasMarker: streamText.includes(marker),
        meetingRemoteState: !!stateEl,
        memberChipCount,
        firstMemberSid,
        memberJumpOk,
        timelineRowCount,
        timelineEmpty,
        navTitle: document.getElementById('nav-title-name')?.textContent,
        ptyHidden: document.getElementById('pty-panel')?.hidden === true,
        drawerRows: drawerRows.slice(0, 8),
      };
    })()`);

    await sleep(700);
    await pwa.screenshot(SCREENSHOT);
    console.log(JSON.stringify({ ok: !!(result && result.ok), screenshot: SCREENSHOT, result }, null, 2));
    process.exitCode = result && result.ok ? 0 : 1;
  } finally {
    try { if (pwa) pwa.close(); } catch {}
    if (chrome && chrome.pid) {
      spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});


