'use strict';
// 公司版侧栏「特战」（2026-10-17 田哥：侧栏全是替家里开的会话，空间都浪费了）。
// 用公司版导出物真实启动隔离 Hub：「今天 / 3 天」旁边是「特战」不是「无线」；平时列表里只有自己的会话，
// 点亮「特战」只看通道会话；会话名以「特战 · 」开头（旧的「AI特战队 · 」也这样显示），侧栏不出现「家里」。
// 用法：node tests/e2e-company-tezhan-sidebar-cdp.js <公司版导出目录>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const entryPath = path.resolve(process.argv[2] || '');
const OUT = path.resolve('artifacts/20261017-company-tezhan-sidebar-claude1');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  assert.ok(fs.existsSync(path.join(entryPath, 'community-edition.json')), '需要公司版导出目录');
  assert.equal(JSON.parse(fs.readFileSync(path.join(entryPath, 'community-edition.json'), 'utf8')).target, 'company');
  fs.mkdirSync(OUT, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tezhan-'));
  let hub, cdp;
  const checks = [];
  const check = (name) => { checks.push(name); console.log('✓ ' + name); };
  try {
    // hidden 窗口在负载下第二次截图会超时（v2.1.8、v2.1.10 发布各遇一次）；截图只是取证，改用后台窗口，断言不变。
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await freePort(), entryPath, label: 'company-tezhan', windowMode: 'background' });
    cdp = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label) => { const until = Date.now() + 30000; while (!(await cdp.eval(expr))) { if (Date.now() > until) throw new Error('timeout ' + label); await _waitMs(100); } };
    const click = async selector => {
      const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      await _waitMs(250);
    };
    await wait('!!document.getElementById("btn-sidebar-wireless") && typeof renderSessionList === "function"', 'sidebar ready');
    assert.equal(await cdp.eval('document.getElementById("btn-sidebar-wireless").textContent'), '特战');
    check('公司版：「今天 / 3 天」旁边的按钮是「特战」');

    // 一批会话：3 个通道会话（新名、旧名、只有 purpose），2 个自己的会话
    await cdp.eval(`(() => {
      const now = Date.now();
      const add = (id, title, extra = {}) => sessions.set(id, { id, kind: 'codeagent', title, status: 'idle', createdAt: now, lastMessageTime: now, ...extra });
      add('tz-1', '特战 · AirView 下行调度与 AMC', { purpose: 'company-bridge' });
      add('tz-2', 'AI特战队 · OLLA 步长核对', { purpose: 'company-bridge' });
      add('tz-3', '调度器入口查询', { purpose: 'company-bridge' });
      add('own-1', '我自己的周报整理');
      add('own-2', 'L2 调度单测排查');
      renderSessionList();
    })()`);
    await _waitMs(300);
    const titles = () => cdp.eval('Array.from(document.querySelectorAll("#session-list .sl-title")).map(e => e.textContent.trim())');
    let list = await titles();
    assert.ok(list.some(t => /我自己的周报整理/.test(t)) && list.some(t => /L2 调度单测排查/.test(t)), JSON.stringify(list));
    assert.ok(!list.some(t => /特战|AI特战队|调度器入口查询/.test(t)), '平时不显示通道会话：' + JSON.stringify(list));
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 520, height: 520, scale: 1 } });
    fs.writeFileSync(path.join(OUT, '01-own-sessions.png'), Buffer.from(shot.data, 'base64'));
    check('平时侧栏只有自己的会话，通道会话不占位置');

    await click('#btn-sidebar-wireless');
    assert.equal(await cdp.eval('document.getElementById("btn-sidebar-wireless").getAttribute("aria-pressed")'), 'true');
    list = await titles();
    assert.equal(list.length, 3, JSON.stringify(list));
    assert.ok(list.includes('特战 · AirView 下行调度与 AMC') && list.includes('特战 · OLLA 步长核对') && list.some(t => /调度器入口查询/.test(t)), JSON.stringify(list));
    assert.ok(!list.some(t => /AI特战队|家里/.test(t)), JSON.stringify(list));
    const sidebarText = await cdp.eval('document.getElementById("session-list").innerText');
    assert.doesNotMatch(sidebarText, /家里/);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 520, height: 520, scale: 1 } });
    fs.writeFileSync(path.join(OUT, '02-tezhan-only.png'), Buffer.from(shot.data, 'base64'));
    check('点亮「特战」只看通道会话；旧名「AI特战队 · 」显示成「特战 · 」，侧栏不出现「家里」');

    await cdp.eval('location.reload()');
    await wait('!!document.getElementById("btn-sidebar-wireless") && typeof renderSessionList === "function"', 'reload');
    assert.equal(await cdp.eval('document.getElementById("btn-sidebar-wireless").getAttribute("aria-pressed")'), 'true');
    check('刷新后保持「特战」开关状态');
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    try { await cdp?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => console.error('quit', e.message));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
