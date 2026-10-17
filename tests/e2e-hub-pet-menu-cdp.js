'use strict';
// 桌宠自绘右键菜单 + 提醒面板端到端（2026-10-17，隔离 Hub，独立数据目录与 CDP 端口；公司助理页用假 welink-cli 打开）。
// 真实点击菜单窗口里的按钮：说话频率换成「活泼」、打开「安静一小时」、点「桌宠设置…」跳到助理设置的「桌宠」分页；
// 发一条假提醒，点气泡展开面板。每一步截图（菜单、气泡、面板、助理设置分页 1440 宽）。
// 用法：node tests/e2e-hub-pet-menu-cdp.js [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'output', 'e2e-hub-pet-menu'));
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitFor(fn, label, ms = 20000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await _waitMs(150); }
  throw new Error('timeout: ' + label + ' ' + (last && last.message ? last.message : JSON.stringify(last)));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-menu-e2e-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle' }));
  const result = { checks: {} };
  let hub; const conns = [];
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'hub-pet-menu', windowMode: 'hidden', extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: WELINK, WELINK_STANDIN_STATE: path.join(root, 'welink-state') } });
    const main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    conns.push(main);
    await main.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const debug = req => main.eval('require("electron").ipcRenderer.invoke("hub-pet:debug", ' + JSON.stringify(req) + ')');
    const target = re => waitFor(async () => (await listCdpTargets(hub)).find(t => t.type === 'page' && re.test(t.url || '')), String(re));
    const pet = await connectCDP((await target(/hub-pet[\\/]pet\.html/i)).webSocketDebuggerUrl);
    conns.push(pet);
    await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const st0 = await waitFor(async () => { const s = await debug({ op: 'state' }); return s && s.visible && s.lastSent ? s : null; }, 'pet visible');
    const ten = new Date(); ten.setHours(10, 0, 0, 0);
    await debug({ op: 'override', nowShift: ten.getTime() - Date.now(), idleSec: 0, busy: false });
    const shot = async (conn, name) => { await _waitMs(350); const r = await conn.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); };
    const realClick = async (conn, selector) => {
      const p = await conn.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await conn.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    };

    // 1. 右键：菜单窗口出现在鼠标处，内容齐全
    const b = st0.bounds;
    await debug({ op: 'cursor', pos: { x: b.x + 140, y: b.y + 260 } });
    await pet.eval('window.hubPet.menu(); true');
    const menu = await connectCDP((await target(/hub-pet[\\/]pet-menu\.html/i)).webSocketDebuggerUrl);
    conns.push(menu);
    await menu.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const m0 = await waitFor(async () => { const d = await menu.eval('window.__hubPetMenuDebug && window.__hubPetMenuDebug()'); return d && d.state ? d : null; }, 'menu state');
    assert.equal(m0.items, 6 + 2 + 2, '6 件助理事项 + 2 个开关 + 设置、收起');
    assert.equal(m0.state.mode, 'gentle');
    assert.ok(m0.state.roles.length >= 2, '列出已安装形象');
    result.checks.menu = { height: Math.round(m0.height), roles: m0.state.roles.map(r => r.id), status: m0.state.status };
    await shot(menu, '20261017-桌宠菜单-claude2.png');

    // 2. 说话频率换成「活泼」：菜单不收起、当场高亮，桌宠设置跟着变
    await realClick(menu, '#modes button:nth-child(1)');
    await waitFor(async () => (await menu.eval('window.__hubPetMenuDebug().state.mode')) === 'lively', 'mode lively in menu');
    const set1 = await main.eval('require("electron").ipcRenderer.invoke("hub-pet:get-settings")');
    assert.equal(set1.settings.mode, 'lively');
    // 3. 安静一小时：开关打开，显示「安静到 hh:mm」
    await realClick(menu, '#quiet-hour');
    await waitFor(async () => (await menu.eval('document.getElementById("quiet-hour").classList.contains("on")')), 'quiet on');
    const quietText = await menu.eval('document.querySelector("#quiet-hour .txt").textContent');
    assert.match(quietText, /^安静到 \d\d:\d\d$/);
    result.checks.toggles = { mode: 'lively', quietText };
    await shot(menu, '20261017-桌宠菜单-开关后-claude2.png');
    await realClick(menu, '#quiet-hour');
    await waitFor(async () => !(await menu.eval('document.getElementById("quiet-hour").classList.contains("on")')), 'quiet off');

    // 4. 「桌宠设置…」：菜单收起，Hub 打开助理设置的「桌宠」分页
    await realClick(menu, '#open-settings');
    await waitFor(async () => main.eval('!!document.querySelector(\'.ca-tab.on[data-ca="settings-tab:pet"]\') && document.querySelectorAll(".pet-tab-card").length >= 2'), 'pet settings tab');
    const menuVisible = (await debug({ op: 'state' })) && await menu.eval('document.visibilityState');
    result.checks.settingsTab = { opened: true, menuVisibility: menuVisible };
    await shot(main, '20261017-助理设置-桌宠分页-claude2.png');
    await realClick(main, '[data-ca="settings-tab:welink"]');
    await waitFor(async () => main.eval('/WeLink 登录/.test(document.querySelector(".ca-tab-body")?.innerText || "")'), 'welink tab');
    await shot(main, '20261017-助理设置-WeLink与邮箱-claude2.png');

    // 5. 提醒：气泡带类别小标签；点气泡展开面板
    await debug({ op: 'notice', notice: { id: 'e2e-menu-1', kind: 'meeting-prep', title: '9 分钟后开会：方案评审', text: '10:30–11:30 方案评审\n地点：会议室 A\n参会 6 人，会议附了材料' } });
    await waitFor(async () => (await pet.eval('document.getElementById("bubble-kind").textContent')) === '会前准备', 'bubble kind');
    await shot(pet, '20261017-桌宠气泡-claude2.png');
    await debug({ op: 'press', target: 'bubble' });
    await debug({ op: 'release' });
    await waitFor(async () => pet.eval('!document.getElementById("panel").hidden && /会议室 A/.test(document.getElementById("panel").innerText)'), 'panel open');
    result.checks.panel = await pet.eval('({ head: document.querySelector(".panel-head b").textContent, kind: document.querySelector(".panel-item .kind")?.textContent })');
    assert.equal(result.checks.panel.kind, '会前准备');
    await shot(pet, '20261017-桌宠提醒面板-claude2.png');
    result.ok = true;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 1));
    console.log('PASS hub pet menu e2e →', OUT);
  } catch (error) {
    result.ok = false; result.error = error.stack || String(error);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 1));
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    for (const c of conns) { try { c.close(); } catch (_) {} }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
})();
