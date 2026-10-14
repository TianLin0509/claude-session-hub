'use strict';
// 面板可见性记忆（renderer/panel-visibility.js）在真实界面里不出错：逐个点开左侧导航的各个页面再回到会话，
// 每一步都对比「记住的结论」和「重新量出来的结论」，并核对工具栏视图名与导航栏占位宽度。
//   node tests/e2e-panel-visibility-memo-cdp.js
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const net = require('net');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PANELS = ['assistant-page', 'account-page', 'hub-workspace', 'memo-panel', 'chuxin-panel', 'study-panel', 'ran-panel', 'writing-panel', 'rules-panel', 'meeting-room-panel'];

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-panel-memo-'));
  let hub, c; const steps = [];
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'background', label: 'panel-memo',
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_UPDATE_SOURCES: '[]' } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150 && !(await c.eval('typeof selectSession === "function" && typeof currentAppToolbarView === "function"').catch(() => false)); i++) await sleep(300);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 0, mobile: false });
    const sid = (await c.eval(`ipcRenderer.invoke('create-session', 'powershell')`)).id;
    await sleep(1200);
    const click = async sel => {
      const p = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      if (!p) return false;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      await sleep(700); return true;
    };
    const check = async label => {
      const r = await c.eval(`(() => { const ids = ${JSON.stringify(PANELS)}; const out = { mismatches: [], view: currentAppToolbarView() };
        for (const id of ids) { const el = document.getElementById(id); if (!el) continue; const memo = panelIsVisible(el), fresh = panelIsVisible.check.measure(el); if (memo !== fresh) out.mismatches.push({ id, memo, fresh }); }
        const rail = document.getElementById('scene-rail'); out.railWidth = rail ? Math.round(rail.getBoundingClientRect().width) : null;
        out.slot = getComputedStyle(document.documentElement).getPropertyValue('--hub-rail-slot').trim();
        out.appClasses = ['rail-pinned', 'rail-preview', 'rail-hidden'].filter(k => document.getElementById('app-container').classList.contains(k));
        return out; })()`);
      steps.push({ label, ...r });
      assert.deepEqual(r.mismatches, [], `${label}: 记住的可见性与重新测量不一致 ${JSON.stringify(r.mismatches)}`);
      return r;
    };
    await c.eval(`selectSession(${JSON.stringify(sid)})`); await sleep(800);
    assert.equal((await check('会话')).view, null);
    const nav = [['#btn-home', '主页'], ['#btn-assistant', '助理'], ['#btn-rail-accounts', '账号'], ['#btn-writing', '写作'], ['#btn-rules', '规则'],
      ['#btn-study', '学习'], ['#btn-ran', '开发'], ['#btn-research', '投研'], ['#btn-rail-memo', '速记'], ['#btn-rail-capabilities', '资源与回顾']];
    for (const [sel, expected] of nav) {
      if (!(await click(sel))) { steps.push({ label: expected, skipped: '导航里没有这个入口' }); continue; }
      const r = await check(expected);
      // 速记与资源同属 hub-workspace，视图名按面板定；只要求进入了一个非会话视图且记忆与实测一致
      if (!['速记', '资源与回顾'].includes(expected)) assert.equal(r.view, expected, `${expected}: 工具栏视图名`);
      else assert.ok(r.view, `${expected}: 应是非会话视图`);
      // 助理页这类整页视图盖住了侧栏，用户要先点「主页」再点会话。
      if (!(await click(`.session-item[data-session-id="${sid}"]`)) || await c.eval('currentAppToolbarView() !== null')) {
        await check(expected + ' → 主页'); await click('#btn-home');
        assert.ok(await click(`.session-item[data-session-id="${sid}"]`), '侧栏里能点到会话');
      }
      assert.equal((await check(expected + ' → 回到会话')).view, null, `${expected} → 回到会话`);
    }
    // 收起导航：占位宽度按镜像类变为 0，再固定回来
    const before = await check('导航固定');
    assert.equal(before.slot !== '0px', true);
    if (await click('#btn-toggle-navigation')) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 500 }); await sleep(500);
      const hidden = await check('导航收起');
      assert.ok(hidden.appClasses.includes('rail-hidden'));
      assert.equal(hidden.slot, '0px', '收起后导航不占位');
      await click('#btn-toggle-navigation');
      const back = await check('导航重新固定');
      assert.equal(back.slot, before.slot);
    }
    console.log(JSON.stringify(steps.map(s => ({ label: s.label, view: s.view, slot: s.slot, skipped: s.skipped }))));
    console.log('e2e-panel-visibility-memo-cdp: PASS');
  } catch (error) {
    console.error(JSON.stringify(steps, null, 1));
    console.error(error); process.exitCode = 1;
  } finally { try { c?.close(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); }
})();
