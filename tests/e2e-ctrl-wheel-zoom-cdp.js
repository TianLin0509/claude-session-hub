'use strict';
// Ctrl + 鼠标滚轮缩放（renderer/ctrl-wheel-zoom.js），真实隔离 Hub + 真实鼠标滚轮事件：
// 卡片、卡片沉浸阅读、群聊卡片 → 阅读缩放；后台终端 → 终端字号；Markdown / 网页预览、预览沉浸 → 预览缩放；
// 触控板细碎滚动累积成一格；整个窗口永不被 Chromium 放大。
//   node tests/e2e-ctrl-wheel-zoom-cdp.js
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const j = JSON.stringify;
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'ctrl-wheel-zoom');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ctrl-wheel-'));
  const cac = path.join(root, '.cac'), wsRoot = path.join(root, 'ws'), work = path.join(wsRoot, 'proj');
  for (const d of [cac, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  const md = path.join(work, 'notes.md'), html = path.join(work, 'page.html');
  fs.writeFileSync(md, '# 标题\n\n' + '正文段落，用来验证预览缩放。'.repeat(80));
  fs.writeFileSync(html, '<!doctype html><meta charset=utf-8><body style="font:16px sans-serif">' + '<p>网页正文</p>'.repeat(60) + '</body>');
  const report = { checks: [] };
  let hub, c;
  const check = (ok, label, detail) => { assert.ok(ok, label + (detail ? ' ' + j(detail) : '')); report.checks.push(label); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'background', label: 'ctrl-wheel-zoom',
      extraEnv: { AI_HUB_CODEAGENT_COMMAND: path.join(ROOT, 'tests/fixtures/codeagent-tui-standin/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: cac,
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_WORKSPACE_ROOT: wsRoot, HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), AI_HUB_UPDATE_SOURCES: '[]' } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150 && !(await c.eval('typeof selectSession === "function" && !!window.__hubZoomLabel').catch(() => false)); i++) await sleep(300);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 0, mobile: false });
    const state = () => c.eval(`(() => ({ reading: currentFontSize, terminal: currentTerminalFontSize, page: require('electron').webFrame.getZoomFactor(),
      preview: document.getElementById('preview-zoom-label')?.textContent, label: document.querySelector('.hub-zoom-label.visible')?.textContent || null }))()`);
    const point = async sel => {
      const p = await c.eval(`(()=>{const e=document.querySelector(${j(sel)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:Math.round(r.x+r.width/2),y:Math.round(r.y+Math.min(r.height/2,240))}:null;})()`);
      assert.ok(p, 'visible ' + sel); return p;
    };
    const wheel = async (sel, deltaY, times = 1) => {
      const p = await point(sel);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      for (let i = 0; i < times; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY, modifiers: 2 }); await sleep(120); }
      await sleep(350);
      return state();
    };
    const click = async sel => { const p = await point(sel); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); await sleep(600); };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64')); };

    const sid = (await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`)).id;
    await sleep(6000);
    await c.eval(`selectSession(${j(sid)})`); await sleep(600); await c.eval(`applyViewMode('card')`); await sleep(1200);
    const start = await state();

    // 1. 卡片：每格一档，和 Ctrl+= / Ctrl+- 同一个阅读设置；整窗不放大
    let s = await wheel('#msg-overlay', -100, 2);
    check(s.reading === start.reading + 2 && s.page === 1, '卡片上 Ctrl+滚轮放大阅读缩放、整窗不变', s);
    check(/^阅读缩放 \d+%$/.test(s.label || ''), '缩放时显示百分比提示', s);
    await shot('01-card-zoomed');
    s = await wheel('#msg-overlay', 100, 2);
    check(s.reading === start.reading, '卡片上 Ctrl+滚轮缩小回原值', s);
    // 只查 --main-zoom 变量会漏掉「变量变了、样式表没人读它」（2026-10-14 实际发生过）：量卡片区真实字号。
    const overlayPx = () => c.eval(`parseFloat(getComputedStyle(document.getElementById('msg-overlay')).fontSize)`);
    const basePx = await overlayPx();
    await c.eval(`setFontSize(currentFontSize + 4)`);
    const grownPx = await overlayPx();
    await c.eval(`setFontSize(${start.reading})`);
    check(Math.abs(grownPx - basePx * (start.reading + 4) / start.reading) < 0.05, '卡片正文字号随阅读缩放真实变大', { basePx, grownPx });

    // 2. 触控板：5 个 20px 的细碎滚动才算一格
    s = await wheel('#msg-overlay', -20, 5);
    check(s.reading === start.reading + 1, '触控板细碎滚动累积成一格', s);
    await wheel('#msg-overlay', 100, 1);

    // 3. 卡片沉浸阅读
    await click('#btn-session-immersive');
    for (let i = 0; i < 30 && !(await c.eval(`document.body.classList.contains('session-immersive-active')`)); i++) await sleep(200);
    check(await c.eval(`document.body.classList.contains('session-immersive-active')`), '进入卡片沉浸阅读');
    s = await wheel('#msg-overlay', -100, 1);
    check(s.reading === start.reading + 1 && s.page === 1, '沉浸阅读里 Ctrl+滚轮放大', s);
    await shot('02-session-immersive');
    await wheel('#msg-overlay', 100, 1);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    for (let i = 0; i < 30 && await c.eval(`document.body.classList.contains('session-immersive-active')`); i++) await sleep(200);

    // 4. 后台终端：终端字号，不动阅读缩放
    await c.eval(`applyViewMode('pty')`); await sleep(1200);
    const termStart = (await state()).terminal;
    s = await wheel('.terminal-container .xterm-screen', -100, 1);
    check(s.terminal === termStart + 1 && s.reading === start.reading && s.page === 1, '后台终端上 Ctrl+滚轮调终端字号', s);
    s = await wheel('.terminal-container .xterm-screen', 100, 1);
    check(s.terminal === termStart, '终端字号缩回', s);
    await c.eval(`applyViewMode('card')`); await sleep(800);

    // 5. 群聊卡片
    const slot = { kind: 'codeagent', effort: 'low', mcpProfile: 'none' };
    const meeting = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({ title: '缩放验收', scene: 'general', groupChat: true, workspace: work, slots: [slot, slot] })})`);
    await sleep(4000);
    await click(`[data-meeting-id="${meeting.id}"] .sl-title`);
    await sleep(1500);
    s = await wheel('#meeting-room-panel', -100, 1);
    check(s.reading === start.reading + 1 && s.page === 1, '群聊里 Ctrl+滚轮放大阅读缩放', s);
    await shot('03-group');
    await wheel('#meeting-room-panel', 100, 1);
    await click(`[data-session-id="${sid}"]`).catch(() => {});
    await c.eval(`selectSession(${j(sid)})`); await sleep(800);

    // 6. 预览：Markdown（Hub 自己渲染）与网页（嵌入页面，经 preload 转发）
    await c.eval(`openPreviewPanel(${j(md)})`); await sleep(1800);
    s = await wheel('#preview-body', -100, 2);
    check(s.preview === '120%' && s.reading === start.reading && s.page === 1, 'Markdown 预览 Ctrl+滚轮放大到 120%', s);
    check(s.label === '预览 120%', '预览缩放提示', s);
    await c.eval(`openPreviewPanel(${j(html)})`); await sleep(2500);
    const webStart = Number(String((await state()).preview).replace('%', ''));
    s = await wheel('#preview-body webview', -100, 2);
    const wv = await c.eval(`document.querySelector('#preview-body webview').getZoomFactor()`);
    // 每格 10%，网页本身保持 1 倍：缩放只来自预览外层，不再叠成 1.2×1.2
    check(Number(String(s.preview).replace('%', '')) === webStart + 20 && wv === 1 && s.page === 1, '网页预览里 Ctrl+滚轮每格 10%、不二次放大', { webStart, s, wv });
    await shot('04-web-preview');

    // 7. 预览沉浸
    await click('#preview-layout-immersive');
    for (let i = 0; i < 30 && !(await c.eval(`document.body.classList.contains('preview-immersive-active')`)); i++) await sleep(200);
    const before = Number(String((await state()).preview).replace('%', ''));
    s = await wheel('#preview-body webview', 100, 1);
    check(Number(String(s.preview).replace('%', '')) === before - 10, '预览沉浸里 Ctrl+滚轮缩小', { before, s });
    const labelOnTop = await c.eval(`(() => { const l = document.querySelector('.hub-zoom-label'); const p = document.getElementById('preview-panel'); return Number(getComputedStyle(l).zIndex) > Number(getComputedStyle(p).zIndex); })()`);
    check(s.label === `预览 ${before - 10}%` && labelOnTop, '预览沉浸里缩放提示显示在最上层', { s, labelOnTop });
    await shot('05-preview-immersive');
    report.passed = true;
    console.log(j(report));
    console.log('e2e-ctrl-wheel-zoom-cdp: PASS');
  } catch (error) {
    report.error = error.stack; console.error(j(report, null, 1)); process.exitCode = 1;
    if (c) await c.send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync(path.join(OUT, 'failure.png'), Buffer.from(s.data, 'base64'))).catch(() => {});
  } finally { try { c?.close(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); }
})();
