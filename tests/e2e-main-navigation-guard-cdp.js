'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-main-nav-guard-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HTML_PATH = path.join(TEMP_ROOT, 'navigation-escape-probe.html');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'main-navigation-guard');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `main-shell-preserved-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 60; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitForPreview(client, expectedPath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await client.eval(`(() => {
      const panel = document.getElementById('preview-panel');
      const webview = document.querySelector('#preview-body webview');
      return {
        href: location.href,
        shellPresent: !!document.getElementById('app-container'),
        panelDisplay: panel && panel.style.display,
        previewTitle: document.getElementById('preview-title')?.textContent || '',
        previewPath: document.getElementById('preview-title')?.title || '',
        webviewSrc: webview?.getAttribute('src') || '',
        closeButtonPresent: !!document.getElementById('preview-close'),
      };
    })()`);
    lastState = state;
    if (state.shellPresent && state.panelDisplay === 'flex' && state.previewPath === expectedPath) return state;
    await _waitMs(150);
  }
  throw new Error(`preview did not open for ${expectedPath}; lastState=${JSON.stringify(lastState)}`);
}

async function waitForShell(client, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(`Boolean(document.getElementById('app-container') && window.openPathInHub)`)) return;
    } catch {}
    await _waitMs(150);
  }
  throw new Error('Hub renderer shell did not become ready');
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(HTML_PATH, '<!doctype html><meta charset="utf-8"><title>escape probe</title><h1>LOCAL HTML PREVIEW</h1>', 'utf8');

  const port = await availablePort(Number(process.env.HUB_MAIN_NAV_E2E_PORT || 19731));
  const fileUrl = pathToFileURL(HTML_PATH).href;
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port, htmlPath: HTML_PATH, screenshot: SCREENSHOT_PATH };

  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port, label: 'main-navigation-guard' });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await waitForShell(client);

    result.initialUrl = await client.eval('location.href');
    await client.eval(`location.href = ${JSON.stringify(fileUrl)}`);
    result.locationNavigation = await waitForPreview(client, HTML_PATH);
    assert.match(result.locationNavigation.href, /renderer[\\/]index\.html/i);
    assert.equal(result.locationNavigation.shellPresent, true);
    assert.equal(result.locationNavigation.closeButtonPresent, true);
    assert.equal(result.locationNavigation.previewTitle, path.basename(HTML_PATH));
    assert.equal(result.locationNavigation.webviewSrc, fileUrl);

    await client.eval(`window.open(${JSON.stringify(fileUrl)}, '_blank')`);
    result.windowOpen = await waitForPreview(client, HTML_PATH);
    assert.match(result.windowOpen.href, /renderer[\\/]index\.html/i);
    assert.equal(result.windowOpen.shellPresent, true);
    assert.equal(result.windowOpen.closeButtonPresent, true);

    await screenshot(client, SCREENSHOT_PATH);
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-80).join('\n'));
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
