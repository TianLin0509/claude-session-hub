'use strict';
// Ctrl+滚轮 / Ctrl+= 的阅读缩放要真的改变卡片正文字号（2026-10-14 田哥：提示显示 150%，卡片一点没变）。
// 根因：阅读缩放只写 --main-zoom，而 7 月 26 日之后样式表里没有地方读它；卡片正文由
// --card-content-font-size 决定。修复后卡片、用户气泡、群聊气泡的字号 = 卡片字号 × 阅读缩放。
// 真实隔离 Hub + 真实 Ctrl+滚轮事件；卡片区插入与真实卡片同结构的样例气泡来量 computed font-size（不花 token）。
//   node tests/e2e-ctrl-wheel-card-zoom-cdp.js
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const j = JSON.stringify;
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.E2E_OUT || path.join(ROOT, 'output', 'ctrl-wheel-card-zoom'));
const SAMPLE = '物理层下行先做同步信号检测，再解主信息块，随后按系统信息配置初始接入。调度器按信道质量分配资源块，HARQ 负责重传合并。';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-zoom-'));
  const cac = path.join(root, '.cac'), wsRoot = path.join(root, 'ws'), work = path.join(wsRoot, 'proj');
  for (const d of [cac, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  const report = { checks: [], sizes: {} };
  let hub, c;
  const check = (ok, label, detail) => { assert.ok(ok, label + (detail ? ' ' + j(detail) : '')); report.checks.push(label); console.log('  ✓ ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'background', label: 'ctrl-wheel-card-zoom',
      extraEnv: { AI_HUB_CODEAGENT_COMMAND: path.join(ROOT, 'tests/fixtures/codeagent-tui-standin/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: cac,
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_WORKSPACE_ROOT: wsRoot, HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), AI_HUB_UPDATE_SOURCES: '[]' } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150 && !(await c.eval('typeof selectSession === "function" && !!window.__hubZoomLabel').catch(() => false)); i++) await sleep(300);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64')); };

    const sid = (await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`)).id;
    await sleep(5000);
    await c.eval(`selectSession(${j(sid)})`); await sleep(600); await c.eval(`applyViewMode('card')`); await sleep(1200);
    check(await c.eval(`document.documentElement.dataset.displayMode !== 'phone'`), '电脑显示模式');

    // 与真实卡片同结构的样例：助手气泡、用户气泡（卡片渲染重画时会被清掉，所以每次量之前重插）
    const plant = () => c.eval(`(() => {
      const overlay = document.getElementById('msg-overlay');
      let box = overlay.querySelector('[data-zoom-probe]');
      if (!box) { box = document.createElement('div'); box.dataset.zoomProbe = '1'; overlay.prepend(box); }
      box.innerHTML = '<div class="turn-card user"><div class="turn-body">' + ${j('用户：' + SAMPLE)} + '</div></div>'
        + '<div class="turn-card assistant"><div class="turn-body">' + ${j(SAMPLE.repeat(3))} + '</div></div>';
      return true; })()`);
    const sizes = () => c.eval(`(() => { const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : null;
      return { reading: currentFontSize, overlay: px(document.getElementById('msg-overlay')),
        assistant: px(document.querySelector('[data-zoom-probe] .turn-card.assistant .turn-body')),
        user: px(document.querySelector('[data-zoom-probe] .turn-card.user .turn-body')),
        label: document.querySelector('.hub-zoom-label.visible')?.textContent || null }; })()`);
    const wheel = async (deltaY, times) => {
      const p = await c.eval(`(()=>{const r=document.getElementById('msg-overlay').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+Math.min(r.height/2,240))};})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      for (let i = 0; i < times; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY, modifiers: 2 }); await sleep(150); }
      await sleep(300);
    };

    await plant();
    const before = await sizes();
    report.sizes.before = before;
    check(before.reading === 16 && Math.abs(before.assistant - 15) < 0.01, '默认阅读缩放 100%：卡片正文仍是设置里的 15px，界面不变', before);
    await shot('01-before');

    await wheel(-100, 8); // 16 → 24，即 150%
    await plant();
    const zoomed = await sizes();
    report.sizes.zoomed = zoomed;
    check(zoomed.reading === 24 && /150%/.test(zoomed.label || ''), 'Ctrl+滚轮放大 8 格：提示「阅读缩放 150%」', zoomed);
    check(Math.abs(zoomed.assistant - 22.5) < 0.05 && Math.abs(zoomed.user - 22.5) < 0.05 && Math.abs(zoomed.overlay - 22.5) < 0.05,
      '卡片正文真的变大：15px × 150% = 22.5px（助手、用户气泡和卡片区一致）', zoomed);
    await shot('02-zoomed-150');

    await wheel(100, 8);
    await plant();
    const back = await sizes();
    check(back.reading === 16 && Math.abs(back.assistant - 15) < 0.01, 'Ctrl+滚轮缩回：正文回到 15px', back);

    // Ctrl+= 键盘快捷键走同一个设置
    await c.eval(`setFontSize(currentFontSize + 4)`); await plant();
    const keyed = await sizes();
    check(Math.abs(keyed.assistant - 15 * 20 / 16) < 0.05, `阅读字号 20（125%）时正文 ${keyed.assistant}px`, keyed);
    await c.eval(`setFontSize(16)`);

    // 群聊气泡
    const slot = { kind: 'codeagent', effort: 'low', mcpProfile: 'none' };
    const meeting = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({ title: '缩放验收', scene: 'general', groupChat: true, workspace: work, slots: [slot, slot] })})`);
    await sleep(3500);
    await c.eval(`selectMeeting(${j(meeting.id)})`); await sleep(1500);
    const groupSize = async () => c.eval(`(() => { const panel = document.getElementById('meeting-room-panel');
      let box = panel.querySelector('[data-zoom-probe]');
      if (!box) { box = document.createElement('div'); box.dataset.zoomProbe = '1'; box.className = 'mr-gc-messages'; panel.prepend(box); }
      box.innerHTML = '<div class="mr-gc-msg"><div class="mr-gc-bubble"><div class="mr-gc-md">' + ${j(SAMPLE)} + '</div></div></div>';
      return parseFloat(getComputedStyle(box.querySelector('.mr-gc-md')).fontSize); })()`);
    const g0 = await groupSize();
    await c.eval(`setFontSize(24)`);
    const g1 = await groupSize();
    report.sizes.group = { before: g0, zoomed: g1 };
    check(Math.abs(g1 - g0 * 1.5) < 0.05, `群聊气泡跟随阅读缩放：${g0}px → ${g1}px`, { g0, g1 });
    await c.eval(`setFontSize(16)`);

    report.passed = true;
    console.log('PASS e2e-ctrl-wheel-card-zoom-cdp');
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error); process.exit(1); });
