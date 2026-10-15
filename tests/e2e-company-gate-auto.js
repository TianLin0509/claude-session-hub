'use strict';
// 网络放行页自动点击（2026-10-15）：真实隔离公司 Hub + 本机模拟的「公司代理」。
// 模拟服务：被拦时通道请求一律跳转到放行页；放行页上有「返回」和「继续访问」两个按钮，点「继续访问」才放行。
// 验证：开关关着不点；打开后 Hub 在看不见的窗口里点「继续访问」并恢复通道，写日志和放行页样本；
// 按钮点了也不放行时连续 3 次就停手进入冷却。不连接真实通道、不启动 AI。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { AssistantStore } = require('../core/hub-assistant/store');
const { newSecret } = require('../core/company-bridge/crypto');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

function gateServer() {
  const g = { gated: true, broken: false, clicks: 0, pageViews: 0, apiCalls: 0 };
  g.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // 像公司代理一样：被拦时收件箱网址下的任何请求（通道接口、收件箱网页）都跳到放行页。
    if (g.gated && url.pathname.startsWith('/drop/tok/')) { if (url.pathname.startsWith('/drop/tok/api/')) g.apiCalls += 1; res.writeHead(302, { Location: `http://127.0.0.1:${g.port}/gate/warn?from=relay` }); res.end(); return; }
    if (url.pathname === '/drop/tok/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<p>收件箱</p>'); return; }
    if (url.pathname.startsWith('/drop/tok/api/bridge/')) {
      g.apiCalls += 1;
      if (g.gated) { res.writeHead(302, { Location: `http://127.0.0.1:${g.port}/gate/warn?from=relay` }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'POST' ? JSON.stringify({ ok: true, seq: 1 }) : JSON.stringify({ ok: true, messages: [], seen: { home: new Date().toISOString() }, more: false, epoch: 'e1' }));
      return;
    }
    if (url.pathname === '/gate/warn') {
      g.pageViews += 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>访问提示</title><p>您访问的网站未分类，存在安全风险。</p>
        <button onclick="history.back()">返回</button>
        <button id="go" onclick="fetch('/gate/ok',{method:'POST'}).then(()=>{location.href='/gate/done'})">我已知晓风险，继续访问</button>`);
      return;
    }
    if (url.pathname === '/gate/ok' && req.method === 'POST') { g.clicks += 1; if (!g.broken) g.gated = false; res.writeHead(204); res.end(); return; }
    if (url.pathname === '/gate/done') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<p>已放行</p>'); return; }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => g.server.listen(0, '127.0.0.1', () => { g.port = g.server.address().port; resolve(g); }));
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'company-gate-auto-'));
  const out = path.resolve('artifacts/20261015-company-gate-auto-claude1', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离公司 Hub（Electron 主进程、看不见的窗口、真实网络请求）+ 本机模拟放行页；不代表公司真实代理页面', checks: [], out };
  const check = (message, extra) => { result.checks.push(extra ? { message, ...extra } : message); console.log('✓ ' + message); };
  const g = await gateServer();
  let hub, c;
  try {
    // 预置一份已配对、已解锁的公司数据（通道地址指向模拟服务），空闲检查 10 秒。
    const dataDir = path.join(testRoot, 'data');
    const store = new AssistantStore(path.join(dataDir, 'company-bridge'));
    store.set('link', { state: 'paired', baseUrl: `http://127.0.0.1:${g.port}/drop/tok/api`, secret: newSecret(), gen: 'gen-e2e', cursor: 0, epoch: null, pairedAt: Date.now() });
    store.set('settings', { pollSeconds: 10, autoGate: false });
    store.set('featureUnlock', { at: Date.now(), via: 'e2e' });
    store.close();
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'company-gate-auto', windowMode: 'background',
      ...(process.env.COMPANY_ENTRY ? { entryPath: process.env.COMPANY_ENTRY } : {}),
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(testRoot, 'home'), CLAUDE_HUB_BRIDGE_ROLE: 'company',
        CLAUDE_HUB_WIRELESS_TIMER: '0', HUB_ASSISTANT_FAST_LANE: '0', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
    c = await connectFirstPage(hub);
    const status = () => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    const invoke = (ch, payload) => c.eval(`require("electron").ipcRenderer.invoke(${JSON.stringify(ch)}, ${JSON.stringify(payload || {})})`);
    const until = async (label, read, ms = 60000) => {
      for (const end = Date.now() + ms; Date.now() < end;) { const v = await read(); if (v) return v; await wait(500); }
      throw new Error('timeout: ' + label);
    };
    const logFile = path.join(dataDir, 'logs', 'company-gate.log');
    const logLines = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

    // 1. 开关关着：识别出被拦，但不点。
    await until('company status', async () => (await status())?.role === 'company');
    await invoke('bridge:check-now');
    await until('gate detected', async () => (await status()).net?.gate, 30000);
    await wait(12000);
    await invoke('bridge:check-now');
    assert.equal(g.pageViews, 0, '开关关着不应打开放行页'); assert.equal(g.clicks, 0);
    assert.equal(logLines().length, 0);
    check('开关关着：识别出被拦（gate），不自动打开放行页');

    // 2. 打开自动放行：后台点「继续访问」，通道恢复。
    assert.equal((await invoke('bridge:set-settings', { autoGate: true })).ok, true);
    // 不点「立即检查」：靠后台定时检查自己发现被拦并放行（和公司电脑上无人值守时一样）。
    const t0 = Date.now();
    await until('gate cleared', async () => !(await status()).net.gate && g.clicks === 1, 90000);
    const lines = logLines();
    assert.deepEqual(lines.map(x => x.result), ['clicked', 'passed']);
    assert.equal(lines[0].button, '我已知晓风险，继续访问');
    assert.equal(lines[0].host, '127.0.0.1:' + g.port);
    const sample = fs.readFileSync(path.join(dataDir, 'logs', 'company-gate-sample.html'), 'utf8');
    assert.match(sample, /继续访问/);
    check('打开自动放行：后台定时检查自己发现被拦，点中「继续访问」（没点「返回」），通道恢复，写了日志和放行页样本', { seconds: Math.round((Date.now() - t0) / 1000) });
    // 看不见的窗口点完就关：Hub 里只剩主窗口一个页面。
    const pages = (await (await fetch(`http://127.0.0.1:${hub.port}/json/list`)).json()).filter(p => p.type === 'page');
    assert.ok(!pages.some(p => /\/gate\//.test(p.url)), '放行窗口应已关闭');
    check('放行窗口点完即关，没有留下页面');

    // 3. 按钮点了也不放行：连续 3 次后停手进入冷却。
    g.gated = true; g.broken = true; g.clicks = 0;
    for (let i = 0; i < 5; i++) { await invoke('bridge:check-now'); await wait(300); }
    const st = await status();
    assert.equal(g.clicks, 3, '应只点 3 次');
    assert.ok(st.net.autoGate.cooldownUntil, '应进入冷却');
    assert.ok(logLines().some(x => x.result === 'gave-up'));
    check('点了仍被拦：连续 3 次后停手，进入 30 分钟冷却');
    result.passed = true;
  } catch (error) { result.error = error.stack || String(error); throw error; }
  finally {
    fs.writeFileSync(path.join(out, '20261015-company-gate-auto-result-claude1.json'), JSON.stringify(result, null, 1));
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    g.server.close();
    console.log(out);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
