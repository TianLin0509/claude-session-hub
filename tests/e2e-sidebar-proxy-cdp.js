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
const {
  normalizeGeoPayload,
  routeFingerprint,
  safeProxyEndpoint,
} = require('../core/network-egress-monitor.js');

const ROOT = path.join(os.tmpdir(), `hub-proxy-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');
const DATA = path.join(ROOT, 'hub-data');
const ARTIFACT = path.join(__dirname, '..', 'output', 'playwright', 'sidebar-proxy');
const LIVE = process.env.HUB_EGRESS_LIVE === '1';
const SCENARIO = process.env.HUB_EGRESS_SCENARIO || 'changed';
const PROXY = process.env.HUB_TEST_PROXY || (LIVE ? 'http://127.0.0.1:7890' : 'http://127.0.0.1:17890');
const FIXTURE = {
  foreign: SCENARIO === 'unavailable'
    ? { ok: false, errorCode: 'vpn_unavailable', error: 'VPN 出口不可用' }
    : normalizeGeoPayload({
      ip: '38.246.239.122', country_code: 'US', country: 'United States',
      region: 'California', city: 'Los Angeles', organization_name: 'Cogent Communications',
    }, 'e2e-fixture'),
  domestic: normalizeGeoPayload({
    ip: '180.158.74.254', country_code: 'CN', country: 'China',
    region: 'Shanghai', city: 'Shanghai', organization_name: 'China Telecom',
  }, 'e2e-fixture'),
};

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

  if (!LIVE && SCENARIO === 'changed') {
    const previous = normalizeGeoPayload({
      ip: '198.51.100.8', country_code: 'US', country: 'United States',
      region: 'California', city: 'San Francisco', organization_name: 'Previous VPN',
    }, 'e2e-baseline');
    fs.writeFileSync(path.join(DATA, 'network-egress-state.json'), JSON.stringify({
      version: 1,
      acknowledgedForeign: {
        fingerprint: routeFingerprint(previous, safeProxyEndpoint(PROXY)),
        proxyEndpoint: safeProxyEndpoint(PROXY),
        route: previous,
        acknowledgedAt: Date.now() - 60000,
      },
    }, null, 2), 'utf8');
  }

  const port = await reservePort();
    const hub = await launchIsolatedHub({
      dataDir: DATA, port, label: 'proxy',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WS,
        CLAUDE_HUB_NO_EFFORT_MAX: '1',
        CLAUDE_HUB_E2E: '1',
        ...(!LIVE ? { CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify(FIXTURE) } : {}),
      },
    });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));

    const strip = await waitFor('network egress rows', async () => {
      const r = await client.eval(`(() => {
        const el = document.getElementById('sidebar-strip');
        if (!el) return null;
        const foreign = el.querySelector('.strip-route-foreign');
        const domestic = el.querySelector('.strip-route-domestic');
        return { text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
                 rows: el.querySelectorAll('.strip-route-row').length,
                 foreignText: foreign ? (foreign.textContent || '').replace(/\\s+/g, ' ').trim() : null,
                 domesticText: domestic ? (domestic.textContent || '').replace(/\\s+/g, ' ').trim() : null,
                 foreignTitle: foreign ? (foreign.getAttribute('title') || '') : null,
                 domesticTitle: domestic ? (domestic.getAttribute('title') || '') : null,
                 foreignClass: foreign ? foreign.className : null,
                 acknowledgeable: !!(foreign && foreign.dataset.egressAck === 'true'),
                 visible: getComputedStyle(el).display !== 'none' };
      })()`);
      return r && r.rows === 2 && r.foreignText && r.domesticText
        && !/检测中/.test(r.foreignText + r.domesticText) ? r : null;
    });

    console.log(`侧栏状态条 : ${strip.text}`);
    console.log(`国外模型   : ${strip.foreignText}`);
    console.log(`国产模型   : ${strip.domesticText}`);

    assert.equal(strip.visible, true, '状态条必须可见');
    assert.equal(strip.rows, 2, '左下角必须恰好两行出口');
    assert.match(strip.foreignText, /国外/);
    assert.match(strip.domesticText, /国产/);
    assert.match(strip.foreignTitle, /Claude \/ Codex.*Gemini/);
    assert.match(strip.domesticTitle, /Kimi \/ DeepSeek/);
    assert.ok(!strip.foreignText.includes('127.0.0.1'), '可见文案不得再显示本地代理端口');
    assert.ok(!strip.domesticText.includes('127.0.0.1'), '可见文案不得显示本地代理端口');

    if (!LIVE && SCENARIO === 'changed') {
      assert.match(strip.foreignText, /美国·洛杉矶/);
      assert.match(strip.foreignText, /38\.246\.239\.122/);
      assert.match(strip.domesticText, /中国·上海/);
      assert.match(strip.domesticText, /180\.158\.74\.254/);
      assert.match(strip.foreignClass, /strip-route-warning/);
      assert.equal(strip.acknowledgeable, true, '节点变化应持续显眼，直到用户确认');
    } else if (!LIVE && SCENARIO === 'unavailable') {
      assert.match(strip.foreignText, /VPN 出口不可用/);
      assert.match(strip.foreignClass, /strip-route-critical/);
      assert.equal(strip.acknowledgeable, false, '不可用告警不能被手动忽略');
      assert.match(strip.domesticText, /中国·上海/);
    } else {
      assert.match(strip.foreignText, /\d+\.\d+\.\d+\.\d+/);
      assert.match(strip.domesticText, /\d+\.\d+\.\d+\.\d+/);
    }

    const shot = path.join(ARTIFACT, `sidebar-egress-${LIVE ? 'live' : SCENARIO}-${Date.now()}.png`);
    const png = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));

    if (!LIVE && SCENARIO === 'changed') {
      await client.eval(`document.querySelector('.strip-route-foreign[data-egress-ack="true"]')?.click()`);
      await waitFor('acknowledge changed VPN node', async () => client.eval(`(() => {
        const row = document.querySelector('.strip-route-foreign');
        return !!row && !row.classList.contains('strip-route-warning') && !row.dataset.egressAck;
      })()`));
    }

    console.log(`\n截图: ${shot}`);
    console.log('✅ 侧栏双出口与 VPN 变化告警显示正确');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('E2E FAILED:', e && e.message); process.exitCode = 1; });
