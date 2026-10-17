'use strict';
// 升级后记着的桌宠形象没装：后台自动下载并换上；下载失败只给一次温和提示（2026-10-18）。
// 真实导出的公司版（只带小猫、企鹅）+ 隔离 Hub + 本地 HTTP 形象源；数据目录预放 2.1.8 形状的 hub-pet.json（role=05-rabbit）。
//   第 1 段：形象源不可用 → 桌宠先是小猫、出一条提示（气泡或小圆点）→ 打开面板 → 真实点击「在助理里打开」→ 助理设置的「桌宠」分页；设置仍记着兔子。
//   第 2 段：同一数据目录、形象源恢复 → 启动后自动下载兔子（目录 + 包，带字节数与 SHA-256 校验）→ 桌宠换成兔子，没有提示。
// 每段都核对进程以退出码 0 干净退出。
// 用法：node tests/e2e-hub-pet-auto-role-cdp.js <公司版导出目录> [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');
const { buildPacks } = require('../scripts/build-hub-pet-packs.js');

const ENTRY = path.resolve(process.argv[2] || 'artifacts/20261018-pet-auto-role-claude1/company-preview');
const OUT = path.resolve(process.argv[3] || 'output/e2e-hub-pet-auto-role');
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitFor(fn, label, ms = 30000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await _waitMs(150); }
  throw new Error('timeout: ' + label + ' ' + (last && last.message ? last.message : JSON.stringify(last)));
}

(async () => {
  assert.ok(fs.existsSync(path.join(ENTRY, 'renderer', 'assets', 'hub-pet', '01-cat', 'idle.webp')), '公司版带小猫');
  assert.equal(fs.existsSync(path.join(ENTRY, 'renderer', 'assets', 'hub-pet', '05-rabbit')), false, '公司版不带兔子');
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-auto-role-e2e-'));
  const packDir = path.join(root, 'packs');
  buildPacks({ assetsDir: path.join(__dirname, '..', 'renderer', 'assets', 'hub-pet'), out: packDir, ids: ['05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'] });
  let online = false;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ online, url: req.url });
    const file = path.join(packDir, path.basename(decodeURIComponent(req.url)));
    if (!online || !fs.existsSync(file)) { res.writeHead(online ? 404 : 503); res.end(); return; }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 2.1.8 用户的设置：选了兔子。
  fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '05-rabbit', mode: 'gentle', position: null, quietUntil: 0, silentDate: '', peekOnFullscreen: true }));
  const savedRole = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'hub-pet.json'), 'utf8')).role;
  const result = { entry: ENTRY, source: 'localhost fixture via real Electron net.fetch', checks: {} };

  async function session(label, body) {
    const conns = [];
    const hub = await launchIsolatedHub({ dataDir, port: await freePort(), entryPath: ENTRY, label, extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1',
      CLAUDE_HUB_WELINK_CLI: WELINK, WELINK_STANDIN_STATE: path.join(root, 'welink-state'),
      AI_HUB_PET_SOURCES: JSON.stringify([{ id: 'fixture', name: '隔离验证源', manifest: base + 'catalog.json', files: base }]) } });
    try {
      const main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
      conns.push(main);
      await main.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      const debug = req => main.eval('require("electron").ipcRenderer.invoke("hub-pet:debug", ' + JSON.stringify(req) + ')');
      const petTarget = async () => (await listCdpTargets(hub)).find(t => t.type === 'page' && /hub-pet[\\/]pet\.html/i.test(t.url || ''));
      const pet = await connectCDP((await waitFor(petTarget, 'pet window')).webSocketDebuggerUrl);
      conns.push(pet);
      await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const petBg = () => pet.eval(`(()=>{const cel=document.querySelector('#layers .cel');return cel?getComputedStyle(cel).backgroundImage:'';})()`);
      const shot = async (conn, name) => { await _waitMs(300); const r = await conn.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); };
      await body({ hub, main, pet, debug, petBg, shot });
    } finally {
      for (const c of conns) { try { await c.close(); } catch (_) {} }
      result.checks[label + 'Exit'] = await gracefulQuit(hub);
    }
  }

  try {
    // 第 1 段：形象源不可用
    await session('offline', async ({ main, pet, debug, petBg, shot }) => {
      const first = await waitFor(async () => { const bg = await petBg(); return /url\(/.test(bg) ? bg : null; }, 'pet image');
      result.checks.offlineFirstImage = first;
      assert.match(first, /hub-pet\/01-cat\//, '没装兔子时先用小猫：' + first);
      const st = await waitFor(async () => { const s = await debug({ op: 'state' }); return s && s.autoRole && s.autoRole.phase === 'failed' ? s : null; }, 'auto download failed');
      result.checks.offlineState = { autoRole: st.autoRole, role: st.role, shownRole: st.lastSent.role };
      assert.equal(st.autoRole.id, '05-rabbit');
      assert.equal(st.lastSent.role, '01-cat');
      assert.ok(requests.some(r => !r.online && r.url === '/catalog.json'), '确实联网试过');
      // 提示：白天说出来（气泡）；夜里或安静档只亮小圆点。两种都点开面板。
      const view = await waitFor(async () => pet.eval(`(()=>{const b=document.getElementById('bubble');const d=document.getElementById('dot');return {bubble:!b.hidden?document.getElementById('bubble-text').textContent:'',dot:!d.hidden?d.textContent:''};})()`).then(v => (v.bubble || v.dot ? v : null)), 'notice shown');
      result.checks.offlineNotice = view;
      if (view.bubble) assert.match(view.bubble, /兔子还没下载下来/);
      else assert.equal(view.dot, '1', '只有一条提示');
      await shot(pet, '20261018-01-下载失败-提示-claude1.png');
      await debug({ op: 'press', target: view.bubble ? 'bubble' : 'dot' });
      await debug({ op: 'release' });
      const panel = await waitFor(async () => pet.eval('!document.getElementById("panel").hidden && document.getElementById("panel").innerText'), 'panel open');
      result.checks.offlinePanel = panel;
      assert.match(panel, /助理 → 设置 → 桌宠/);
      await shot(pet, '20261018-02-提示面板-claude1.png');
      // 真实点击「在助理里打开」
      const p = await pet.eval(`(()=>{const e=document.querySelector('.panel-item .open');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await pet.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      await waitFor(async () => main.eval('!!document.querySelector(\'.ca-tab.on[data-ca="settings-tab:pet"]\') && document.querySelectorAll(".pet-tab-card").length >= 2'), 'pet settings tab opened');
      const cards = await main.eval("Array.from(document.querySelectorAll('.pet-tab-card'),c=>({id:c.dataset.role,status:c.querySelector('.pet-tab-status').textContent}))");
      result.checks.offlineCards = cards;
      await shot(main, '20261018-03-助理设置-桌宠分页-claude1.png');
      assert.equal(savedRole(), '05-rabbit', '设置仍记着兔子');
    });
    assert.equal(result.checks.offlineExit.exitCode, 0);

    // 第 2 段：形象源恢复
    online = true;
    const before = requests.length;
    await session('online', async ({ debug, petBg, pet, shot }) => {
      const st = await waitFor(async () => { const s = await debug({ op: 'state' }); return s && s.autoRole && s.autoRole.phase === 'installed' ? s : null; }, 'auto download installed');
      result.checks.onlineState = { autoRole: st.autoRole, role: st.role, shownRole: st.lastSent.role };
      const bg = await waitFor(async () => { const v = await petBg(); return /roles\/05-rabbit\//.test(v) ? v : null; }, 'pet shows rabbit');
      assert.match(bg, /file:.*hub-pet\/roles\/05-rabbit\/[a-z-]+\.webp/, '桌宠换成下载的兔子');
      const got = requests.slice(before).map(r => r.url);
      result.checks.onlineRequests = got;
      assert.ok(got.includes('/catalog.json') && got.includes('/05-rabbit-1.0.0.json'), '走目录 + 包');
      assert.ok(fs.existsSync(path.join(dataDir, 'hub-pet', 'roles', '05-rabbit', 'idle.webp')), '装进数据目录');
      const view = await pet.eval(`({bubble:!document.getElementById('bubble').hidden,dot:!document.getElementById('dot').hidden})`);
      result.checks.onlineNotice = view;
      assert.deepEqual(view, { bubble: false, dot: false }, '成功不打扰');
      await shot(pet, '20261018-04-自动换成兔子-claude1.png');
      assert.equal(savedRole(), '05-rabbit');
    });
    assert.equal(result.checks.onlineExit.exitCode, 0);
    result.ok = true;
  } catch (error) {
    result.ok = false; result.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ ok: result.ok, out: OUT, error: result.ok ? undefined : String(result.error).split('\n')[0] }));
})().catch(error => { console.error(error); process.exitCode = 1; });
