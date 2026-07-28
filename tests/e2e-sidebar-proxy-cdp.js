'use strict';
// 侧栏代理行 E2E：起隔离 Hub，读侧栏状态条的实际文本 + 截图。
// 用户诉求：随时能看到当前走的是哪个代理（VPN），确认通道对不对。
//   node tests/e2e-sidebar-proxy-cdp.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-proxy-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');
const DATA = path.join(ROOT, 'hub-data');
const ARTIFACT = path.join(__dirname, '..', 'output', 'playwright', 'sidebar-proxy');
const PROXY = 'http://127.0.0.1:17890';

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
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(ARTIFACT, { recursive: true });
  // config.json 里 proxy 是嵌套结构（hub-config.js 读的是 `proxy.http`），
  // 写成扁平字符串会读不到、静默回落默认值。
  fs.writeFileSync(path.join(DATA, 'config.json'),
    JSON.stringify({ proxy: { http: PROXY } }, null, 2), 'utf8');

  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA, port, label: 'proxy',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WS, CLAUDE_HUB_NO_EFFORT_MAX: '1' },
  });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));

    const strip = await waitFor('proxy chip', async () => {
      const r = await client.eval(`(() => {
        const el = document.getElementById('sidebar-strip');
        if (!el) return null;
        const proxy = el.querySelector('.strip-proxy');
        return { text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
                 proxyText: proxy ? (proxy.textContent || '').trim() : null,
                 proxyTitle: proxy ? (proxy.getAttribute('title') || '') : null,
                 visible: getComputedStyle(el).display !== 'none' };
      })()`);
      return r && r.proxyText ? r : null;
    });

    console.log(`侧栏状态条 : ${strip.text}`);
    console.log(`代理块文本 : ${strip.proxyText}`);
    console.log(`代理块 title: ${strip.proxyTitle}`);

    assert.equal(strip.visible, true, '状态条必须可见');
    assert.ok(/代理/.test(strip.proxyText), '状态条必须有「代理」一项');
    assert.ok(strip.proxyText.includes('127.0.0.1:17890'),
      `代理块应显示配置里的出口，实际: ${strip.proxyText}`);
    assert.ok(!/直连/.test(strip.proxyText), '配了代理就不该显示直连');

    const shot = path.join(ARTIFACT, `sidebar-strip-${Date.now()}.png`);
    const png = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    console.log(`\n截图: ${shot}`);
    console.log('✅ 侧栏代理行显示正确');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('E2E FAILED:', e && e.message); process.exitCode = 1; });
