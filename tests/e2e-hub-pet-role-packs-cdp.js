'use strict';
// 桌宠形象在线下载端到端（2026-10-17）：真实导出的公司版（只带小猫、企鹅）+ 隔离 Hub + 本地 HTTP 形象源。
// 真实点击：左侧「助理」→「设置」→「桌宠」→ 兔子「下载」→ 点兔子卡片使用 → 桌宠窗口换成兔子；再关掉、打开「在桌面显示桌宠」。
// 用法：node tests/e2e-hub-pet-role-packs-cdp.js <公司版导出目录> [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');
const { buildPacks } = require('../scripts/build-hub-pet-packs.js');

const ENTRY = path.resolve(process.argv[2] || 'artifacts/20261017-pet-packs-claude3/company-preview');
const OUT = path.resolve(process.argv[3] || 'output/e2e-hub-pet-role-packs');
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  assert.ok(fs.existsSync(path.join(ENTRY, 'renderer', 'assets', 'hub-pet', '01-cat', 'idle.webp')), '公司版带小猫');
  assert.equal(fs.existsSync(path.join(ENTRY, 'renderer', 'assets', 'hub-pet', '05-rabbit')), false, '公司版不带兔子');
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-packs-e2e-'));
  const packDir = path.join(root, 'packs');
  buildPacks({ assetsDir: path.join(__dirname, '..', 'renderer', 'assets', 'hub-pet'), out: packDir, ids: ['05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'] });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const file = path.join(packDir, path.basename(decodeURIComponent(req.url)));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle' }));
  const result = { entry: ENTRY, source: 'localhost fixture via real Electron net.fetch', checks: {} };
  let hub, main;
  const pets = [];
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), entryPath: ENTRY, label: 'hub-pet-packs', extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1',
      CLAUDE_HUB_WELINK_CLI: WELINK, WELINK_STANDIN_STATE: path.join(root, 'welink-state'),
      AI_HUB_PET_SOURCES: JSON.stringify([{ id: 'fixture', name: '隔离验证源', manifest: base + 'catalog.json', files: base }]) } });
    main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await main.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label = expr, ms = 30000) => { const until = Date.now() + ms; while (!(await main.eval(expr).catch(() => false))) { if (Date.now() > until) throw new Error('timeout: ' + label); await _waitMs(120); } };
    const click = async selector => {
      const p = await main.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await main.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };
    const petTarget = async () => (await listCdpTargets(hub)).find(t => t.type === 'page' && /hub-pet[\\/]pet\.html/i.test(t.url || ''));
    const petView = async () => {
      const t = await petTarget();
      if (!t) return null;
      const c = await connectCDP(t.webSocketDebuggerUrl); pets.push(c);
      return c.eval(`(()=>{const d=window.__hubPetDebug&&window.__hubPetDebug();const cel=document.querySelector('#layers .cel');return {pose:d&&d.pose,bg:cel?getComputedStyle(cel).backgroundImage:''};})()`);
    };

    await wait('!!document.getElementById("btn-company-assistant")', '助理入口');
    // 'none' 是图还没解码画上（2026-10-18 起渲染端启动时还要量一次透明边，稍晚一点），等到真有图再判断
    const before = await (async () => { for (let i = 0; i < 80; i++) { const v = await petView(); if (v && /url\(/.test(v.bg)) return v; await _waitMs(150); } return null; })();
    assert.match(before.bg, /hub-pet\/01-cat\/[a-z-]+\.webp/, '起始是小猫：' + JSON.stringify(before));
    await click('#btn-company-assistant');
    await wait('!document.getElementById("company-assistant-page")?.hidden', '助理页');
    await click('[data-ca="settings"]');
    await wait('!!document.querySelector(\'[data-ca="settings-tab:pet"]\')', '设置分页');
    await click('[data-ca="settings-tab:pet"]');
    await wait("document.querySelectorAll('.pet-tab-card').length===6", '6 张形象卡');
    result.checks.noNetworkBeforeClick = requests.length === 0;
    assert.equal(requests.length, 0, '打开分页不联网');
    const cards = await main.eval("Array.from(document.querySelectorAll('.pet-tab-card'),c=>({id:c.dataset.role,cls:c.className,status:c.querySelector('.pet-tab-status').textContent,img:c.querySelector('img')?.getAttribute('src')||''}))");
    result.checks.initialCards = cards;
    assert.deepEqual(cards.filter(c => /installed/.test(c.cls)).map(c => c.id), ['01-cat', '03-penguin']);
    assert.ok(cards.every(c => c.img), '6 张卡都有预览图');
    assert.match(cards[0].status, /使用中/);
    fs.writeFileSync(path.join(OUT, '20261017-桌宠分页-初始-claude3.png'), Buffer.from((await main.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    await click('[data-pet="download"][data-id="05-rabbit"]');
    await wait("/已安装/.test(document.querySelector('.pet-tab-card[data-role=\"05-rabbit\"] .pet-tab-status')?.textContent||'')", '兔子下载完成');
    result.checks.requests = [...requests];
    assert.ok(requests.includes('/catalog.json') && requests.includes('/05-rabbit-1.0.0.json'));
    await click('.pet-tab-card[data-role="05-rabbit"]');
    await wait("document.querySelector('.pet-tab-card.current')?.dataset.role==='05-rabbit'", '兔子成为使用中');
    let after = null;
    for (let i = 0; i < 60 && !(after && /roles\/05-rabbit\//.test(after.bg)); i++) { await _waitMs(150); after = await petView(); }
    result.checks.petAfterSwitch = after;
    assert.match(after.bg, /file:.*hub-pet\/roles\/05-rabbit\/[a-z-]+\.webp/, '桌宠换成下载的兔子');
    fs.writeFileSync(path.join(OUT, '20261017-桌宠分页-兔子使用中-claude3.png'), Buffer.from((await main.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const t = await petTarget();
    const pc = await connectCDP(t.webSocketDebuggerUrl); pets.push(pc);
    fs.writeFileSync(path.join(OUT, '20261017-桌宠窗口-兔子-claude3.png'), Buffer.from((await pc.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    // 行为：说话频率分段、关掉 / 打开「在桌面显示桌宠」
    await click('[data-pet="mode"][data-id="quiet"]');
    await wait("document.querySelector('[data-pet=\"mode\"][data-id=\"quiet\"]')?.classList.contains('on')", '安静档');
    await click('.pet-tab-switch input[data-pet="enabled"]');
    for (let i = 0; i < 60 && (await petTarget()); i++) await _waitMs(150);
    result.checks.hiddenAfterOff = !(await petTarget());
    assert.ok(result.checks.hiddenAfterOff, '关掉后桌宠窗口消失');
    await click('.pet-tab-switch input[data-pet="enabled"]');
    let back = null;
    for (let i = 0; i < 80 && !(back && back.bg); i++) { await _waitMs(150); back = await petView(); }
    result.checks.backAfterOn = back;
    assert.match(back.bg, /roles\/05-rabbit\//, '再打开还是兔子');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub-pet.json'), 'utf8'));
    result.checks.saved = saved;
    assert.equal(saved.role, '05-rabbit'); assert.equal(saved.mode, 'quiet'); assert.equal(saved.enabled, true);
    result.ok = true;
  } finally {
    for (const c of pets) { try { await c.close(); } catch (_) {} }
    try { if (main) await main.close(); } catch (_) {}
    try { if (hub) await gracefulQuit(hub); } catch (_) {}
    server.closeAllConnections(); await new Promise(r => server.close(r));
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ ok: result.ok, out: OUT }));
})().catch(error => { console.error(error); process.exitCode = 1; });
