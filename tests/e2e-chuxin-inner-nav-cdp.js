'use strict';

// 隔离实例验证：初心投研接管导航后，Hub 的标题行与左侧菜单收起、iframe 铺满，
// 初心顶栏里切页会被 Hub 记住。只用临时数据目录与独立 CDP 端口，不碰生产 Hub。
// 需要一套已启动的初心（默认生产 3003/3004；建议指向隔离实例：
//   CHUXIN_E2E_API_BASE=http://127.0.0.1:13034 CHUXIN_E2E_WEB_BASE=http://127.0.0.1:13033）。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const API_BASE = process.env.CHUXIN_E2E_API_BASE || 'http://127.0.0.1:3004';
const WEB_BASE = process.env.CHUXIN_E2E_WEB_BASE || 'http://127.0.0.1:3003';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `chuxin-inner-nav-${STAMP}`);
const TEMP_ROOT = path.join(os.tmpdir(), `chuxin-inner-nav-e2e-${process.pid}-${STAMP}`);

function freePort(start = 25061) {
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
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitEval(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch { /* renderer settling */ }
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

(async () => {
  assert((await getJson(`${API_BASE}/health`))?.status === 'ok', `research API is not healthy: ${API_BASE}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const port = await freePort();
  let hub = null;
  let client = null;
  let frameClient = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'chuxin-inner-nav',
      extraEnv: { CLAUDE_HUB_E2E: '1', CHUXIN_API_BASE: API_BASE, CHUXIN_WEB_BASE: WEB_BASE },
    });
    client = await connectFirstPage(hub, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
    await waitEval(client, 'document.getElementById("btn-research") && document.querySelector(".cx-status")', 'research entry');
    await _waitMs(1500);
    await client.eval(`(() => {
      window.__innerNavErrors = [];
      window.addEventListener('error', (event) => window.__innerNavErrors.push(String(event.error || event.message)));
      document.getElementById('btn-research').click();
    })()`);
    await waitEval(client, 'document.querySelector("#chuxin-panel.cx-online")', 'online research panel');
    if (process.env.CHUXIN_E2E_EXPECT_LEGACY === '1') {
      // 指向不认 nav=inner 的旧版初心：6 秒没握手，Hub 必须把左侧菜单还回来，不能让人无路可走
      await _waitMs(7000);
      const legacy = await client.eval(`({
        nav: getComputedStyle(document.querySelector('.cx-primary-nav')).display,
        header: getComputedStyle(document.querySelector('.cx-header')).display,
        innerNav: document.getElementById('chuxin-panel').classList.contains('cx-inner-nav'),
      })`);
      console.log('legacy', JSON.stringify(legacy));
      assert.notStrictEqual(legacy.nav, 'none', '旧版初心没握手，左侧菜单应当恢复');
      assert.notStrictEqual(legacy.header, 'none', '旧版初心没握手，标题行应当恢复');
      await screenshot(client, '00-legacy-fallback.png');
      console.log('PASS e2e-chuxin-inner-nav (legacy fallback)');
      return;
    }
    // iframe 在状态查询回来之前就按默认地址（3003）建好了；指向隔离实例时重新导航一次。
    // 菜单虽然隐藏，按钮仍在，程序化点击走的就是 switchTab。
    await client.eval(`document.querySelector('.cx-primary-tab[data-tab="today"]').click()`);
    await waitEval(client, `document.querySelector('.cx-view-frame iframe').src.startsWith(${JSON.stringify(WEB_BASE)})`, 'frame on configured web base');

    const layout = await client.eval(`(() => {
      const panel = document.getElementById('chuxin-panel').getBoundingClientRect();
      const frame = document.querySelector('.cx-view-frame iframe');
      const rect = frame.getBoundingClientRect();
      return {
        nav: getComputedStyle(document.querySelector('.cx-primary-nav')).display,
        header: getComputedStyle(document.querySelector('.cx-header')).display,
        src: frame.src,
        leftGap: Math.round(rect.left - panel.left), topGap: Math.round(rect.top - panel.top),
        frameWidth: Math.round(rect.width), panelWidth: Math.round(panel.width),
      };
    })()`);
    console.log('layout', JSON.stringify(layout));
    assert.strictEqual(layout.nav, 'none', 'Hub 左侧菜单应收起');
    assert.strictEqual(layout.header, 'none', '后端在线时 Hub 标题行应收起');
    assert(layout.src.includes('embed=hub&nav=inner'), `iframe 未带 nav=inner：${layout.src}`);
    assert(layout.leftGap <= 1 && layout.topGap <= 1, 'iframe 应贴齐面板左上角');
    assert(layout.frameWidth >= layout.panelWidth - 2, 'iframe 应铺满面板宽度');

    // 进 iframe，用初心自己的顶栏切到知识库，Hub 应记住
    await _waitMs(1500);
    const target = (await listCdpTargets(hub)).find((row) => (row.url || '').includes('nav=inner'));
    assert(target?.webSocketDebuggerUrl, 'embedded chuxin target is missing');
    frameClient = await connectCDP(target.webSocketDebuggerUrl);
    await frameClient.send('Runtime.enable');
    await waitEval(frameClient, 'getComputedStyle(document.querySelector("header.topbar")).display === "grid"', 'chuxin inner topbar');
    await frameClient.eval('document.querySelector(\'.product-nav [data-view="notes"]\').click()');
    await waitEval(frameClient, 'document.getElementById("view-title")?.textContent === "知识库"', 'knowledge view');
    await waitEval(client, 'localStorage.getItem("chuxin.hub.active-tab") === "notes"', 'Hub remembers inner navigation');
    await frameClient.eval('document.querySelector(\'.product-nav [data-product="lindang"]\').click()');
    await waitEval(client, 'localStorage.getItem("chuxin.hub.active-tab") === "lindang"', 'Hub remembers lindang');
    await _waitMs(2500);
    const shot = await screenshot(client, '01-inner-nav-lindang.png');
    const errors = await client.eval('window.__innerNavErrors');
    assert.deepStrictEqual(errors, [], `renderer errors: ${errors.join('; ')}`);
    console.log('screenshot', shot);
    console.log('PASS e2e-chuxin-inner-nav');
  } finally {
    try { await frameClient?.close(); } catch {}
    try { await client?.close(); } catch {}
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('chuxin-inner-nav-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
