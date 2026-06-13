'use strict';

// Browser-level E2E for the public PWA Hub View overlay.
// Usage:
//   node mobile/tests/probe-pwa-hub-view-browser.js <hubId> <screenshotPath>

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const HUB_ID = process.argv[2];
const SCREENSHOT = process.argv[3] || 'C:\\Users\\lintian\\pwa-hub-view-e2e-20260612.png';
const PWA_URL = process.env.PWA_URL || 'https://lthub.xyz:8443/';
const PWA_DEVICE_TOKEN = process.env.PWA_DEVICE_TOKEN || '';
const PIN = '063551';
const DEBUG_PORT = 28748;
const HUB_CDP_PORT = Number(process.env.HUB_CDP_PORT || 62238);
const VIEWPORT_MODE = String(process.env.PWA_VIEWPORT || 'mobile').toLowerCase();
const DESKTOP_VIEWPORT = VIEWPORT_MODE === 'desktop';
const USER_DATA = `C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-view-e2e-${Date.now()}`;
const CHROME_EXE = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!HUB_ID) {
  console.error('Usage: node mobile/tests/probe-pwa-hub-view-browser.js <hubId> <screenshotPath>');
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
    '--window-size=420,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  let pwa;
  let hub;
  try {
    pwa = await connectFirstPage(DEBUG_PORT);
    await pwa.send('Page.enable');
    await pwa.send('Runtime.enable');
    await pwa.send('Network.enable');
    await pwa.send('Emulation.setDeviceMetricsOverride', DESKTOP_VIEWPORT ? {
      width: 1280,
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
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HubViewE2E/0.1'
        : 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36 HubViewE2E/0.1',
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
    const uiReady = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const hasToken = ${JSON.stringify(!!PWA_DEVICE_TOKEN)};
      for (let i = 0; i < 50; i++) {
        if (hasToken && window.ui && window.ui.client) return true;
        if (window.ui && document.querySelectorAll('.key[data-key]').length >= 10) return true;
        await wait(200);
      }
      return false;
    })()`);
    if (!uiReady) throw new Error('PWA UI not ready for PIN entry');
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
          if (window.ui && typeof window.ui.pinType === 'function') {
            window.ui.pinType(${JSON.stringify(digit)});
            return true;
          }
          const btn = document.querySelector('.key[data-key="${digit}"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        if (!ok) throw new Error(`PIN key not found: ${digit}`);
        await sleep(120);
      }
      const paired = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60; i++) {
          if (window.ui && window.ui.client && localStorage.getItem('hub-mobile/device-token')) return true;
          await wait(250);
        }
        return false;
      })()`);
      if (!paired) throw new Error('PIN pairing did not establish a client');
    }

    hub = await connectFirstPage(HUB_CDP_PORT);
    await hub.send('Page.enable');
    await hub.send('Runtime.enable');
    const desktopTarget = await hub.eval(`(() => {
      const modal = document.getElementById('meeting-create-modal');
      const modalOpen = !!(modal && modal.style.display !== 'none');
      const el = document.querySelector('[data-launcher-action="group"]');
      if (!el) return { ok: false, reason: 'launcher group button missing', modalOpen, body: document.body.innerText.slice(0, 300) };
      const r = el.getBoundingClientRect();
      return {
        ok: true,
        modalOpen,
        text: el.textContent.trim(),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    })()`);
    if (!desktopTarget || !desktopTarget.ok) {
      throw new Error('Desktop target not ready: ' + JSON.stringify(desktopTarget));
    }
    if (desktopTarget.modalOpen) {
      throw new Error('Desktop meeting modal already open before remote click');
    }

    const result = await pwa.eval(`(async () => {
      const targetHub = ${JSON.stringify(HUB_ID)};
      const desktopTarget = ${JSON.stringify(desktopTarget)};
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || !window.ui.client) return { ok: false, reason: 'ui missing' };

      for (let i = 0; i < 45; i++) {
        window.ui.client.requestHubList();
        await wait(300);
        if ((window.ui.hubs || []).some(h => h.hubId === targetHub)) break;
      }
      if (!(window.ui.hubs || []).some(h => h.hubId === targetHub)) {
        return { ok: false, reason: 'target hub missing', hubs: (window.ui.hubs || []).map(h => h.hubId) };
      }
      window.ui.activeHubId = targetHub;
      localStorage.setItem('hub-mobile/active-hub', targetHub);

      const menuBtn = document.getElementById('btn-menu');
      if (!menuBtn) return { ok: false, reason: 'menu missing' };
      menuBtn.click();
      await wait(300);
      const viewBtn = document.getElementById('drawer-hub-view-link');
      if (!viewBtn) return { ok: false, reason: 'hub view drawer button missing' };
      viewBtn.click();

      for (let i = 0; i < 60; i++) {
        const img = document.getElementById('hub-view-image');
        if (img && img.naturalWidth > 200 && img.naturalHeight > 100) break;
        await wait(500);
      }
      const img = document.getElementById('hub-view-image');
      const status = document.getElementById('hub-view-status')?.textContent || '';
      const src = img ? img.getAttribute('src') || '' : '';
      const requestedFrameWidth = window.ui && typeof window.ui._hubViewFrameWidth === 'function'
        ? window.ui._hubViewFrameWidth()
        : null;
      let inputAck = null;
      let remoteClick = null;
      let zoomState = null;
      let livePulse = null;
      let fastFrame = null;
      let boundedCoordinate = null;
      const toolbarLayout = (() => {
        const rectOf = (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom };
        };
        const title = document.querySelector('#hub-view-overlay .hv-title');
        const titleRect = title ? title.getBoundingClientRect() : null;
        const mod = rectOf('hub-view-mod');
        const clip = rectOf('hub-view-clip');
        const setclip = rectOf('hub-view-setclip');
        const file = rectOf('hub-view-file');
        const live = rectOf('hub-view-live');
        const sameRow = !!(clip && setclip && file
          && Math.abs((clip.top || 0) - (setclip.top || 0)) <= 4
          && Math.abs((file.top || 0) - (setclip.top || 0)) <= 4
          && (!mod || Math.abs((mod.top || 0) - (clip.top || 0)) <= 4)
          && (!live || Math.abs((live.top || 0) - (clip.top || 0)) <= 4));
        const belowTitle = !!(titleRect && setclip && setclip.top >= titleRect.bottom - 2);
        const betweenClipAndFile = !!(clip && setclip && file && clip.left < setclip.left && setclip.left < file.left);
        return {
          ok: sameRow && belowTitle && betweenClipAndFile,
          title: titleRect ? { top: titleRect.top, bottom: titleRect.bottom } : null,
          mod,
          clip,
          setclip,
          file,
          live,
          sameRow,
          belowTitle,
          betweenClipAndFile,
        };
      })();
      if (img && window.ui && window.ui.lastHubViewFrame) {
        const zoomBtn = document.getElementById('hub-view-zoom');
        if (zoomBtn && !window.ui.hubViewActualSize) {
          zoomBtn.click();
          await wait(250);
        }
        let multiZoom = null;
        if (zoomBtn && typeof window.ui._hubViewZoomLabel === 'function') {
          const afterOneX = document.getElementById('hub-view-image') || img;
          const oneRect = afterOneX ? afterOneX.getBoundingClientRect() : { width: 0 };
          const oneLabel = (zoomBtn.textContent || '').trim();
          zoomBtn.click();
          await wait(300);
          const afterOnePointFive = document.getElementById('hub-view-image') || afterOneX;
          const onePointFiveRect = afterOnePointFive ? afterOnePointFive.getBoundingClientRect() : { width: 0 };
          const onePointFiveLabel = (zoomBtn.textContent || '').trim();
          multiZoom = {
            ok: window.ui.hubViewActualSize === true
              && Math.abs((Number(window.ui.hubViewZoomScale) || 0) - 1.5) < 0.01
              && onePointFiveRect.width > oneRect.width * 1.35
              && oneLabel === '1X'
              && onePointFiveLabel === '1.5X'
              && !!((document.getElementById('hub-view-overlay') || {}).classList || { contains: () => false }).contains('hv-actual-size'),
            oneWidth: oneRect.width,
            onePointFiveWidth: onePointFiveRect.width,
            oneLabel,
            onePointFiveLabel,
            scale: Number(window.ui.hubViewZoomScale) || 0,
          };
        }
        let activeImg = img;
        for (let i = 0; i < 20; i++) {
          activeImg = document.getElementById('hub-view-image') || activeImg;
          const probeRect = activeImg ? activeImg.getBoundingClientRect() : { width: 0, height: 0 };
          if (probeRect.width > 100 && probeRect.height > 100) break;
          await wait(100);
        }
        const frame = window.ui.lastHubViewFrame || {};
        const frameWidth = Number(frame.width || activeImg.naturalWidth || 1);
        const frameHeight = Number(frame.height || activeImg.naturalHeight || 1);
        const srcWidth = Number(desktopTarget.viewportWidth || frame.originalWidth || frameWidth || 1);
        const srcHeight = Number(desktopTarget.viewportHeight || frame.originalHeight || frameHeight || 1);
        const rect = activeImg.getBoundingClientRect();
        const body = document.getElementById('hub-view-body');
        zoomState = {
          actualSize: !!window.ui.hubViewActualSize,
          scale: Number(window.ui.hubViewZoomScale) || 0,
          imageWidth: rect.width,
          bodyWidth: body ? body.clientWidth : 0,
          scrollWidth: body ? body.scrollWidth : 0,
          multiZoom,
        };
        window.ui.hubViewLiveFrameTimes = [];
        const firstCapturedAt = window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || null;
        for (let i = 0; i < 25; i++) {
          await wait(120);
          const times = window.ui.hubViewLiveFrameTimes || [];
          const latestCapturedAt = window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || null;
          if (times.length >= 3 && latestCapturedAt && latestCapturedAt !== firstCapturedAt) break;
        }
        const liveTimes = window.ui.hubViewLiveFrameTimes || [];
        livePulse = {
          mode: window.ui.hubViewLiveMode || null,
          minDelayMs: window.ui.hubViewLiveMinDelayMs || null,
          streamSubscribed: !!window.ui.hubViewStreamSubscribed,
          streamFrameCount: Number(window.ui.hubViewStreamFrameCount || 0),
          streamDelayMs: Number(window.ui.hubViewStreamDelayMs || 0),
          lastStream: !!(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.stream),
          frameCount: liveTimes.length,
          spanMs: liveTimes.length > 1 ? liveTimes[liveTimes.length - 1] - liveTimes[0] : 0,
          capturedAtChanged: !!(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt && window.ui.lastHubViewFrame.capturedAt !== firstCapturedAt),
        };
        for (let i = 0; i < 20; i++) {
          activeImg = document.getElementById('hub-view-image') || activeImg;
          const probeRect = activeImg ? activeImg.getBoundingClientRect() : { width: 0, height: 0 };
          if (probeRect.width > 100 && probeRect.height > 100) break;
          await wait(100);
        }
        const clickRect = activeImg.getBoundingClientRect();
        const edgePoint = typeof window.ui._hubViewPoint === 'function'
          ? window.ui._hubViewPoint(clickRect.right + 500, clickRect.bottom + 500, activeImg, frame)
          : null;
        const originPoint = typeof window.ui._hubViewPoint === 'function'
          ? window.ui._hubViewPoint(clickRect.left - 500, clickRect.top - 500, activeImg, frame)
          : null;
        boundedCoordinate = {
          ok: !!(edgePoint && originPoint
            && edgePoint.x === frameWidth - 1
            && edgePoint.y === frameHeight - 1
            && originPoint.x === 0
            && originPoint.y === 0),
          edgePoint,
          originPoint,
          frameWidth,
          frameHeight,
        };
        const clientX = clickRect.left + (desktopTarget.x / srcWidth) * clickRect.width;
        const clientY = clickRect.top + (desktopTarget.y / srcHeight) * clickRect.height;
        const frameX = Math.round((desktopTarget.x / srcWidth) * frameWidth);
        const frameY = Math.round((desktopTarget.y / srcHeight) * frameHeight);
        const beforeInputCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
        const ackPromise = new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const directClickRequestId = window.ui.client.sendHubViewInput({
          kind: 'mouse-click',
          button: 'left',
          clickCount: 1,
          x: frameX,
          y: frameY,
          width: frameWidth,
          height: frameHeight,
          originalWidth: srcWidth,
          originalHeight: srcHeight,
        }, window.ui.activeHubId);
        inputAck = await ackPromise;
        remoteClick = {
          clientX,
          clientY,
          frameX,
          frameY,
          directClickRequestId,
          srcWidth,
          srcHeight,
          frameWidth,
          frameHeight,
          targetX: desktopTarget.x,
          targetY: desktopTarget.y,
        };
        const fastStart = Date.now();
        for (let i = 0; i < 30; i++) {
          await wait(80);
          const latestCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
          const stats = window.ui.lastHubViewFrameStats || {};
          if (latestCapturedAt > beforeInputCapturedAt && stats && (stats.fast === true || stats.stream === true)) break;
        }
        const afterInputCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
        const stats = window.ui.lastHubViewFrameStats || {};
        fastFrame = {
          ok: afterInputCapturedAt > beforeInputCapturedAt
            && (stats.fast === true || stats.stream === true)
            && (stats.stream === true || Number(stats.rttMs) >= 0)
            && Number(stats.ageMs) >= 0
            && Number(window.ui.hubViewLiveFastDelayMs || 0) <= 60,
          beforeInputCapturedAt,
          afterInputCapturedAt,
          elapsedMs: Date.now() - fastStart,
          fastDelayMs: Number(window.ui.hubViewLiveFastDelayMs || 0),
          minDelayMs: Number(window.ui.hubViewLiveMinDelayMs || 0),
          fastUntil: Number(window.ui.hubViewLiveFastUntil || 0),
          stats,
        };
      }
      return {
        ok: !!img && img.naturalWidth > 200 && img.naturalHeight > 100
          && src.startsWith('data:image/jpeg;base64,')
          && (!${JSON.stringify(DESKTOP_VIEWPORT)} || img.naturalWidth >= 1200)
          && !!inputAck && inputAck.ok === true
          && zoomState && zoomState.actualSize === true
          && zoomState.scale >= 1.5
          && zoomState.multiZoom && zoomState.multiZoom.ok === true
          && zoomState.imageWidth > zoomState.bodyWidth
          && boundedCoordinate && boundedCoordinate.ok === true
          && toolbarLayout && toolbarLayout.ok === true
          && livePulse && livePulse.mode === 'adaptive'
          && Number(livePulse.minDelayMs) <= 150
          && livePulse.streamSubscribed === true
          && livePulse.streamFrameCount >= 2
          && livePulse.lastStream === true
          && livePulse.frameCount >= 2
          && livePulse.capturedAtChanged === true
          && fastFrame && fastFrame.ok === true,
        pwaVersion: typeof PWA_VERSION !== 'undefined' ? PWA_VERSION : null,
        viewportMode: ${JSON.stringify(VIEWPORT_MODE)},
        activeHubId: window.ui.activeHubId,
        status,
        requestedFrameWidth,
        imagePresent: !!img,
        naturalWidth: img ? img.naturalWidth : 0,
        naturalHeight: img ? img.naturalHeight : 0,
        dataUrlPrefix: src.slice(0, 23),
        dataUrlLength: src.length,
        frameMimeType: window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.mimeType || null,
        frameByteLength: window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.byteLength || null,
        frameQuality: window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.quality || null,
        capturedAt: img ? img.dataset.capturedAt : null,
        desktopTarget,
        remoteClick,
        zoomState,
        boundedCoordinate,
        toolbarLayout,
        livePulse,
        fastFrame,
        inputAck,
      };
    })()`);

    const browserBackCloseResult = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || typeof window.ui._handleHubViewPopState !== 'function') {
        return { ok: false, reason: 'history hook missing' };
      }
      const before = Number(window.ui.hubViewBackCloseCount) || 0;
      const beforeUrl = location.href;
      const beforeToken = window.ui.hubViewHistoryToken || null;
      const beforeActive = !!window.ui.hubViewHistoryActive;
      const beforeOverlay = !!document.getElementById('hub-view-overlay');
      try { history.back(); } catch (e) {
        return { ok: false, reason: 'history.back failed: ' + (e && e.message || e) };
      }
      for (let i = 0; i < 30; i++) {
        await wait(100);
        if (!document.getElementById('hub-view-overlay')) break;
      }
      const afterOverlay = !!document.getElementById('hub-view-overlay');
      const after = Number(window.ui.hubViewBackCloseCount) || 0;
      const afterUrl = location.href;
      return {
        ok: beforeOverlay === true
          && beforeActive === true
          && !!beforeToken
          && afterOverlay === false
          && after >= before + 1
          && window.ui.hubViewHistoryActive === false
          && window.ui.hubViewHistoryClosing === false
          && afterUrl === beforeUrl,
        before,
        after,
        beforeUrl,
        afterUrl,
        beforeToken,
        beforeActive,
        beforeOverlay,
        afterOverlay,
        lastReason: window.ui.hubViewBackCloseLastReason || '',
      };
    })()`);
    result.browserBackClose = browserBackCloseResult;
    result.ok = !!(result && result.ok && browserBackCloseResult && browserBackCloseResult.ok);

    const reopenHubViewResult = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || typeof window.ui.showHubView !== 'function') {
        return { ok: false, reason: 'showHubView missing' };
      }
      if (!document.getElementById('hub-view-overlay')) {
        window.ui.showHubView();
      }
      for (let i = 0; i < 60; i++) {
        const img = document.getElementById('hub-view-image');
        if (img && img.naturalWidth > 200 && img.naturalHeight > 100) break;
        await wait(500);
      }
      const img = document.getElementById('hub-view-image');
      return {
        ok: !!img
          && img.naturalWidth > 200
          && img.naturalHeight > 100
          && window.ui.hubViewHistoryActive === true
          && !!window.ui.hubViewHistoryToken,
        imagePresent: !!img,
        naturalWidth: img ? img.naturalWidth : 0,
        naturalHeight: img ? img.naturalHeight : 0,
        historyActive: !!window.ui.hubViewHistoryActive,
        historyToken: window.ui.hubViewHistoryToken || null,
      };
    })()`);
    result.reopenHubView = reopenHubViewResult;
    result.ok = !!(result && result.ok && reopenHubViewResult && reopenHubViewResult.ok);

    const foregroundResumeResult = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || typeof window.ui._handleForegroundResume !== 'function') {
        return { ok: false, reason: 'resume hook missing' };
      }
      const before = Number(window.ui.foregroundResumeCount) || 0;
      const beforeLast = Number(window.ui.foregroundLastRefreshAt) || 0;
      const returned = window.ui._handleForegroundResume('e2e-foreground', { force: true });
      await wait(900);
      return {
        ok: returned === true
          && (Number(window.ui.foregroundResumeCount) || 0) === before + 1
          && window.ui.foregroundLastReason === 'e2e-foreground'
          && (Number(window.ui.foregroundLastRefreshAt) || 0) >= beforeLast
          && (window.ui.hubs || []).some(h => h.hubId === ${JSON.stringify(HUB_ID)})
          && !!window.ui.activeHubId,
        returned,
        before,
        after: Number(window.ui.foregroundResumeCount) || 0,
        lastReason: window.ui.foregroundLastReason,
        lastRefreshAt: Number(window.ui.foregroundLastRefreshAt) || 0,
        hubCount: (window.ui.hubs || []).length,
        activeHubId: window.ui.activeHubId,
        clientState: window.ui.client && window.ui.client.state,
      };
    })()`);
    result.foregroundResume = foregroundResumeResult;
    result.ok = !!(result.ok && foregroundResumeResult && foregroundResumeResult.ok);

    const streamRecoveryResult = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || typeof window.ui._restartHubViewStream !== 'function') {
        return { ok: false, reason: 'stream restart hook missing' };
      }
      const beforeRestart = Number(window.ui.hubViewStreamRestartCount) || 0;
      const beforeFrameCount = Number(window.ui.hubViewStreamFrameCount) || 0;
      const beforeCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
      const restarted = window.ui._restartHubViewStream('e2e-watchdog');
      let latestCapturedAt = beforeCapturedAt;
      let latestFrameCount = beforeFrameCount;
      for (let i = 0; i < 30; i++) {
        await wait(120);
        latestCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
        latestFrameCount = Number(window.ui.hubViewStreamFrameCount) || 0;
        if (latestCapturedAt > beforeCapturedAt && latestFrameCount > beforeFrameCount) break;
      }
      return {
        ok: restarted === true
          && (Number(window.ui.hubViewStreamRestartCount) || 0) >= beforeRestart + 1
          && window.ui.hubViewStreamLastRestartReason === 'e2e-watchdog'
          && window.ui.hubViewStreamSubscribed === true
          && latestFrameCount > beforeFrameCount
          && latestCapturedAt > beforeCapturedAt
          && window.ui.lastHubViewFrameStats
          && window.ui.lastHubViewFrameStats.stream === true,
        restarted,
        beforeRestart,
        afterRestart: Number(window.ui.hubViewStreamRestartCount) || 0,
        lastReason: window.ui.hubViewStreamLastRestartReason,
        beforeFrameCount,
        afterFrameCount: latestFrameCount,
        beforeCapturedAt,
        afterCapturedAt: latestCapturedAt,
        subscribed: !!window.ui.hubViewStreamSubscribed,
        stats: window.ui.lastHubViewFrameStats || null,
      };
    })()`);
    result.streamRecovery = streamRecoveryResult;
    result.ok = !!(result.ok && streamRecoveryResult && streamRecoveryResult.ok);

    const gatewayReconnectResult = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || !window.ui.client || !window.ui.client.ws) {
        return { ok: false, reason: 'client websocket missing' };
      }
      const beforeReconnect = Number(window.ui.gatewayReconnectCount) || 0;
      const beforeRestart = Number(window.ui.hubViewStreamRestartCount) || 0;
      const beforeFrameCount = Number(window.ui.hubViewStreamFrameCount) || 0;
      const beforeCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
      try { window.ui.client.ws.close(4001, 'e2e-reconnect'); } catch (e) {
        return { ok: false, reason: 'close failed: ' + (e && e.message || e) };
      }
      let latestFrameCount = beforeFrameCount;
      let latestCapturedAt = beforeCapturedAt;
      let connected = false;
      for (let i = 0; i < 80; i++) {
        await wait(150);
        connected = !!(window.ui.client && window.ui.client.state === 'connected' && window.ui.client.ws && window.ui.client.ws.readyState === 1);
        latestFrameCount = Number(window.ui.hubViewStreamFrameCount) || 0;
        latestCapturedAt = Number(window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || 0);
        if (connected
          && (Number(window.ui.gatewayReconnectCount) || 0) > beforeReconnect
          && (Number(window.ui.hubViewStreamRestartCount) || 0) > beforeRestart
          && latestFrameCount > beforeFrameCount
          && latestCapturedAt > beforeCapturedAt) break;
      }
      return {
        ok: connected
          && (Number(window.ui.gatewayReconnectCount) || 0) > beforeReconnect
          && window.ui.gatewayReconnectLastReason === 'websocket-reconnect'
          && window.ui.hubViewStreamLastRestartReason === 'gateway-reconnect'
          && window.ui.hubViewStreamSubscribed === true
          && latestFrameCount > beforeFrameCount
          && latestCapturedAt > beforeCapturedAt
          && (window.ui.hubs || []).some(h => h.hubId === ${JSON.stringify(HUB_ID)})
          && !!window.ui.activeHubId,
        connected,
        beforeReconnect,
        afterReconnect: Number(window.ui.gatewayReconnectCount) || 0,
        lastReason: window.ui.gatewayReconnectLastReason,
        beforeRestart,
        afterRestart: Number(window.ui.hubViewStreamRestartCount) || 0,
        streamRestartReason: window.ui.hubViewStreamLastRestartReason,
        beforeFrameCount,
        afterFrameCount: latestFrameCount,
        beforeCapturedAt,
        afterCapturedAt: latestCapturedAt,
        streamSubscribed: !!window.ui.hubViewStreamSubscribed,
        hubCount: (window.ui.hubs || []).length,
        activeHubId: window.ui.activeHubId,
        clientState: window.ui.client && window.ui.client.state,
      };
    })()`);
    result.gatewayReconnect = gatewayReconnectResult;
    result.ok = !!(result.ok && gatewayReconnectResult && gatewayReconnectResult.ok);

    const wakeLockResult = await pwa.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (!window.ui || typeof window.ui._syncHubViewWakeLock !== 'function' || typeof window.ui._releaseHubViewWakeLock !== 'function') {
        return { ok: false, reason: 'wake lock hooks missing' };
      }
      const calls = [];
      const releases = [];
      const makeSentinel = () => {
        const listeners = {};
        return {
          released: false,
          addEventListener(type, fn) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(fn);
          },
          async release() {
            if (this.released) return;
            this.released = true;
            releases.push(Date.now());
            for (const fn of (listeners.release || [])) {
              try { fn({ type: 'release' }); } catch (_) {}
            }
          },
        };
      };
      try {
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          value: {
            request: async (type) => {
              calls.push({ type, at: Date.now() });
              return makeSentinel();
            },
          },
        });
      } catch (e) {
        return { ok: false, reason: 'wake lock mock failed: ' + (e && e.message || e) };
      }
      const liveBtn = document.getElementById('hub-view-live');
      if (!window.ui.hubViewLive && liveBtn) {
        liveBtn.click();
        await wait(100);
      }
      window.ui._releaseHubViewWakeLock('e2e-reset');
      await wait(50);
      const acquireCountBefore = Number(window.ui.hubViewWakeLockAcquireCount) || 0;
      const releaseCountBefore = Number(window.ui.hubViewWakeLockReleaseCount) || 0;
      const acquireOk = await window.ui._syncHubViewWakeLock('e2e-acquire');
      await wait(50);
      const activeAfterAcquire = !!window.ui.hubViewWakeLockActive;
      const acquiredReason = window.ui.hubViewWakeLockLastReason;
      window.ui.hubViewLive = false;
      const releaseReturned = window.ui._releaseHubViewWakeLock('e2e-live-off');
      await wait(50);
      const inactiveAfterRelease = !window.ui.hubViewWakeLockActive;
      window.ui.hubViewLive = true;
      const reacquireOk = await window.ui._syncHubViewWakeLock('e2e-reacquire');
      await wait(50);
      return {
        ok: acquireOk === true
          && activeAfterAcquire
          && acquiredReason === 'e2e-acquire'
          && releaseReturned === true
          && inactiveAfterRelease
          && reacquireOk === true
          && window.ui.hubViewWakeLockActive === true
          && calls.length >= 2
          && calls.every(c => c.type === 'screen')
          && (Number(window.ui.hubViewWakeLockAcquireCount) || 0) >= acquireCountBefore + 2
          && (Number(window.ui.hubViewWakeLockReleaseCount) || 0) >= releaseCountBefore + 1,
        calls,
        releases: releases.length,
        acquireCountBefore,
        acquireCountAfter: Number(window.ui.hubViewWakeLockAcquireCount) || 0,
        releaseCountBefore,
        releaseCountAfter: Number(window.ui.hubViewWakeLockReleaseCount) || 0,
        active: !!window.ui.hubViewWakeLockActive,
        supported: !!window.ui.hubViewWakeLockSupported,
        lastReason: window.ui.hubViewWakeLockLastReason,
        lastError: window.ui.hubViewWakeLockLastError,
      };
    })()`);
    result.wakeLock = wakeLockResult;
    result.ok = !!(result.ok && wakeLockResult && wakeLockResult.ok);

    const desktopAfter = await hub.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 30; i++) {
        const modal = document.getElementById('meeting-create-modal');
        const create = document.querySelector('.mcm-create');
        if (create && modal && modal.style.display !== 'none') {
          return {
            modalOpen: true,
            title: document.getElementById('mcm-title-text')?.textContent || '',
            createText: create.textContent.trim(),
            body: document.body.innerText.slice(0, 500),
          };
        }
        await wait(300);
      }
      return { modalOpen: false, body: document.body.innerText.slice(0, 500) };
    })()`);
    result.desktopAfter = desktopAfter;
    result.ok = !!(result.ok && desktopAfter && desktopAfter.modalOpen);

    if (result.ok && DESKTOP_VIEWPORT) {
      const fsButton = await pwa.eval(`(() => {
        const btn = document.getElementById('hub-view-fullscreen');
        if (!btn) return { ok: false, reason: 'fullscreen button missing' };
        const r = btn.getBoundingClientRect();
        const style = getComputedStyle(btn);
        return {
          ok: r.width > 20 && r.height > 20 && style.display !== 'none' && style.visibility !== 'hidden',
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          text: (btn.textContent || '').trim(),
          display: style.display,
          visibility: style.visibility,
        };
      })()`);
      let desktopFullscreen = { ok: false, fsButton };
      if (fsButton && fsButton.ok) {
        const x = fsButton.left + fsButton.width / 2;
        const y = fsButton.top + fsButton.height / 2;
        await pwa.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await pwa.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await pwa.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(900);
        const entered = await pwa.eval(`(() => {
          const overlay = document.getElementById('hub-view-overlay');
          const btn = document.getElementById('hub-view-fullscreen');
          const keyBtn = document.getElementById('hub-view-key');
          const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
          return {
            active: !!(overlay && fsEl === overlay),
            buttonText: (btn && btn.textContent || '').trim(),
            buttonOn: !!(btn && btn.classList.contains('hv-mode-on')),
            keyboardApiPresent: !!(navigator.keyboard && typeof navigator.keyboard.lock === 'function'),
            keyboardLockActive: !!(window.ui && window.ui.hubViewKeyboardLockActive),
            keyboardLockReason: window.ui && window.ui.hubViewKeyboardLockReason || null,
            keyText: (keyBtn && keyBtn.textContent || '').trim(),
            keyLockClass: !!(keyBtn && keyBtn.classList.contains('hv-key-lock-on')),
            overlayLockClass: !!(overlay && overlay.classList.contains('hv-keyboard-lock-active')),
            status: document.getElementById('hub-view-status')?.textContent || '',
          };
        })()`);
        await pwa.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await pwa.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await pwa.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(900);
        const exited = await pwa.eval(`(() => {
          const overlay = document.getElementById('hub-view-overlay');
          const btn = document.getElementById('hub-view-fullscreen');
          const keyBtn = document.getElementById('hub-view-key');
          const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
          return {
            active: !!(overlay && fsEl === overlay),
            buttonText: (btn && btn.textContent || '').trim(),
            buttonOn: !!(btn && btn.classList.contains('hv-mode-on')),
            keyboardLockActive: !!(window.ui && window.ui.hubViewKeyboardLockActive),
            keyText: (keyBtn && keyBtn.textContent || '').trim(),
            keyLockClass: !!(keyBtn && keyBtn.classList.contains('hv-key-lock-on')),
            overlayLockClass: !!(overlay && overlay.classList.contains('hv-keyboard-lock-active')),
            status: document.getElementById('hub-view-status')?.textContent || '',
          };
        })()`);
        desktopFullscreen = {
          ok: entered
            && entered.active === true
            && entered.buttonOn === true
            && (!entered.keyboardApiPresent || (entered.keyboardLockActive === true && entered.keyText === 'K*' && entered.keyLockClass === true && entered.overlayLockClass === true))
            && exited
            && exited.active === false
            && exited.buttonOn === false
            && exited.keyboardLockActive === false
            && exited.keyText === 'K'
            && exited.keyLockClass === false
            && exited.overlayLockClass === false,
          fsButton,
          entered,
          exited,
        };
      }
      result.desktopFullscreen = desktopFullscreen;
      result.ok = !!(result.ok && desktopFullscreen && desktopFullscreen.ok);
    }

    const textMarker = 'REMOTE_TEXT_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    let textResult = null;
    if (result.ok) {
      const titleTarget = await hub.eval(`(() => {
        const el = document.getElementById('mcm-title-input');
        if (!el) return { ok: false, reason: 'title input missing' };
        const r = el.getBoundingClientRect();
        return {
          ok: true,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          width: r.width,
          height: r.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      })()`);
      textResult = await pwa.eval(`(async () => {
        const target = ${JSON.stringify(titleTarget)};
        const marker = ${JSON.stringify(textMarker)};
        const wait = ms => new Promise(r => setTimeout(r, ms));
        if (!target || !target.ok) return { ok: false, reason: 'bad title target', target };
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const rect = img.getBoundingClientRect();
        const clientX = rect.left + (target.x / target.viewportWidth) * rect.width;
        const clientY = rect.top + (target.y / target.viewportHeight) * rect.height;
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const clickAckPromise = waitAck();
        img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
        const focusAck = await clickAckPromise;
        await wait(400);
        const textAckPromise = waitAck();
        const textRequestId = window.ui.sendHubViewText(marker);
        const textAck = await textAckPromise;
        await wait(800);
        return { ok: !!textRequestId && focusAck && focusAck.ok === true && textAck && textAck.ok === true, marker, target, focusAck, textAck };
      })()`);
      const desktopTextAfter = await hub.eval(`(() => {
        const el = document.getElementById('mcm-title-input');
        const modal = document.getElementById('meeting-create-modal');
        return {
          value: el ? el.value : null,
          modalOpen: !!(modal && modal.style.display !== 'none'),
        };
      })()`);
      result.textInput = textResult;
      result.desktopTextAfter = desktopTextAfter;
      result.ok = !!(result.ok && textResult && textResult.ok && desktopTextAfter && desktopTextAfter.value === textMarker);
    }

    let physicalKeyboardResult = null;
    if (result.ok) {
      physicalKeyboardResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const overlay = document.getElementById('hub-view-overlay');
        if (!overlay) return { ok: false, reason: 'hub view overlay missing' };
        const keyBtn = document.getElementById('hub-view-key');
        if (!keyBtn) return { ok: false, reason: 'keyboard capture button missing' };
        overlay.focus();
        const ackPromise = waitAck();
        overlay.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Z', code: 'KeyZ' }));
        const ack = await ackPromise;
        await wait(800);
        const defaultOn = window.ui.hubViewKeyboardCapture !== false
          && keyBtn.classList.contains('hv-mode-on')
          && (keyBtn.textContent || '').trim() === 'K';
        keyBtn.click();
        await wait(200);
        const offState = {
          capture: window.ui.hubViewKeyboardCapture,
          buttonOn: keyBtn.classList.contains('hv-mode-on'),
          text: (keyBtn.textContent || '').trim(),
          overlayOff: overlay.classList.contains('hv-keyboard-capture-off'),
        };
        let offAck = null;
        const offHandler = (e) => { offAck = e.detail || {}; };
        window.ui.client.addEventListener('hub-view-input-ack', offHandler);
        overlay.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Q', code: 'KeyQ' }));
        await wait(900);
        window.ui.client.removeEventListener('hub-view-input-ack', offHandler);
        keyBtn.click();
        await wait(200);
        const onState = {
          capture: window.ui.hubViewKeyboardCapture,
          buttonOn: keyBtn.classList.contains('hv-mode-on'),
          text: (keyBtn.textContent || '').trim(),
          overlayOff: overlay.classList.contains('hv-keyboard-capture-off'),
        };
        const resumedAckPromise = waitAck();
        overlay.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'R', code: 'KeyR' }));
        const resumedAck = await resumedAckPromise;
        await wait(800);
        const parseCases = [
          ['F24', 'F24'],
          ['PgDn', 'PageDown'],
          ['Page Down', 'PageDown'],
          ['NumpadEnter', 'NumpadEnter'],
          ['Numpad5', 'Numpad5'],
          ['PrtSc', 'PrintScreen'],
          ['Scroll Lock', 'ScrollLock'],
          ['Ctrl+PgUp', 'PageUp', ['control']],
        ];
        const parsedKeys = parseCases.map(([raw, expectedKeyCode, expectedModifiers]) => {
          const parsed = window.ui._parseHubViewKey(raw);
          const expected = expectedModifiers || [];
          return {
            raw,
            ok: !!parsed
              && parsed.keyCode === expectedKeyCode
              && JSON.stringify(parsed.modifiers || []) === JSON.stringify(expected),
            parsed,
          };
        });
        const parityAckPromise = waitAck();
        const parityRequestId = window.ui.sendHubViewKey('PgDn');
        const parityAck = await parityAckPromise;
        await wait(400);
        return {
          ok: ack && ack.ok === true
            && defaultOn
            && offState.capture === false
            && offState.buttonOn === false
            && offState.text === 'K0'
            && offState.overlayOff === true
            && offAck === null
            && onState.capture === true
            && onState.buttonOn === true
            && onState.text === 'K'
            && onState.overlayOff === false
            && resumedAck && resumedAck.ok === true
            && parsedKeys.every(x => x.ok)
            && !!parityRequestId
            && parityAck && parityAck.ok === true
            && parityAck.result && parityAck.result.keyCode === 'PageDown',
          ack,
          defaultOn,
          offState,
          offAck,
          onState,
          resumedAck,
          parsedKeys,
          parityRequestId,
          parityAck,
        };
      })()`);
      const desktopKeyboardAfter = await hub.eval(`(() => {
        const el = document.getElementById('mcm-title-input');
        return { value: el ? el.value : null };
      })()`);
      result.physicalKeyboard = physicalKeyboardResult;
      result.desktopKeyboardAfter = desktopKeyboardAfter;
      result.ok = !!(result.ok && physicalKeyboardResult && physicalKeyboardResult.ok && desktopKeyboardAfter && desktopKeyboardAfter.value === textMarker + 'ZR');
    }

    let clipboardResult = null;
    if (result.ok) {
      clipboardResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const selectAckP = waitAck();
        const selectRequestId = window.ui.sendHubViewKey('Ctrl+A');
        const selectAck = await selectAckP;
        await wait(800);
        const clipAckP = waitAck();
        const clipRequestId = window.ui.readHubViewClipboard();
        const clipAck = await clipAckP;
        await wait(800);
        return {
          ok: !!selectRequestId && selectAck && selectAck.ok === true && !!clipRequestId && clipAck && clipAck.ok === true,
          selectAck,
          clipAck,
          clipboardText: clipAck && clipAck.result && clipAck.result.text || '',
        };
      })()`);
      result.clipboard = clipboardResult;
      result.ok = !!(result.ok && clipboardResult && clipboardResult.ok && clipboardResult.clipboardText === textMarker + 'ZR');
    }

    let clipboardWriteResult = null;
    if (result.ok) {
      const writeMarker = 'PWA_CLIPBOARD_WRITE_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      clipboardWriteResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const marker = ${JSON.stringify(writeMarker)};
        const waitWriteAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'clipboard-write') return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const waitReadAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'clipboard-read') return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const ackP = waitWriteAck();
        const requestId = window.ui.writeHubViewClipboard(marker);
        const ack = await ackP;
        await wait(400);
        const readAckP = waitReadAck();
        const readRequestId = window.ui.client.sendHubViewInput({
          kind: 'clipboard-read',
          copy: false,
          restore: false,
        }, window.ui.activeHubId);
        const readAck = await readAckP;
        return {
          ok: !!requestId && ack && ack.ok === true && ack.result && ack.result.kind === 'clipboard-write'
            && !!readRequestId && readAck && readAck.ok === true
            && readAck.result && readAck.result.text === marker,
          marker,
          requestId,
          ack,
          readRequestId,
          readAck,
        };
      })()`);
      result.clipboardWrite = clipboardWriteResult;
      result.ok = !!(result.ok && clipboardWriteResult && clipboardWriteResult.ok);
    }

    let pasteBridgeResult = null;
    if (result.ok) {
      const pasteMarker = 'PWA_PASTE_BRIDGE_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      pasteBridgeResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const marker = ${JSON.stringify(pasteMarker)};
        const waitKind = (kind, timeoutMs = 15000) => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, timeoutMs);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== kind) return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const overlay = document.getElementById('hub-view-overlay');
        if (!overlay) return { ok: false, reason: 'hub view overlay missing' };
        overlay.focus();
        const selectAckP = waitKind('key-press');
        const selectRequestId = window.ui.sendHubViewKey('Ctrl+A');
        const selectAck = await selectAckP;
        await wait(250);
        const writeAckP = waitKind('clipboard-write');
        const pasteAckP = waitKind('key-press');
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
          value: { getData: (type) => type === 'text/plain' ? marker : '' },
        });
        const dispatched = overlay.dispatchEvent(event);
        const writeAck = await writeAckP;
        const pasteAck = await pasteAckP;
        await wait(900);
        const prepAckP = waitKind('key-press');
        const prepRequestId = window.ui.sendHubViewKey('Ctrl+A');
        const prepAck = await prepAckP;
        return {
          ok: !!selectRequestId && selectAck && selectAck.ok === true
            && dispatched === false
            && writeAck && writeAck.ok === true && writeAck.result && writeAck.result.kind === 'clipboard-write'
            && pasteAck && pasteAck.ok === true && pasteAck.result && pasteAck.result.kind === 'key-press'
            && !!prepRequestId && prepAck && prepAck.ok === true,
          marker,
          selectRequestId,
          selectAck,
          dispatched,
          writeAck,
          pasteAck,
          prepRequestId,
          prepAck,
        };
      })()`);
      const desktopPasteAfter = await hub.eval(`(() => {
        const el = document.getElementById('mcm-title-input');
        return { value: el ? el.value : null };
      })()`);
      result.pasteBridge = pasteBridgeResult;
      result.desktopPasteAfter = desktopPasteAfter;
      result.ok = !!(result.ok && pasteBridgeResult && pasteBridgeResult.ok && desktopPasteAfter && desktopPasteAfter.value === pasteMarker);
    }

    let fileTransferResult = null;
    if (result.ok) {
      const fileMarker = 'PWA_FILE_TRANSFER_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      fileTransferResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const marker = ${JSON.stringify(fileMarker)};
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 20000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const file = new File([marker + '\\n'], 'hub-view-e2e-upload.txt', { type: 'text/plain' });
        const ackP = waitAck();
        const requestId = await window.ui.sendHubViewFile(file);
        const ack = await ackP;
        await wait(1000);
        return {
          ok: !!requestId && ack && ack.ok === true && ack.result && ack.result.kind === 'file-transfer',
          marker,
          requestId,
          ack,
        };
      })()`);
      const uploadedPath = fileTransferResult && fileTransferResult.ack && fileTransferResult.ack.result && fileTransferResult.ack.result.path;
      const fileExists = uploadedPath ? fs.existsSync(uploadedPath) : false;
      const fileText = fileExists ? fs.readFileSync(uploadedPath, 'utf8') : '';
      const desktopClipboardAfter = await pwa.eval(`(async () => {
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const ackP = waitAck();
        const requestId = window.ui.client.sendHubViewInput({
          kind: 'clipboard-read',
          copy: false,
          restore: false,
        }, window.ui.activeHubId);
        const ack = await ackP;
        return { requestId, ack, text: ack && ack.result && ack.result.text || '' };
      })()`);
      const desktopFilePathAfter = await hub.eval(`(() => {
        const el = document.getElementById('mcm-title-input');
        return { value: el ? el.value : null };
      })()`);
      result.fileTransfer = {
        ...fileTransferResult,
        uploadedPath,
        fileExists,
        fileText,
      };
      result.desktopClipboardAfterFile = desktopClipboardAfter;
      result.desktopFilePathAfter = desktopFilePathAfter;
      result.ok = !!(
        result.ok &&
        fileTransferResult &&
        fileTransferResult.ok &&
        uploadedPath &&
        fileExists &&
        fileText === fileTransferResult.marker + '\n' &&
        desktopClipboardAfter &&
        desktopClipboardAfter.text === uploadedPath &&
        desktopFilePathAfter &&
        uploadedPath.startsWith(desktopFilePathAfter.value || '')
      );
    }

    let dropTransferResult = null;
    if (result.ok) {
      const dropMarker = 'PWA_FILE_DROP_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      dropTransferResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const marker = ${JSON.stringify(dropMarker)};
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 20000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'file-transfer') return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const body = document.getElementById('hub-view-body');
        if (!body) return { ok: false, reason: 'hub view body missing' };
        const file = new File([marker + '\\n'], 'hub-view-e2e-drop-upload.txt', { type: 'text/plain' });
        const data = new DataTransfer();
        data.items.add(file);
        const makeEvent = (type) => {
          const ev = new DragEvent(type, { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'dataTransfer', { value: data });
          return ev;
        };
        body.dispatchEvent(makeEvent('dragenter'));
        await wait(100);
        body.dispatchEvent(makeEvent('dragover'));
        await wait(100);
        const ackP = waitAck();
        body.dispatchEvent(makeEvent('drop'));
        const ack = await ackP;
        await wait(1000);
        return {
          ok: ack && ack.ok === true && ack.result && ack.result.kind === 'file-transfer',
          marker,
          ack,
          dropActive: document.getElementById('hub-view-overlay')?.classList.contains('hv-drop-active') || false,
        };
      })()`);
      const droppedPath = dropTransferResult && dropTransferResult.ack && dropTransferResult.ack.result && dropTransferResult.ack.result.path;
      const droppedExists = droppedPath ? fs.existsSync(droppedPath) : false;
      const droppedText = droppedExists ? fs.readFileSync(droppedPath, 'utf8') : '';
      result.dropTransfer = {
        ...dropTransferResult,
        droppedPath,
        droppedExists,
        droppedText,
      };
      result.ok = !!(
        result.ok &&
        dropTransferResult &&
        dropTransferResult.ok &&
        dropTransferResult.dropActive === false &&
        droppedPath &&
        droppedExists &&
        droppedText === dropTransferResult.marker + '\n'
      );
    }

    let touchCanvasPanResult = null;
    let wheelResult = null;
    if (result.ok) {
      await hub.eval(`(() => {
        window.__hubViewWheelEvents = [];
        if (!window.__hubViewWheelListener) {
          window.__hubViewWheelListener = (e) => {
            window.__hubViewWheelEvents.push({
              deltaX: e.deltaX,
              deltaY: e.deltaY,
              ctrlKey: !!e.ctrlKey,
              shiftKey: !!e.shiftKey,
              altKey: !!e.altKey,
              metaKey: !!e.metaKey,
              clientX: e.clientX,
              clientY: e.clientY,
              targetId: e.target && e.target.id || '',
              targetClass: e.target && String(e.target.className || '').slice(0, 80) || '',
              ts: Date.now(),
            });
          };
          document.addEventListener('wheel', window.__hubViewWheelListener, true);
        }
      })()`);
      const wheelCountBeforePan = await hub.eval(`(() => ((window.__hubViewWheelEvents || []).length))()`);
      touchCanvasPanResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        const body = document.getElementById('hub-view-body');
        if (!img || !body || !window.ui || !window.ui.lastHubViewFrame) {
          return { ok: false, reason: 'hub view image/body missing' };
        }
        const zoomBtn = document.getElementById('hub-view-zoom');
        if (!window.ui.hubViewActualSize && zoomBtn) {
          zoomBtn.click();
          await wait(250);
        }
        if (!window.ui.hubViewActualSize) return { ok: false, reason: 'actual size unavailable' };
        const maxLeft = Math.max(0, body.scrollWidth - body.clientWidth);
        const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
        const beforeLeft = Math.min(120, Math.max(0, maxLeft - 160));
        body.scrollLeft = beforeLeft;
        body.scrollTop = Math.min(80, Math.max(0, maxTop - 120));
        await wait(80);
        const rect = img.getBoundingClientRect();
        const baseY = Math.max(rect.top + 80, Math.min(rect.bottom - 80, rect.top + rect.height * 0.45));
        const makeTouch = (identifier, x, y) => {
          const init = {
            identifier,
            target: img,
            clientX: x,
            clientY: y,
            pageX: x + window.scrollX,
            pageY: y + window.scrollY,
            screenX: x,
            screenY: y,
          };
          return typeof Touch === 'function' ? new Touch(init) : init;
        };
        const start1 = makeTouch(11, Math.min(rect.right - 80, rect.left + 260), baseY - 26);
        const start2 = makeTouch(12, Math.min(rect.right - 30, rect.left + 330), baseY + 26);
        const move1 = makeTouch(11, Math.max(rect.left + 30, start1.clientX - 130), baseY - 26);
        const move2 = makeTouch(12, Math.max(rect.left + 80, start2.clientX - 130), baseY + 26);
        img.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [start1, start2],
          targetTouches: [start1, start2],
          changedTouches: [start1, start2],
        }));
        await wait(40);
        img.dispatchEvent(new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [move1, move2],
          targetTouches: [move1, move2],
          changedTouches: [move1, move2],
        }));
        await wait(120);
        img.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [move1, move2],
        }));
        await wait(350);
        const afterLeft = body.scrollLeft;
        const afterPanStatus = document.getElementById('hub-view-status')?.textContent || '';
        const beforePinchScale = Number(window.ui.hubViewZoomScale) || 0;
        const beforePinchWidth = img.getBoundingClientRect().width;
        const beforePinchCount = Number(window.ui.hubViewPinchZoomCount) || 0;
        const beforePinchHoldCount = Number(window.ui.hubViewPinchFrameHoldCount) || 0;
        const pinchY = Math.max(rect.top + 120, Math.min(rect.bottom - 120, rect.top + rect.height * 0.5));
        const pinchStart1 = makeTouch(21, Math.max(rect.left + 80, rect.left + rect.width * 0.45), pinchY - 32);
        const pinchStart2 = makeTouch(22, Math.min(rect.right - 80, rect.left + rect.width * 0.45 + 74), pinchY + 32);
        const pinchMove1 = makeTouch(21, Math.max(rect.left + 30, pinchStart1.clientX - 68), pinchY - 66);
        const pinchMove2 = makeTouch(22, Math.min(rect.right - 30, pinchStart2.clientX + 68), pinchY + 66);
        img.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [pinchStart1, pinchStart2],
          targetTouches: [pinchStart1, pinchStart2],
          changedTouches: [pinchStart1, pinchStart2],
        }));
        await wait(40);
        img.dispatchEvent(new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [pinchMove1, pinchMove2],
          targetTouches: [pinchMove1, pinchMove2],
          changedTouches: [pinchMove1, pinchMove2],
        }));
        await wait(180);
        img.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [pinchMove1, pinchMove2],
        }));
        await wait(420);
        img = document.getElementById('hub-view-image');
        const afterPinchScale = Number(window.ui.hubViewZoomScale) || 0;
        const afterPinchWidth = img ? img.getBoundingClientRect().width : 0;
        const afterPinchCount = Number(window.ui.hubViewPinchZoomCount) || 0;
        const pinchLastScale = Number(window.ui.hubViewPinchZoomLastScale) || 0;
        const afterPinchHoldCount = Number(window.ui.hubViewPinchFrameHoldCount) || 0;
        const pinchHoldUntil = Number(window.ui.hubViewPinchFrameHoldUntil) || 0;
        const frameHoldUntil = Number(window.ui._hubViewFrameHoldUntil) || 0;
        const nowAfterPinch = Date.now();
        const zoomBtnAfterPinch = document.getElementById('hub-view-zoom');
        if (zoomBtnAfterPinch) {
          zoomBtnAfterPinch.click();
          await wait(300);
        }
        img = document.getElementById('hub-view-image');
        const afterResetScale = Number(window.ui.hubViewZoomScale) || 0;
        const afterResetActualSize = !!window.ui.hubViewActualSize;
        const afterResetWidth = img ? img.getBoundingClientRect().width : 0;
        const afterResetLabel = zoomBtnAfterPinch ? (zoomBtnAfterPinch.textContent || '').trim() : '';
        if (zoomBtnAfterPinch) {
          zoomBtnAfterPinch.click();
          await wait(180);
          zoomBtnAfterPinch.click();
          await wait(260);
        }
        img = document.getElementById('hub-view-image');
        const bodyRect = body.getBoundingClientRect();
        const pinchInCenterX = bodyRect.left + bodyRect.width * 0.5;
        const pinchInCenterY = bodyRect.top + bodyRect.height * 0.5;
        const beforePinchInScale = Number(window.ui.hubViewZoomScale) || 0;
        const beforePinchInWidth = img ? img.getBoundingClientRect().width : 0;
        const beforePinchInCount = Number(window.ui.hubViewPinchZoomCount) || 0;
        const beforePinchInFitResetCount = Number(window.ui.hubViewPinchFitResetCount) || 0;
        const inwardStart1 = makeTouch(31, pinchInCenterX - 100, pinchInCenterY - 80);
        const inwardStart2 = makeTouch(32, pinchInCenterX + 100, pinchInCenterY + 80);
        const inwardMove1 = makeTouch(31, pinchInCenterX - 24, pinchInCenterY - 18);
        const inwardMove2 = makeTouch(32, pinchInCenterX + 24, pinchInCenterY + 18);
        img.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [inwardStart1, inwardStart2],
          targetTouches: [inwardStart1, inwardStart2],
          changedTouches: [inwardStart1, inwardStart2],
        }));
        await wait(40);
        img.dispatchEvent(new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [inwardMove1, inwardMove2],
          targetTouches: [inwardMove1, inwardMove2],
          changedTouches: [inwardMove1, inwardMove2],
        }));
        await wait(180);
        img.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [inwardMove1, inwardMove2],
        }));
        await wait(420);
        img = document.getElementById('hub-view-image');
        const afterPinchInScale = Number(window.ui.hubViewZoomScale) || 0;
        const afterPinchInActualSize = !!window.ui.hubViewActualSize;
        const afterPinchInWidth = img ? img.getBoundingClientRect().width : 0;
        const afterPinchInLabel = zoomBtnAfterPinch ? (zoomBtnAfterPinch.textContent || '').trim() : '';
        const afterPinchInCount = Number(window.ui.hubViewPinchZoomCount) || 0;
        const afterPinchInFitResetCount = Number(window.ui.hubViewPinchFitResetCount) || 0;
        const status = document.getElementById('hub-view-status')?.textContent || '';
        return {
          ok: maxLeft > 40
            && afterLeft > beforeLeft + 20
            && afterPinchScale > beforePinchScale + 0.15
            && afterPinchWidth > beforePinchWidth + 40
            && afterPinchCount > beforePinchCount
            && Math.abs(pinchLastScale - afterPinchScale) < 0.01
            && afterPinchHoldCount > beforePinchHoldCount
            && pinchHoldUntil >= nowAfterPinch
            && frameHoldUntil >= pinchHoldUntil
            && zoomBtnAfterPinch
            && afterResetScale === 0
            && afterResetActualSize === false
            && afterResetLabel === 'FIT'
            && afterResetWidth < afterPinchWidth - 40
            && beforePinchInScale >= 1.4
            && afterPinchInScale === 0
            && afterPinchInActualSize === false
            && afterPinchInLabel === 'FIT'
            && afterPinchInCount > beforePinchInCount
            && afterPinchInFitResetCount > beforePinchInFitResetCount
            && afterPinchInWidth < beforePinchInWidth - 40,
          beforeLeft,
          afterLeft,
          maxLeft,
          maxTop,
          beforePinchScale,
          afterPinchScale,
          beforePinchWidth,
          afterPinchWidth,
          beforePinchCount,
          afterPinchCount,
          pinchLastScale,
          beforePinchHoldCount,
          afterPinchHoldCount,
          pinchHoldUntil,
          frameHoldUntil,
          nowAfterPinch,
          afterResetScale,
          afterResetActualSize,
          afterResetWidth,
          afterResetLabel,
          beforePinchInScale,
          afterPinchInScale,
          beforePinchInWidth,
          afterPinchInWidth,
          beforePinchInCount,
          afterPinchInCount,
          beforePinchInFitResetCount,
          afterPinchInFitResetCount,
          afterPinchInActualSize,
          afterPinchInLabel,
          afterPanStatus,
          status,
          actualSize: !!window.ui.hubViewActualSize,
        };
      })()`);
      const wheelCountAfterPan = await hub.eval(`(() => ((window.__hubViewWheelEvents || []).length))()`);
      result.touchCanvasPan = {
        ...touchCanvasPanResult,
        wheelCountBefore: wheelCountBeforePan,
        wheelCountAfter: wheelCountAfterPan,
        desktopWheelUnchanged: wheelCountAfterPan === wheelCountBeforePan,
      };
      result.ok = !!(result.ok && touchCanvasPanResult && touchCanvasPanResult.ok && wheelCountAfterPan === wheelCountBeforePan);
    }

    if (result.ok) {
      wheelResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const rect = img.getBoundingClientRect();
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const wheelAckPromise = waitAck();
        img.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * 0.52,
          clientY: rect.top + rect.height * 0.52,
          deltaX: 0,
          deltaY: 420,
          deltaMode: 0,
          altKey: true,
          shiftKey: true,
        }));
        const wheelAck = await wheelAckPromise;
        await wait(800);
        const modifiers = wheelAck && wheelAck.result && wheelAck.result.modifiers || [];
        return { ok: wheelAck && wheelAck.ok === true && modifiers.includes('alt') && modifiers.includes('shift'), wheelAck };
      })()`);
      const desktopWheelAfter = await hub.eval(`(() => ({
        events: (window.__hubViewWheelEvents || []).slice(-5),
      }))()`);
      result.wheelInput = wheelResult;
      result.desktopWheelAfter = desktopWheelAfter;
      const lastWheel = desktopWheelAfter && desktopWheelAfter.events && desktopWheelAfter.events[desktopWheelAfter.events.length - 1];
      result.ok = !!(result.ok && wheelResult && wheelResult.ok && lastWheel && Math.abs(Number(lastWheel.deltaY) || 0) > 0 && lastWheel.altKey === true && lastWheel.shiftKey === true);
    }

    let dragResult = null;
    if (result.ok) {
      await hub.eval(`(() => {
        window.__hubViewMouseEvents = [];
        if (!window.__hubViewMouseListener) {
          window.__hubViewMouseListener = (e) => {
            window.__hubViewMouseEvents.push({
              type: e.type,
              clientX: e.clientX,
              clientY: e.clientY,
              button: e.button,
              buttons: e.buttons,
              ctrlKey: !!e.ctrlKey,
              shiftKey: !!e.shiftKey,
              altKey: !!e.altKey,
              metaKey: !!e.metaKey,
              targetId: e.target && e.target.id || '',
              targetClass: e.target && String(e.target.className || '').slice(0, 80) || '',
              detail: e.detail,
              ts: Date.now(),
            });
          };
          for (const type of ['mousedown', 'mousemove', 'mouseup', 'contextmenu', 'dblclick']) {
            document.addEventListener(type, window.__hubViewMouseListener, true);
          }
        }
      })()`);
    }

    let mouseCanvasPanResult = null;
    if (result.ok) {
      const mouseCountBeforePan = await hub.eval(`(() => ((window.__hubViewMouseEvents || []).length))()`);
      mouseCanvasPanResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        const body = document.getElementById('hub-view-body');
        if (!img || !body || !window.ui || !window.ui.lastHubViewFrame) {
          return { ok: false, reason: 'hub view image/body missing' };
        }
        const zoomBtn = document.getElementById('hub-view-zoom');
        if (!window.ui.hubViewActualSize && zoomBtn) {
          zoomBtn.click();
          await wait(250);
        }
        if (!window.ui.hubViewActualSize) return { ok: false, reason: 'actual size unavailable' };
        const maxLeft = Math.max(0, body.scrollWidth - body.clientWidth);
        const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
        const beforeLeft = Math.min(70, Math.max(0, maxLeft - 130));
        body.scrollLeft = beforeLeft;
        body.scrollTop = Math.min(30, Math.max(0, maxTop - 80));
        await wait(80);
        const rect = img.getBoundingClientRect();
        const y = Math.max(rect.top + 90, Math.min(rect.bottom - 60, rect.top + rect.height * 0.48));
        const sx = Math.min(rect.right - 80, rect.left + Math.max(220, rect.width * 0.36));
        const mx = Math.max(rect.left + 60, sx - 100);
        img.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 131,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: sx,
          clientY: y,
          button: 1,
          buttons: 4,
        }));
        await wait(50);
        img.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 131,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: mx,
          clientY: y,
          button: 1,
          buttons: 4,
        }));
        await wait(120);
        img.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 131,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: mx,
          clientY: y,
          button: 1,
          buttons: 0,
        }));
        await wait(150);
        const afterLeft = body.scrollLeft;
        const beforeFrameLeft = body.scrollLeft;
        const beforeCapturedAt = window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || null;
        const nextFrame = new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-frame', handler);
            resolve({ timeout: true });
          }, 4500);
          const handler = (e) => {
            const frame = e.detail || {};
            if (!frame.ok || (beforeCapturedAt && String(frame.capturedAt || '') === String(beforeCapturedAt))) return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-frame', handler);
            resolve({ ok: true, capturedAt: frame.capturedAt });
          };
          window.ui.client.addEventListener('hub-view-frame', handler);
        });
        window.ui._requestHubViewFrame({ silent: true });
        const frameResult = await nextFrame;
        await wait(120);
        const afterFrameLeft = body.scrollLeft;
        const status = document.getElementById('hub-view-status')?.textContent || '';
        return {
          ok: maxLeft > 20 && afterLeft > beforeLeft + 20 && frameResult && frameResult.ok === true && Math.abs(afterFrameLeft - beforeFrameLeft) <= 6,
          beforeLeft,
          afterLeft,
          beforeFrameLeft,
          afterFrameLeft,
          maxLeft,
          maxTop,
          status,
          actualSize: !!window.ui.hubViewActualSize,
          frameResult,
        };
      })()`);
      const mouseCountAfterPan = await hub.eval(`(() => ((window.__hubViewMouseEvents || []).length))()`);
      result.mouseCanvasPan = {
        ...mouseCanvasPanResult,
        mouseCountBefore: mouseCountBeforePan,
        mouseCountAfter: mouseCountAfterPan,
        desktopMouseUnchanged: mouseCountAfterPan === mouseCountBeforePan,
      };
      result.ok = !!(result.ok && mouseCanvasPanResult && mouseCanvasPanResult.ok && mouseCountAfterPan === mouseCountBeforePan);
    }

    let modifierClickResult = null;
    if (result.ok) {
      modifierClickResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const rect = img.getBoundingClientRect();
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'mouse-click') return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const ackP = waitAck();
        img.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * 0.46,
          clientY: rect.top + rect.height * 0.46,
          button: 0,
          ctrlKey: true,
          shiftKey: true,
        }));
        const ack = await ackP;
        await wait(500);
        const modifiers = ack && ack.result && ack.result.modifiers || [];
        return { ok: ack && ack.ok === true && modifiers.includes('control') && modifiers.includes('shift'), ack };
      })()`);
      const desktopModifierClickAfter = await hub.eval(`(() => ({
        events: (window.__hubViewMouseEvents || []).slice(-8),
      }))()`);
      result.modifierClick = modifierClickResult;
      result.desktopModifierClickAfter = desktopModifierClickAfter;
      const modifierClickEvents = desktopModifierClickAfter && desktopModifierClickAfter.events || [];
      result.ok = !!(result.ok && modifierClickResult && modifierClickResult.ok && modifierClickEvents.some(e => e.type === 'mousedown' && e.ctrlKey === true && e.shiftKey === true));
    }

    let stickyModifierClickResult = null;
    if (result.ok) {
      stickyModifierClickResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const modBtn = document.getElementById('hub-view-mod');
        if (!modBtn) return { ok: false, reason: 'modifier button missing' };
        window.ui.hubViewMouseModifierIndex = 0;
        window.ui.hubViewMouseModifiers = [];
        if (typeof window.ui._renderHubViewMouseModifiers === 'function') window.ui._renderHubViewMouseModifiers();
        modBtn.click();
        await wait(100);
        const label = (modBtn.textContent || '').trim();
        const activeBeforeClick = (window.ui.hubViewMouseModifiers || []).slice();
        const rect = img.getBoundingClientRect();
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'mouse-click') return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const ackP = waitAck();
        img.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * 0.42,
          clientY: rect.top + rect.height * 0.42,
          button: 0,
        }));
        const ack = await ackP;
        await wait(500);
        window.ui.hubViewMouseModifierIndex = 0;
        window.ui.hubViewMouseModifiers = [];
        if (typeof window.ui._renderHubViewMouseModifiers === 'function') window.ui._renderHubViewMouseModifiers();
        const modifiers = ack && ack.result && ack.result.modifiers || [];
        return { ok: ack && ack.ok === true && label === 'SFT' && activeBeforeClick.includes('shift') && modifiers.includes('shift'), ack, label, activeBeforeClick };
      })()`);
      const desktopStickyModifierClickAfter = await hub.eval(`(() => ({
        events: (window.__hubViewMouseEvents || []).slice(-8),
      }))()`);
      result.stickyModifierClick = stickyModifierClickResult;
      result.desktopStickyModifierClickAfter = desktopStickyModifierClickAfter;
      const stickyEvents = desktopStickyModifierClickAfter && desktopStickyModifierClickAfter.events || [];
      result.ok = !!(result.ok && stickyModifierClickResult && stickyModifierClickResult.ok && stickyEvents.some(e => e.type === 'mousedown' && e.shiftKey === true));
    }

    let hoverResult = null;
    if (result.ok) {
      hoverResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const rect = img.getBoundingClientRect();
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'mouse-move') return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const hoverAckP = waitAck();
        img.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 81,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: rect.left + rect.width * 0.57,
          clientY: rect.top + rect.height * 0.43,
          button: -1,
          buttons: 0,
        }));
        const hoverAck = await hoverAckP;
        await wait(500);
        return { ok: hoverAck && hoverAck.ok === true && hoverAck.result && hoverAck.result.kind === 'mouse-move', hoverAck };
      })()`);
      const desktopHoverAfter = await hub.eval(`(() => ({
        events: (window.__hubViewMouseEvents || []).slice(-8),
      }))()`);
      result.hoverInput = hoverResult;
      result.desktopHoverAfter = desktopHoverAfter;
      const hoverEvents = desktopHoverAfter && desktopHoverAfter.events || [];
      result.ok = !!(result.ok && hoverResult && hoverResult.ok && hoverEvents.some(e => e.type === 'mousemove'));
    }

    if (result.ok) {
      dragResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const dragBtn = document.getElementById('hub-view-drag');
        if (!dragBtn) return { ok: false, reason: 'drag button missing' };
        if (!window.ui.hubViewDragMode) dragBtn.click();
        const rect = img.getBoundingClientRect();
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const sx = rect.left + rect.width * 0.34;
        const sy = rect.top + rect.height * 0.34;
        const mx = rect.left + rect.width * 0.50;
        const my = rect.top + rect.height * 0.40;
        const ex = rect.left + rect.width * 0.62;
        const ey = rect.top + rect.height * 0.48;
        const downAckP = waitAck();
        img.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 91, pointerType: 'mouse', isPrimary: true, clientX: sx, clientY: sy, button: 0, buttons: 1, shiftKey: true }));
        const downAck = await downAckP;
        await wait(90);
        const moveAckP = waitAck();
        img.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 91, pointerType: 'mouse', isPrimary: true, clientX: mx, clientY: my, button: 0, buttons: 1, shiftKey: true }));
        const moveAck = await moveAckP;
        await wait(90);
        const upAckP = waitAck();
        img.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 91, pointerType: 'mouse', isPrimary: true, clientX: ex, clientY: ey, button: 0, buttons: 0, shiftKey: true }));
        const upAck = await upAckP;
        if (window.ui.hubViewDragMode) dragBtn.click();
        await wait(800);
        return { ok: downAck && downAck.ok === true && moveAck && moveAck.ok === true && upAck && upAck.ok === true, downAck, moveAck, upAck };
      })()`);
      const desktopDragAfter = await hub.eval(`(() => ({
        events: (window.__hubViewMouseEvents || []).slice(-10),
      }))()`);
      result.dragInput = dragResult;
      result.desktopDragAfter = desktopDragAfter;
      const types = new Set((desktopDragAfter && desktopDragAfter.events || []).map(e => e.type));
      const dragEvents = desktopDragAfter && desktopDragAfter.events || [];
      result.ok = !!(result.ok && dragResult && dragResult.ok && types.has('mousedown') && types.has('mousemove') && types.has('mouseup') && dragEvents.some(e => e.type === 'mousemove' && e.shiftKey === true));
    }

    if (result.ok) {
      const touchDragResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const dragBtn = document.getElementById('hub-view-drag');
        if (!dragBtn) return { ok: false, reason: 'drag button missing' };
        if (!window.ui.hubViewDragMode) dragBtn.click();
        await wait(100);
        const rect = img.getBoundingClientRect();
        const makeTouch = (identifier, clientX, clientY) => {
          const init = {
            identifier,
            target: img,
            clientX,
            clientY,
            screenX: clientX,
            screenY: clientY,
            pageX: clientX,
            pageY: clientY,
            radiusX: 8,
            radiusY: 8,
            force: 0.8,
          };
          return typeof Touch === 'function' ? new Touch(init) : init;
        };
        const waitDragAck = (phase) => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true, phase });
          }, 15000);
          const handler = (e) => {
            if (!e.detail || !e.detail.result || e.detail.result.kind !== 'mouse-drag' || e.detail.result.phase !== phase) return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const sx = rect.left + rect.width * 0.36;
        const sy = rect.top + rect.height * 0.36;
        const mx = rect.left + rect.width * 0.48;
        const my = rect.top + rect.height * 0.42;
        const ex = rect.left + rect.width * 0.58;
        const ey = rect.top + rect.height * 0.50;
        const beforeTouchDragCount = Number(window.ui.hubViewTouchDragCount) || 0;
        const startTouch = makeTouch(51, sx, sy);
        const moveTouch = makeTouch(51, mx, my);
        const endTouch = makeTouch(51, ex, ey);
        const downAckP = waitDragAck('down');
        img.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [startTouch],
          targetTouches: [startTouch],
          changedTouches: [startTouch],
        }));
        const downAck = await downAckP;
        await wait(90);
        const moveAckP = waitDragAck('move');
        img.dispatchEvent(new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [moveTouch],
          targetTouches: [moveTouch],
          changedTouches: [moveTouch],
        }));
        const moveAck = await moveAckP;
        await wait(90);
        const upAckP = waitDragAck('up');
        img.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [endTouch],
        }));
        const upAck = await upAckP;
        await wait(600);
        if (window.ui.hubViewDragMode) dragBtn.click();
        const afterTouchDragCount = Number(window.ui.hubViewTouchDragCount) || 0;
        const touchStateCleared = !window.ui._hubViewTouch;
        const status = document.getElementById('hub-view-status')?.textContent || '';
        return {
          ok: downAck && downAck.ok === true
            && moveAck && moveAck.ok === true
            && upAck && upAck.ok === true
            && afterTouchDragCount > beforeTouchDragCount
            && touchStateCleared,
          downAck,
          moveAck,
          upAck,
          beforeTouchDragCount,
          afterTouchDragCount,
          touchStateCleared,
          status,
        };
      })()`);
      const desktopTouchDragAfter = await hub.eval(`(() => ({
        events: (window.__hubViewMouseEvents || []).slice(-10),
      }))()`);
      result.touchDragInput = touchDragResult;
      result.desktopTouchDragAfter = desktopTouchDragAfter;
      const touchDragEvents = desktopTouchDragAfter && desktopTouchDragAfter.events || [];
      const touchDragTypes = new Set(touchDragEvents.map(e => e.type));
      result.ok = !!(result.ok && touchDragResult && touchDragResult.ok && touchDragTypes.has('mousedown') && touchDragTypes.has('mousemove') && touchDragTypes.has('mouseup'));
    }

    if (result.ok) {
      const clickSemanticResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const liveBtn = document.getElementById('hub-view-live');
        const wasLive = !!(window.ui && window.ui.hubViewLive);
        if (wasLive && liveBtn) {
          liveBtn.click();
          await wait(250);
        }
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const rect = img.getBoundingClientRect();
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const cx = rect.left + rect.width * 0.45;
        const cy = rect.top + rect.height * 0.45;
        const dblAckP = waitAck();
        img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: cx + 20, clientY: cy + 20, button: 0, detail: 2 }));
        const dblAck = await dblAckP;
        await wait(250);
        img = document.getElementById('hub-view-image');
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing after double click', dblAck };
        const rect2 = img.getBoundingClientRect();
        const rightAckP = waitAck();
        img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect2.left + rect2.width * 0.45, clientY: rect2.top + rect2.height * 0.45, button: 2, buttons: 2 }));
        const rightAck = await rightAckP;
        await wait(800);
        if (wasLive && liveBtn && window.ui && !window.ui.hubViewLive) liveBtn.click();
        return { ok: rightAck && rightAck.ok === true && dblAck && dblAck.ok === true, rightAck, dblAck };
      })()`);
      const desktopClickSemanticAfter = await hub.eval(`(() => ({
        events: (window.__hubViewMouseEvents || []).slice(-14),
      }))()`);
      result.clickSemantics = clickSemanticResult;
      result.desktopClickSemanticAfter = desktopClickSemanticAfter;
      const semanticEvents = desktopClickSemanticAfter && desktopClickSemanticAfter.events || [];
      const sawRight = semanticEvents.some(e => (e.type === 'mousedown' || e.type === 'mouseup' || e.type === 'contextmenu') && e.button === 2);
      const sawDouble = semanticEvents.some(e => e.type === 'dblclick' || e.detail === 2);
      result.ok = !!(result.ok && clickSemanticResult && clickSemanticResult.ok && sawRight && sawDouble);
    }

    if (result.ok) {
      const beforeTouchLongPress = await hub.eval(`(() => ((window.__hubViewMouseEvents || []).length))()`);
      const touchLongPressResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        let img = null;
        for (let i = 0; i < 40; i++) {
          img = document.getElementById('hub-view-image');
          if (img && img.naturalWidth > 200 && img.naturalHeight > 100 && window.ui && window.ui.lastHubViewFrame) break;
          await wait(250);
        }
        if (!img || !window.ui || !window.ui.lastHubViewFrame) return { ok: false, reason: 'hub view image missing' };
        const liveBtn = document.getElementById('hub-view-live');
        const wasLive = !!(window.ui && window.ui.hubViewLive);
        if (wasLive && liveBtn) {
          liveBtn.click();
          await wait(250);
        }
        const rect = img.getBoundingClientRect();
        const x = rect.left + rect.width * 0.39;
        const y = rect.top + rect.height * 0.39;
        const waitAck = (timeoutMs = 15000) => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, timeoutMs);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const touchInit = {
          identifier: 7,
          target: img,
          clientX: x,
          clientY: y,
          pageX: x + window.scrollX,
          pageY: y + window.scrollY,
          screenX: x,
          screenY: y,
        };
        const touch = typeof Touch === 'function' ? new Touch(touchInit) : touchInit;
        const rightAckP = waitAck();
        img.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch],
        }));
        const rightAck = await rightAckP;
        img.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [touch],
        }));
        await wait(40);
        const ghostAckP = waitAck(900);
        img.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
          detail: 1,
        }));
        const ghostAck = await ghostAckP;
        if (wasLive && liveBtn && window.ui && !window.ui.hubViewLive) liveBtn.click();
        return {
          ok: rightAck && rightAck.ok === true && rightAck.result
            && rightAck.result.x != null && ghostAck && ghostAck.timeout === true,
          rightAck,
          ghostAck,
        };
      })()`);
      const desktopTouchLongPressAfter = await hub.eval(`((from) => {
        const events = (window.__hubViewMouseEvents || []).slice(from);
        return { events };
      })(${JSON.stringify(beforeTouchLongPress)})`);
      result.touchLongPress = touchLongPressResult;
      result.desktopTouchLongPressAfter = desktopTouchLongPressAfter;
      const touchEvents = desktopTouchLongPressAfter && desktopTouchLongPressAfter.events || [];
      const sawTouchRight = touchEvents.some(e => (e.type === 'mousedown' || e.type === 'mouseup' || e.type === 'contextmenu') && e.button === 2);
      const sawTouchLeft = touchEvents.some(e => (e.type === 'mousedown' || e.type === 'mouseup') && e.button === 0);
      result.ok = !!(result.ok && touchLongPressResult && touchLongPressResult.ok && sawTouchRight && !sawTouchLeft);
    }

    let keyResult = null;
    if (result.ok) {
      keyResult = await pwa.eval(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const waitAck = () => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve({ timeout: true });
          }, 15000);
          const handler = (e) => {
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-input-ack', handler);
            resolve(e.detail || {});
          };
          window.ui.client.addEventListener('hub-view-input-ack', handler);
        });
        const waitFrame = (beforeCapturedAt) => new Promise(resolve => {
          const timer = setTimeout(() => {
            window.ui.client.removeEventListener('hub-view-frame', handler);
            resolve({ timeout: true });
          }, 3500);
          const handler = (e) => {
            const frame = e.detail || {};
            if (!frame.ok || (beforeCapturedAt && String(frame.capturedAt || '') === String(beforeCapturedAt))) return;
            clearTimeout(timer);
            window.ui.client.removeEventListener('hub-view-frame', handler);
            resolve({ ok: true, frame, elapsedMs: performance.now() - startedAt });
          };
          const startedAt = performance.now();
          window.ui.client.addEventListener('hub-view-frame', handler);
        });
        const liveBtn = document.getElementById('hub-view-live');
        const wasLive = !!(window.ui && window.ui.hubViewLive);
        if (wasLive && liveBtn) {
          liveBtn.click();
          await wait(250);
        }
        const beforeCapturedAt = window.ui && window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || null;
        const ackPromise = waitAck();
        const framePromise = waitFrame(beforeCapturedAt);
        const requestId = window.ui.sendHubViewKey('Escape');
        const ack = await ackPromise;
        const frameAck = await framePromise;
        await wait(300);
        if (wasLive && liveBtn && window.ui && !window.ui.hubViewLive) liveBtn.click();
        return {
          ok: !!requestId && ack && ack.ok === true && frameAck && frameAck.ok === true && frameAck.elapsedMs <= 2500,
          requestId,
          ack,
          frameAck,
          beforeCapturedAt,
          afterCapturedAt: window.ui && window.ui.lastHubViewFrame && window.ui.lastHubViewFrame.capturedAt || null,
        };
      })()`);
      const desktopKeyAfter = await hub.eval(`(() => {
        const modal = document.getElementById('meeting-create-modal');
        return { modalOpen: !!(modal && modal.style.display !== 'none') };
      })()`);
      result.keyInput = keyResult;
      result.desktopKeyAfter = desktopKeyAfter;
      result.ok = !!(result.ok && keyResult && keyResult.ok && desktopKeyAfter && desktopKeyAfter.modalOpen === false);
    }

    await sleep(700);
    await pwa.screenshot(SCREENSHOT);
    try { await hub.eval(`document.querySelector('.mcm-close')?.click()`); } catch {}
    console.log(JSON.stringify({ ok: !!(result && result.ok), screenshot: SCREENSHOT, result }, null, 2));
    process.exitCode = result && result.ok ? 0 : 1;
  } finally {
    try { if (pwa) pwa.close(); } catch {}
    try { if (hub) hub.close(); } catch {}
    if (chrome && chrome.pid) {
      spawnSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
