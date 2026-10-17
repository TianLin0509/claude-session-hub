'use strict';
// 助理桌宠端到端（隔离 Hub，独立数据目录与 CDP 端口，主窗口隐藏，只有桌宠小窗显示）。
// 验证：桌宠出现、发假提醒后欢呼 + 气泡、8 秒收成小圆点、点宠物打开助理入口、模拟拖动的惯性与贴边、
// 全屏躲边、助理忙敲键盘、离开打盹、不可见时停帧、125%/150% 缩放截图、空闲 CPU、配置页开关。
// 产物写 output/e2e-hub-pet/：逐帧 PNG（透明底）、results.json；GIF 由 scripts 外的 Python 合成。
// 用法：node tests/e2e-hub-pet-cdp.js [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'output', 'e2e-hub-pet'));
const STAMP = Date.now();
const ROOT_TMP = path.join(process.env.TEMP || os.tmpdir(), 'hub-pet-e2e-' + STAMP);
const DATA_DIR = path.join(ROOT_TMP, 'data');
const HOME_DIR = path.join(ROOT_TMP, 'home');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs = 20000, stepMs = 150, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await _waitMs(stepMs);
  }
  throw new Error('timeout waiting for ' + label + ': ' + (last && last.message ? last.message : JSON.stringify(last)));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle' }));
  const results = { startedAt: new Date().toISOString(), checks: {} };
  const port = await freePort();
  let hub = null;
  let main = null;
  let pet = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port, label: 'hub-pet', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_HOME_DIR: HOME_DIR, DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1' },
    });
    main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    const petTarget = await waitFor(async () => (await listCdpTargets(hub)).find(t => t.type === 'page' && /hub-pet[\\/]pet\.html/i.test(t.url || '')), { label: 'pet target' });
    pet = await connectCDP(petTarget.webSocketDebuggerUrl);
    const debug = (req) => main.eval('require("electron").ipcRenderer.invoke("hub-pet:debug", ' + JSON.stringify(req) + ')');
    const petState = () => pet.eval('window.__hubPetDebug && window.__hubPetDebug()');

    // ---------- 截帧工具：screencast 拿合成器真实产出的每一帧 ----------
    await pet.send('Page.enable');
    await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    async function record(name, ms, action) {
      const dir = path.join(OUT, name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const frames = [];
      const onMsg = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method !== 'Page.screencastFrame') return;
        frames.push({ t: msg.params.metadata.timestamp, data: msg.params.data });
        pet.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
      };
      pet.ws.on('message', onMsg);
      await pet.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      // 页面内测帧间隔：只读 rAF 时间戳，不改任何东西
      await pet.eval('window.__gaps = []; window.__stopGaps = false; window.__lastT = 0; (function f(t){ if (window.__lastT) window.__gaps.push(t - window.__lastT); window.__lastT = t; if (window.__gaps.length < 2000 && !window.__stopGaps) requestAnimationFrame(f); })(performance.now()); true');
      if (action) await action();
      await _waitMs(ms);
      await pet.eval('window.__stopGaps = true; window.__lastT = 0; true');
      const gaps = await pet.eval('window.__gaps');
      await pet.send('Page.stopScreencast');
      pet.ws.off('message', onMsg);
      frames.forEach((f, i) => fs.writeFileSync(path.join(dir, String(i).padStart(3, '0') + '.png'), Buffer.from(f.data, 'base64')));
      const times = frames.map(f => f.t);
      const sorted = gaps.slice().sort((a, b) => a - b);
      const stat = {
        frames: frames.length,
        spanMs: times.length > 1 ? Math.round((times[times.length - 1] - times[0]) * 1000) : 0,
        rafFrames: gaps.length,
        rafMedianMs: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : null,
        rafP95Ms: sorted.length ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(1) : null,
        rafMaxMs: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
        timestamps: times.map(t => Math.round((t - times[0]) * 1000)),
      };
      fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(stat, null, 1));
      return stat;
    }
    async function shot(name, scale = 1) {
      if (scale !== 1) await pet.send('Emulation.setDeviceMetricsOverride', { width: 280, height: 340, deviceScaleFactor: scale, mobile: false });
      await _waitMs(400);
      const r = await pet.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
      if (scale !== 1) await pet.send('Emulation.clearDeviceMetricsOverride');
    }

    // 1. 出现
    const st0 = await waitFor(async () => { const s = await debug({ op: 'state' }); return s && s.visible && s.lastSent ? s : null; }, { label: 'pet visible' });
    results.checks.appear = { visible: st0.visible, bounds: st0.bounds, pose: st0.lastSent.pose, fullscreenWatch: st0.fullscreenWatch };
    // 夜里跑测试时桌宠会按规则打盹；把它的「现在」挪到当天上午 10 点再测白天的行为。
    const ten = new Date(); ten.setHours(10, 0, 0, 0);
    await debug({ op: 'override', nowShift: ten.getTime() - Date.now(), idleSec: 0 });
    await waitFor(async () => { const s = await petState(); return s.pose === 'idle' && s.layers.length === 1 ? s : null; }, { label: 'idle with one layer' });
    await shot('01-idle');
    results.checks.idleBreath = await record('rec-idle-breath', 2500);

    // 2. 假提醒 → 欢呼 + 气泡
    const notice = { id: 'e2e-brief-' + STAMP, kind: 'brief', title: '早上好！今天 3 个会，组员 B 等你 14 小时了', text: '完整简报：\n1. 09:30 L2 调度周会\n2. 14:00 评审（材料 v3）\n3. 16:30 项目例会' };
    results.checks.happy = await record('rec-notice-happy', 1800, () => debug({ op: 'notice', notice }));
    const sHappy = await petState();
    assert.equal(sHappy.pose, 'happy');
    assert.equal(sHappy.bubble, notice.id);
    await shot('02-bubble');

    // 3. 8 秒后收成小圆点
    await waitFor(async () => { const s = await petState(); return s.dots === 1 && !s.bubble ? s : null; }, { timeoutMs: 12000, label: 'bubble collapsed to dot' });
    await shot('03-dot');
    results.checks.dot = await petState();

    // 4. 点宠物 → Hub 收到打开助理的事件（无移动的按下抬起 = 点击）
    await main.eval('window.__petOpen = null; window.addEventListener("hub-pet:open-assistant", e => { window.__petOpen = e.detail; }, { once: true }); true');
    const b = (await debug({ op: 'state' })).bounds;
    await debug({ op: 'cursor', pos: { x: b.x + 140, y: b.y + 260 } });
    await debug({ op: 'press', target: 'pet' });
    await _waitMs(120);
    await debug({ op: 'release' });
    results.checks.openAssistant = await waitFor(() => main.eval('window.__petOpen'), { label: 'open-assistant event' });

    // 5. 模拟拖动：快速往左甩，松手后惯性滑行，再落地回弹
    const start = (await debug({ op: 'state' })).bounds;
    const cx = start.x + 140, cy = start.y + 260;
    await debug({ op: 'cursor', pos: { x: cx, y: cy } });
    results.checks.drag = await record('rec-drag-throw', 2200, async () => {
      // 在主窗口页面里连续发，避免测试进程到 Hub 的往返延迟把「快甩」变成「慢拖」
      await main.eval(`(async () => {
        const ipc = require('electron').ipcRenderer;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        await ipc.invoke('hub-pet:debug', { op: 'press', target: 'pet' });
        for (let i = 1; i <= 8; i++) { await ipc.invoke('hub-pet:debug', { op: 'cursor', pos: { x: ${cx} - i * 50, y: ${cy} - i * 16 } }); await sleep(16); }
        await ipc.invoke('hub-pet:debug', { op: 'release' });
        return true;
      })()`);
    });
    await _waitMs(400);
    const after = (await debug({ op: 'state' })).bounds;
    results.checks.drag.moved = { from: { x: start.x, y: start.y }, to: { x: after.x, y: after.y } };
    results.checks.drag.release = (await debug({ op: 'state' })).lastRelease;
    assert.ok(after.x < start.x - 8 * 50, '松手后继续滑了一段：' + JSON.stringify(results.checks.drag.release));
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hub-pet.json'), 'utf8'));
    assert.deepEqual(saved.position, { x: after.x, y: after.y }, '位置写盘');
    await debug({ op: 'cursor', pos: null });

    // 6. 全屏 → 躲边探头；退出后回原位
    results.checks.peekIn = await record('rec-peek-in', 1600, () => debug({ op: 'override', fullscreen: true }));
    const peekState = await debug({ op: 'state' });
    assert.equal(peekState.lastSent.pose, 'peek');
    await shot('04-peek');
    results.checks.peek = { bounds: peekState.bounds };
    results.checks.peekOut = await record('rec-peek-out', 1600, () => debug({ op: 'override', fullscreen: false }));
    const back = (await debug({ op: 'state' })).bounds;
    assert.equal(back.x, after.x);

    // 7. 助理忙 → 敲键盘
    results.checks.typing = await record('rec-typing', 2000, () => debug({ op: 'override', busy: true }));
    results.checks.typingLayers = await petState();
    assert.equal(results.checks.typingLayers.pose, 'typing');
    assert.equal(results.checks.typingLayers.domLayers, 1, '敲键盘时只剩一层，旧姿态已淡出移除');
    await shot('05-typing');
    await debug({ op: 'override', busy: false });

    // 8. 离开 10 分钟 → 犯困、点头、睡着
    results.checks.sleep = await record('rec-nod-off', 5600, () => debug({ op: 'override', idleSec: 700 }));
    assert.equal((await petState()).pose, 'sleep');
    await shot('06-sleep');
    results.checks.wake = await record('rec-wake-stretch', 2400, () => debug({ op: 'override', idleSec: 0 }));
    await _waitMs(800);

    // 9. 缩放：125% / 150% 截图看清晰度
    await shot('07-idle-125', 1.25);
    await shot('08-idle-150', 1.5);

    // 10. 不可见时停帧
    await debug({ op: 'hide' });
    const hiddenState = await waitFor(async () => { const s = await petState(); return s.fps === 'stopped' ? s : null; }, { timeoutMs: 5000, label: 'stopped when hidden' });
    results.checks.hiddenStopsFrames = hiddenState.fps;
    await debug({ op: 'show' });
    await waitFor(async () => (await petState()).fps !== 'stopped', { timeoutMs: 5000, label: 'resumes when shown' });

    // 11. 空闲 CPU（待机呼吸 + 偶尔小动作）：两次取样间隔 20 秒
    await pet.send('Page.stopScreencast').catch(() => {});
    await _waitMs(3000);
    await debug({ op: 'metrics' });
    await _waitMs(20000);
    const metrics = await debug({ op: 'metrics' });
    results.checks.idleCpu = metrics;

    // 12. 配置页：开关能关掉桌宠
    const cfg = await main.eval('require("electron").ipcRenderer.invoke("hub-pet:get-settings")');
    results.checks.settingsSection = await main.eval('!!document.getElementById("cfg-hub-pet") && !document.getElementById("cfg-hub-pet").hidden');
    assert.equal(cfg.settings.enabled, true);
    await main.eval('(() => { const el = document.getElementById("cfg-hub-pet-enabled"); el.checked = false; el.dispatchEvent(new Event("change")); return true; })()');
    const off = await waitFor(async () => { const s = await debug({ op: 'state' }); return s && !s.visible ? s : null; }, { label: 'pet closed by setting' });
    results.checks.settingsOff = { visible: off.visible };
    results.ok = true;
  } catch (error) {
    results.ok = false;
    results.error = error && (error.stack || error.message);
    throw error;
  } finally {
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
    try { await pet?.close(); } catch (_) {}
    try { await main?.close(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(error => console.warn('quit', error.message));
  }
  console.log('PASS hub pet e2e →', OUT);
}

main().catch(error => { console.error('FAIL', error && (error.stack || error.message)); process.exit(1); });
