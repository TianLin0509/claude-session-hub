'use strict';
// VPN 流量弹层 E2E：起隔离 Hub（连本机真实 Clash Verge），用真实鼠标事件点底部状态条的
// VPN 行，确认弹层打开、今天的流量被真实记录、切到「近 7 天」能看到历史日文件，Esc 关闭。
//   node tests/e2e-vpn-traffic-panel-cdp.js
// 需要本机 Clash Verge 在运行（mixed-port 7890）；读不到 Clash 时测试会如实失败。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');
const { emptyDay, localDateKey } = require('../core/vpn-traffic-recorder.js');

const ROOT = path.join(os.tmpdir(), `hub-vpn-traffic-${Date.now()}-${process.pid}`);
const DATA = path.join(ROOT, 'hub-data');
const WS = path.join(ROOT, 'workspaces');
const ARTIFACT = path.join(__dirname, '..', 'output', 'playwright', 'vpn-traffic');
const PROXY = process.env.HUB_TEST_PROXY || 'http://127.0.0.1:7890';

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(e => (e ? reject(e) : resolve(a.port))); });
  });
}

async function waitFor(label, fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(250);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

async function realClick(client, selector) {
  const box = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  assert.ok(box && box.w > 0 && box.h > 0, `${selector} 应可见可点`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

async function shot(client, name) {
  const file = path.join(ARTIFACT, `${name}-${Date.now()}.png`);
  const png = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
  return file;
}

function seedHistory() {
  const dir = path.join(DATA, 'traffic');
  fs.mkdirSync(dir, { recursive: true });
  const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const date = localDateKey(twoDaysAgo.getTime());
  const day = emptyDay(date);
  const GB = 1024 ** 3;
  day.proxied = { up: 3 * GB, down: 9 * GB };
  day.byApp = { 'codex.exe': { up: 0.2 * GB, down: 8 * GB }, 'claude.exe': { up: 2.8 * GB, down: 1 * GB } };
  day.byHost = { 'chatgpt.com': { up: 0.2 * GB, down: 8 * GB }, 'api.anthropic.com': { up: 2.8 * GB, down: 1 * GB } };
  day.byAppHost = { 'codex.exe\tchatgpt.com': day.byApp['codex.exe'], 'claude.exe\tapi.anthropic.com': day.byApp['claude.exe'] };
  day.recordedMs = 6 * 3600 * 1000;
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(day));
  return date;
}

function pushTrafficThroughProxy() {
  return new Promise(resolve => {
    execFile('curl', ['-s', '-o', os.devNull, '-x', PROXY, '--max-time', '15', 'https://speed.cloudflare.com/__down?bytes=2000000'],
      { windowsHide: true }, () => resolve());
  });
}

const panelState = `(() => {
  const p = document.getElementById('vpn-traffic-panel');
  if (!p) return { exists: false };
  return {
    exists: true,
    visible: !p.hidden && p.getBoundingClientRect().height > 0,
    text: (p.textContent || '').replace(/\\s+/g, ' ').trim(),
    activeTab: p.querySelector('.vpn-traffic-tab.active')?.textContent || null,
    apps: [...p.querySelectorAll('.vpn-traffic-row .vpn-traffic-name strong')].map(e => e.textContent),
    days: p.querySelectorAll('.vpn-traffic-day').length,
    filledDays: [...p.querySelectorAll('.vpn-traffic-day i')].filter(i => parseFloat(i.style.height) > 0).length,
    rect: (() => { const r = p.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })(),
    viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
  };
})()`;

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ proxy: { http: PROXY } }, null, 2), 'utf8');
  const seededDate = seedHistory();

  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA, port, label: 'vpn-traffic',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WS, CLAUDE_HUB_NO_EFFORT_MAX: '1', CLAUDE_HUB_E2E: '1' },
  });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('vpn row', () => client.eval(`!!document.querySelector('#sidebar-strip .strip-route-foreign')`));
    // 让记录器至少采到两轮，并真实产生一些经代理的流量。
    await pushTrafficThroughProxy();

    await realClick(client, '#sidebar-strip .strip-route-foreign');
    const opened = await waitFor('panel opens', async () => {
      const s = await client.eval(panelState);
      return s.visible && /VPN 流量/.test(s.text) ? s : null;
    }, 15000);
    assert.equal(opened.activeTab, '今天');
    assert.ok(opened.rect.top >= 0 && opened.rect.bottom <= opened.viewport.h && opened.rect.right <= opened.viewport.w, '弹层必须完整在窗口内');

    const today = await waitFor('today traffic recorded', async () => {
      const s = await client.eval(panelState);
      return s.apps.length > 0 && !/还没有经过 VPN/.test(s.text) ? s : null;
    }, 45000);
    console.log(`今天 · 程序排行: ${today.apps.join(' / ')}`);
    assert.match(today.text, /按程序/);
    assert.match(today.text, /只有 Hub 开着时才记录/);
    const todayShot = await shot(client, 'vpn-traffic-today');

    await realClick(client, '#vpn-traffic-panel [data-vpn-range="7d"]');
    const week = await waitFor('7d view', async () => {
      const s = await client.eval(panelState);
      return s.activeTab === '近 7 天' && s.days === 7 ? s : null;
    }, 10000);
    console.log(`近 7 天 · 程序排行: ${week.apps.join(' / ')}`);
    assert.ok(week.apps.includes('Codex') && week.apps.includes('Claude Code'), '历史日文件中的程序应出现在 7 天视图');
    assert.ok(week.filledDays >= 1, '每天柱状图应至少有一根非零柱');
    assert.match(week.text, /GB/);
    const weekShot = await shot(client, 'vpn-traffic-7d');

    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor('panel closes on Escape', async () => !(await client.eval(panelState)).visible, 5000);

    const todayFile = path.join(DATA, 'traffic', `${localDateKey(Date.now())}.json`);
    await waitFor('today file persisted', () => fs.existsSync(todayFile), 70000);
    assert.ok(fs.existsSync(path.join(DATA, 'traffic', `${seededDate}.json`)));

    console.log(`\n截图: ${todayShot}\n截图: ${weekShot}`);
    console.log('✅ VPN 流量弹层：真实点击打开、今天有真实记录、7 天视图读到历史、Esc 关闭');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    const resolved = path.resolve(ROOT);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('hub-vpn-traffic-')) throw new Error('unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('E2E FAILED:', e && e.message); process.exitCode = 1; });
