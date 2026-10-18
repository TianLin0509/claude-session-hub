'use strict';
// 桌宠大小与贴边（2026-10-18 田哥在公司 2.1.10 上反馈）：隔离 Hub，真实桌宠窗口与真实设置页。
// 验证：渲染端量出形象图的透明边并告诉主进程 → 拖到屏幕右边时看得见的身体正好贴边、脚踩在任务栏上沿；
// 「助理 → 设置 → 桌宠」的大小滑块连续调（拖动中就变、松手记住），窗口按身体加高、脚的位置不动。
// 截图（1440 宽设置页 + 桌宠窗口透明底）写 output/。
// 用法：node tests/e2e-hub-pet-size-edges-cdp.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');

const OUT = path.resolve(__dirname, '..', 'output');
const SEAT = process.env.HUB_E2E_SEAT || 'claude1'; // 产物文件名里的席位，多个分身同时跑时不互相覆盖
const ROOT_TMP = path.join(process.env.TEMP || os.tmpdir(), 'hub-pet-size-' + Date.now());
const DATA_DIR = path.join(ROOT_TMP, 'data');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
async function waitFor(fn, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await _waitMs(150); }
  throw new Error('timeout: ' + label + ' ' + (last && last.message ? last.message : JSON.stringify(last)));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 温和档（不是安静档）：贴边时要真的冒气泡、展开面板，核对它们都在屏幕里（2026-10-18 审核）。
  fs.writeFileSync(path.join(DATA_DIR, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle' }));
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const result = { checks: [], shots: [] };
  let hub, main, pet;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: await freePort(), label: 'hub-pet-size', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(ROOT_TMP, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1', CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: path.join(ROOT_TMP, 'no-welink.js') } });
    main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await main.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const petTarget = await waitFor(async () => (await listCdpTargets(hub)).find(t => t.type === 'page' && /hub-pet[\\/]pet\.html/i.test(t.url || '')), 'pet target');
    pet = await connectCDP(petTarget.webSocketDebuggerUrl);
    const debug = req => main.eval('require("electron").ipcRenderer.invoke("hub-pet:debug", ' + JSON.stringify(req) + ')');
    const shotPet = async name => { const s = await pet.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${stamp}-hub-pet-${name}-${SEAT}.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
    const shotMain = async name => { const s = await main.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${stamp}-hub-pet-${name}-${SEAT}.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };

    // 贴边时气泡、提醒面板（含「在助理里打开 ›」和 ×）、小圆点都完全在屏幕工作区里，且点得到（2026-10-18 审核）。
    const day = new Date(); day.setHours(10, 0, 0, 0);
    await debug({ op: 'override', nowShift: day.getTime() - Date.now(), idleSec: 0, busy: false, fullscreen: false });
    const rectsOf = sels => pet.eval(`(() => { const out = {}; for (const [k, sel] of Object.entries(${JSON.stringify(sels)})) { const el = document.querySelector(sel); if (!el || el.hidden) { out[k] = null; continue; }
      const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      out[k] = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, hit: !!(hit && (hit === el || el.contains(hit))) }; } return out; })()`);
    const inScreen = (st, rects, label) => {
      const a = st.area, bx = st.bounds.x, by = st.bounds.y;
      for (const [k, r] of Object.entries(rects)) {
        assert.ok(r, `${label} ${k} 没显示`);
        assert.ok(bx + r.left >= a.x - 1 && bx + r.right <= a.x + a.width + 1, `${label} ${k} 横向出了屏幕：${bx + r.left}–${bx + r.right}，屏幕 ${a.x}–${a.x + a.width}`);
        assert.ok(by + r.top >= a.y - 1 && by + r.bottom <= a.y + a.height + 1, `${label} ${k} 纵向出了屏幕`);
        assert.ok(r.left >= -1 && r.right <= st.bounds.width + 1, `${label} ${k} 出了桌宠窗口`);
        assert.ok(r.hit, `${label} ${k} 中心点不到它`);
      }
    };
    async function checkOverlays(pct) {
      const label = `${pct}% 贴右边`;
      const st = await debug({ op: 'state' });
      assert.equal(st.dock, 'right', label);
      assert.ok(st.edge.right > 0, `${label}：窗口有一截伸出屏幕（${st.edge.right}px）`);
      const notice = { id: `e2e-size-${pct}-${Date.now()}`, kind: 'meeting-prep', title: '14:00 的评审准备卡好了，材料 v3 新增第 4 章', text: '材料 v3 新增第 4 章：调度增益对比。\n点「在助理里打开」看完整准备卡。' };
      await debug({ op: 'notice', notice });
      await waitFor(async () => (await pet.eval('window.__hubPetDebug().bubble')) === notice.id, `${label} 气泡`);
      await _waitMs(450); // 等冒出来的动画走完再量
      const bubble = await rectsOf({ bubble: '#bubble' });
      inScreen(st, bubble, label);
      await shotPet(`05-bubble-${pct}`);
      await debug({ op: 'press', target: 'bubble' });
      await debug({ op: 'release' });
      await waitFor(() => pet.eval(`!document.getElementById('panel').hidden`), `${label} 面板`);
      await _waitMs(350);
      const panel = await rectsOf({ panel: '#panel', close: '#panel-close', open: '#panel-list .panel-item .open' });
      inScreen(st, panel, label);
      await shotPet(`06-panel-${pct}`);
      await pet.eval(`document.getElementById('panel-close').click()`);
      result.overlays = result.overlays || {};
      result.overlays[pct] = { edge: st.edge, bounds: st.bounds, area: st.area, bubble: bubble.bubble, panel: panel.panel, close: panel.close, open: panel.open };
      result.checks.push(`${pct}% 贴右边（窗口伸出屏幕 ${st.edge.right}px）：气泡、提醒面板、「在助理里打开 ›」和 × 都在屏幕里且点得到`);
    }

    // ① 渲染端量出小猫图的透明边（idle.webp：320 宽里身体在 49–254 列、脚到第 275 行）
    const st1 = await waitFor(async () => { const s = await debug({ op: 'state' }); return s.bodyBox && s.bodyBox.left > 0 ? s : null; }, 'body box measured');
    result.bodyBox = st1.bodyBox; result.inset = st1.inset;
    assert.ok(Math.abs(st1.bodyBox.left - 49 / 320) < 0.01 && Math.abs(st1.bodyBox.right - 65 / 320) < 0.01 && Math.abs(st1.bodyBox.bottom - 44 / 320) < 0.01, JSON.stringify(st1.bodyBox));
    assert.deepEqual([st1.inset.left, st1.inset.right], [88, 95]);
    const feet = await pet.eval(`getComputedStyle(document.documentElement).getPropertyValue('--feet').trim()`);
    assert.equal(feet, '21px', '身体往下挪 21px，脚踩在窗口底边上方 6px');
    result.checks.push(`量出小猫图的透明边：左 ${Math.round(st1.bodyBox.left * 100)}%、右 ${Math.round(st1.bodyBox.right * 100)}%、脚下 ${Math.round(st1.bodyBox.bottom * 100)}%；限位按看得见的身体算（左右各让出 88/95px），身体下移 21px`);
    await shotPet('01-size-100');

    // ② 拖到屏幕最右边：看得见的身体右边正好在工作区右边，脚在工作区底边
    const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 2, `${label}：${a} vs ${b}`); // 125%/150% 缩放下窗口尺寸会差 1px
    const b = st1.bounds;
    await debug({ op: 'cursor', pos: { x: b.x + 140, y: b.y + b.height - 60 } });
    await debug({ op: 'press', target: 'pet' });
    for (let i = 1; i <= 8; i++) { await debug({ op: 'cursor', pos: { x: b.x + 140 + i * 400, y: b.y + b.height - 60 + i * 200 } }); await _waitMs(30); }
    await _waitMs(300);
    await debug({ op: 'release' });
    const st2 = await waitFor(async () => { await _waitMs(400); const s = await debug({ op: 'state' }); return s; }, 'after drag');
    const area = st2.area; // Electron 的工作区（去掉任务栏），和主进程限位用的是同一个
    const rightEdge = st2.bounds.x + st2.bounds.width - st2.inset.right, feetY = st2.bounds.y + st2.bounds.height - 6;
    result.edge = { area, bounds: st2.bounds, visibleRight: rightEdge, feetY, dock: st2.dock };
    near(rightEdge, area.x + area.width, '身体右边贴着屏幕右边');
    near(feetY, area.y + area.height, '脚踩在任务栏上沿');
    assert.equal(st2.dock, 'right');
    result.checks.push(`拖到屏幕右下角：看得见的身体右边 = 屏幕右边（${rightEdge}），脚 = 任务栏上沿（${feetY}），记为贴右边`);
    await checkOverlays(100);

    // ③ 设置页的大小滑块：拖到 160%，窗口加高、脚不动、还贴着右边；松手记住
    await main.eval(`document.getElementById('btn-company-assistant').click()`);
    await waitFor(() => main.eval(`!document.getElementById('company-assistant-page')?.hidden`), 'assistant page');
    await main.eval(`document.querySelector('[data-ca="settings"]').click()`);
    await waitFor(() => main.eval(`!!document.querySelector('[data-ca="settings-tab:pet"]')`), 'pet tab button');
    await main.eval(`document.querySelector('[data-ca="settings-tab:pet"]').click()`);
    await waitFor(() => main.eval(`!!document.querySelector('input[data-pet-size]')`), 'size slider');
    const slide = (v, change) => main.eval(`(() => { const r = document.querySelector('input[data-pet-size]'); r.value = ${v}; r.dispatchEvent(new Event('input', { bubbles: true })); ${change ? "r.dispatchEvent(new Event('change', { bubbles: true }));" : ''} return true; })()`);
    for (const v of [110, 125, 140, 160]) { await slide(v, false); await _waitMs(80); }
    const live = await waitFor(async () => { const s = await debug({ op: 'state' }); return s.scale === 1.6 ? s : null; }, 'live scale');
    near(live.bounds.height, 190 + 240, '窗口高');
    near(live.bounds.y + live.bounds.height, st2.bounds.y + st2.bounds.height, '脚的位置不动');
    near(live.bounds.x + live.bounds.width - live.inset.right, area.x + area.width, '放大后还贴着右边');
    await slide(160, true);
    await waitFor(() => main.eval(`/160%/.test(document.querySelector('[data-pet-size-label]')?.textContent || '')`), 'label 160');
    await _waitMs(600);
    await shotPet('02-size-160');
    await shotMain('03-settings-size-slider');
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hub-pet.json'), 'utf8'));
    assert.equal(saved.scale, 1.6);
    result.checks.push('设置页滑块拖到 160%：拖动中桌宠就变大（窗口高 430），脚的位置不动、还贴着右边；松手记进设置');
    await checkOverlays(160);
    await slide(60, true);
    await waitFor(async () => (await debug({ op: 'state' })).scale === 0.6, 'scale 0.6');
    await _waitMs(500);
    await shotPet('04-size-60');
    const small = await debug({ op: 'state' });
    near(small.bounds.height, 340, '窗口高');
    near(small.bounds.x + small.bounds.width - small.inset.right, area.x + area.width, '缩小后也贴着右边');
    result.checks.push('滑到 60%：窗口回到原高度，身体缩小后仍贴右边');
    await checkOverlays(60);
    // 每小时最多开口 3 次：第 4 条直接进小圆点（万一还是冒了气泡，8 秒后也会收进去）
    await debug({ op: 'notice', notice: { id: 'e2e-size-dot-' + Date.now(), kind: 'awaiting-reply', title: '组员 B 等你回复' } });
    await waitFor(async () => (await pet.eval('window.__hubPetDebug().dots')) >= 1, '小圆点', 15000);
    await _waitMs(500);
    inScreen(await debug({ op: 'state' }), await rectsOf({ dot: '#dot' }), '60% 贴右边');
    await shotPet('07-dot-60');
    result.checks.push('60% 贴右边：小圆点也在屏幕里且点得到');
    await main.eval(`document.querySelector('[data-pet="sizeReset"]').click()`);
    await waitFor(async () => (await debug({ op: 'state' })).scale === 1, 'reset scale');
    result.checks.push('「原大小」一键回到 100%');
    result.passed = true;
  } finally {
    try { pet?.close?.(); } catch {}
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    fs.writeFileSync(path.join(OUT, `${stamp}-hub-pet-size-edges-${SEAT}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
