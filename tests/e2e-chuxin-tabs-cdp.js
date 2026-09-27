'use strict';

// 隔离实例验证（2026-09-27 方案 D）：投研面板只有左侧一列 tab（带计数），打开投研时 session 列表临时折叠、
// 离开时恢复且不改你的偏好；初心页面内跳转时 tab 高亮跟随。只用临时数据目录与独立 CDP 端口，不碰生产 Hub。
// 指向隔离初心：CHUXIN_E2E_API_BASE=http://127.0.0.1:13044 CHUXIN_E2E_WEB_BASE=http://127.0.0.1:13043
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
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `chuxin-tabs-${STAMP}`);
const TEMP_ROOT = path.join(os.tmpdir(), `chuxin-tabs-e2e-${process.pid}-${STAMP}`);

function freePort(start = 25161) {
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
      label: 'chuxin-tabs',
      extraEnv: { CLAUDE_HUB_E2E: '1', CHUXIN_API_BASE: API_BASE, CHUXIN_WEB_BASE: WEB_BASE },
    });
    client = await connectFirstPage(hub, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    // 用真实窗口尺寸，不用设备模拟：模拟尺寸传不到跨源 iframe，初心会按过期的宽度排版，截图失真
    try {
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', { windowId, bounds: { width: 1600, height: 1000, windowState: 'normal' } });
    } catch {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
    }
    await waitEval(client, 'document.getElementById("btn-research") && document.querySelector(".cx-status")', 'research entry');
    await _waitMs(1500);
    const before = await client.eval(`({
      collapsed: document.querySelector('.app-container').classList.contains('sidebar-collapsed'),
      pref: localStorage.getItem('claude-hub-sidebar-collapsed'),
    })`);
    await screenshot(client, '00-before-research.png');
    await client.eval(`(() => {
      window.__tabsErrors = [];
      window.addEventListener('error', (event) => window.__tabsErrors.push(String(event.error || event.message)));
      document.getElementById('btn-research').click();
    })()`);
    await waitEval(client, 'document.querySelector("#chuxin-panel.cx-online")', 'online research panel');
    // iframe 在状态查询回来之前按默认地址建好；指向隔离实例时重新导航一次（程序化点击走 switchTab）
    await client.eval(`document.querySelector('.cx-primary-tab[data-tab="today"]').click()`);
    await waitEval(client, `document.querySelector('.cx-view-frame iframe').src.startsWith(${JSON.stringify(WEB_BASE)})`, 'frame on configured web base');

    // 1) 打开投研：session 列表折叠，偏好没被改写
    const opened = await client.eval(`({
      collapsed: document.querySelector('.app-container').classList.contains('sidebar-collapsed'),
      pref: localStorage.getItem('claude-hub-sidebar-collapsed'),
      tabs: [...document.querySelectorAll('.cx-primary-tab .cx-tab-label')].map((n) => n.textContent),
      navVisible: getComputedStyle(document.querySelector('.cx-primary-nav')).display !== 'none',
      src: document.querySelector('.cx-view-frame iframe').src,
    })`);
    console.log('opened', JSON.stringify(opened));
    assert.strictEqual(opened.collapsed, true, '打开投研时 session 列表应当折叠');
    assert.strictEqual(opened.pref, before.pref, '临时折叠不能改写你的折叠偏好');
    assert.deepStrictEqual(opened.tabs, ['今日概况', '实时行情', '技术雷达', '消息雷达', '观察池', '持仓信息', '知识库', '作手林铛']);
    assert(opened.navVisible, '左侧 tab 列应当可见');
    assert(!opened.src.includes('nav=inner'), 'iframe 不应再带 nav=inner');

    // 2) tab 计数：技术候选、知识库、林铛仓位
    await waitEval(client, `document.querySelector('.cx-primary-tab[data-tab="technical"] .cx-tab-badge').textContent.trim() !== ''`, 'technical badge', 30000);
    const badges = await client.eval(`Object.fromEntries([...document.querySelectorAll('.cx-primary-tab')].map((b) => [b.dataset.tab, b.querySelector('.cx-tab-badge').textContent]))`);
    console.log('badges', JSON.stringify(badges));
    assert(/^\d+$/.test(badges.technical) && /^\d+$/.test(badges.notes), '技术雷达和知识库应当有计数');
    await _waitMs(2500);
    await screenshot(client, '01-today.png');

    // 3) 切到知识库与作手林铛
    await client.eval(`document.querySelector('.cx-primary-tab[data-tab="notes"]').click()`);
    await waitEval(client, `document.querySelector('.cx-view-frame iframe').src.endsWith('#notes')`, 'notes route');
    assert.strictEqual(await client.eval(`document.querySelector('.cx-primary-tab.active')?.dataset.tab`), 'notes', '点哪个 tab 哪个高亮');
    await _waitMs(3000);
    await screenshot(client, '02-notes.png');
    await client.eval(`document.querySelector('.cx-primary-tab[data-tab="lindang"]').click()`);
    await waitEval(client, `document.querySelector('.cx-view-frame iframe').src.endsWith('#lindang')`, 'lindang route');
    await _waitMs(3000);
    await screenshot(client, '03-lindang.png');

    // 4) 初心页面内跳转：tab 高亮跟过去
    const target = (await listCdpTargets(hub)).find((row) => (row.url || '').startsWith(WEB_BASE));
    assert(target?.webSocketDebuggerUrl, 'embedded chuxin target is missing');
    frameClient = await connectCDP(target.webSocketDebuggerUrl);
    await frameClient.send('Runtime.enable');
    await client.eval(`window.__msgs = []; window.addEventListener('message', (e) => window.__msgs.push([e.origin, JSON.stringify(e.data)]))`);
    await frameClient.eval(`location.hash = '#notes'`);
    try {
      await waitEval(client, `document.querySelector('.cx-primary-tab.active')?.dataset.tab === 'notes'`, 'tab follows in-frame navigation', 15000);
    } catch (error) {
      const debug = await client.eval(`({ msgs: window.__msgs, active: document.querySelector('.cx-primary-tab.active')?.dataset.tab })`);
      const frameState = await frameClient.eval(`({ href: location.href, view: document.body.dataset.view, embed: document.documentElement.className })`);
      error.message += `\nhub=${JSON.stringify(debug)}\nframe=${JSON.stringify(frameState)}`;
      throw error;
    }

    // 4b) 窄窗口（≤760px）：tab 列改成底部横排，不能挤在左边把内容压扁（审核发现的优先级问题）。
    //     这里只量 Hub 自己主框架的布局，用设备模拟即可（模拟只对跨源 iframe 里的内容失真）。
    await client.send('Emulation.setDeviceMetricsOverride', { width: 740, height: 900, deviceScaleFactor: 1, mobile: false });
    await _waitMs(800);
    const narrow = await client.eval(`(() => {
      const nav = document.querySelector('.cx-primary-nav').getBoundingClientRect();
      const frame = document.querySelector('.cx-view-frame').getBoundingClientRect();
      const panel = document.getElementById('chuxin-panel').getBoundingClientRect();
      const tabs = [...document.querySelectorAll('.cx-primary-tab')].map((b) => Math.round(b.getBoundingClientRect().top));
      return { navTop: Math.round(nav.top), frameBottom: Math.round(frame.bottom), frameWidth: Math.round(frame.width), panelWidth: Math.round(panel.width), sameRow: new Set(tabs).size === 1 };
    })()`);
    console.log('narrow', JSON.stringify(narrow));
    await screenshot(client, '03b-narrow.png');
    assert(narrow.navTop >= narrow.frameBottom - 1, '窄窗口时 tab 列应在内容下方');
    assert(narrow.frameWidth >= narrow.panelWidth - 2, '窄窗口时内容应占满面板宽度');
    assert(narrow.sameRow, '窄窗口时 tab 应排成一行');
    await client.send('Emulation.clearDeviceMetricsOverride');
    await _waitMs(600);
    // 5) 离开投研：session 列表恢复成你原来的样子
    await client.eval(`document.getElementById('btn-home').click()`);
    await waitEval(client, `getComputedStyle(document.getElementById('chuxin-panel')).display === 'none'`, 'research hidden');
    const after = await client.eval(`({
      collapsed: document.querySelector('.app-container').classList.contains('sidebar-collapsed'),
      pref: localStorage.getItem('claude-hub-sidebar-collapsed'),
    })`);
    console.log('after', JSON.stringify(after));
    assert.strictEqual(after.collapsed, before.collapsed, '离开投研后 session 列表应恢复原状');
    assert.strictEqual(after.pref, before.pref, '偏好保持不变');
    await screenshot(client, '04-after-leave.png');
    const errors = await client.eval('window.__tabsErrors');
    assert.deepStrictEqual(errors, [], `renderer errors: ${errors.join('; ')}`);
    console.log('screenshots', OUTPUT);
    console.log('PASS e2e-chuxin-tabs');
  } finally {
    try { await frameClient?.close(); } catch {}
    try { await client?.close(); } catch {}
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('chuxin-tabs-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
