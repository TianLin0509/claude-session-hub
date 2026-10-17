'use strict';
// 桌宠不能抢「进程主窗口」（2026-10-17，公司 CI 39030602842：MainWindowTitle 读成「AI Hub 桌宠」）。
// 真实启动隔离 Hub（主窗口在后台显示、桌宠开着），用 Windows 自己的 Get-Process 读主窗口标题：
// 必须是 Hub 主窗口（带 PID 和版本），桌宠照常可见；Hub 主窗口最小化后桌宠仍在桌面上。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-mainwin-'));
const DATA_DIR = path.join(ROOT, 'data');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function mainWindowTitle(pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).MainWindowTitle`], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return ''; }
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle' }));
  let hub = null, main = null;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: await freePort(), label: 'hub-pet-mainwin', windowMode: 'background',
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1' } });
    main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    const debug = req => main.eval('require("electron").ipcRenderer.invoke("hub-pet:debug", ' + JSON.stringify(req) + ')');
    let state = null;
    for (let i = 0; i < 80 && !(state && state.visible); i += 1) { state = await debug({ op: 'state' }).catch(() => null); await sleep(250); }
    assert.ok(state && state.visible, '桌宠窗口要可见');
    const pid = hub.pid || hub.child?.pid;
    let title = '';
    for (let i = 0; i < 20 && !/PID/.test(title); i += 1) { title = mainWindowTitle(pid); await sleep(250); }
    console.log('MainWindowTitle:', title);
    assert.doesNotMatch(title, /桌宠/, '进程主窗口不能是桌宠');
    assert.match(title, new RegExp(`PID ${pid}`), '进程主窗口是带 PID 的 Hub 主窗口');
    console.log('✓ Get-Process 读到的主窗口是 Hub 主窗口，桌宠可见');
    await main.eval('require("electron").ipcRenderer.invoke("window:minimize").catch(() => null)');
    await sleep(800);
    const after = await debug({ op: 'state' });
    assert.ok(after && after.visible, 'Hub 主窗口最小化后桌宠仍可见');
    console.log('✓ 主窗口最小化后桌宠仍在');
  } finally {
    try { main?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => console.error('quit', e.message));
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
