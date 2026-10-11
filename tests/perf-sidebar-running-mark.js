'use strict';
// 侧栏「运行中」标记的开销与外观取证（2026-10-11）：隔离 Hub + 受控状态样例（运行中 ×3、群聊有人在干活、
// 等你响应、异常、休眠、就绪），列出页面上一直在动的元素，测界面 / GPU 进程 CPU 与每秒出帧，并截侧栏图。
//   node tests/perf-sidebar-running-mark.js [--secs 10] [--out <目录>] [--label before|after] [--reduced-motion]
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, waitFor } = require('./helpers/usage-refresh-fixture');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SECS = Number(arg('--secs', 10)), LABEL = arg('--label', 'run');
const OUT = path.resolve(arg('--out', path.join('artifacts', '20261011-static-running-mark-claude1')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let hub, c;

function cpuByType() {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime+$_.UserModeTime),($_.CommandLine -replace '\\|',' ') }";
  const rows = String(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout || '')
    .split(/\r?\n/).map(l => { const [pid, ppid, t, ...rest] = l.split('|'); return { pid: +pid, ppid: +ppid, t: +t / 1e7, cmd: rest.join('|') }; }).filter(x => x.pid);
  const ids = new Set([hub.pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (!ids.has(x.pid) && ids.has(x.ppid)) { ids.add(x.pid); grew = true; } }
  const g = {};
  for (const x of rows) if (ids.has(x.pid)) {
    const type = (x.cmd.match(/--type=([a-z-]+)/) || [])[1];
    const k = type === 'renderer' ? 'renderer' : type === 'gpu-process' ? 'gpu' : null;
    if (k) g[k] = (g[k] || 0) + x.t;
  }
  return { at: Date.now(), g };
}

const RUNNING_ANIMS = `(() => [...document.querySelectorAll('body *')].filter(el => {
  const cs = getComputedStyle(el); return cs.animationName !== 'none' && cs.animationIterationCount === 'infinite' && el.getClientRects().length;
}).map(el => (el.closest('[data-session-id],[data-meeting-id]') ? 'sidebar ' : '') + el.tagName.toLowerCase() + '.' + String(el.getAttribute('class') || '').trim().split(/\\s+/).join('.') + ' → ' + getComputedStyle(el).animationName))()`;

async function measure() {
  await c.eval(`(() => { window.__fr = 0; if (!window.__frOn) { window.__frOn = 1; const t = () => { window.__fr++; requestAnimationFrame(t); }; requestAnimationFrame(t); } return 1; })()`);
  const a = cpuByType(); const f0 = await c.eval('window.__fr');
  await sleep(SECS * 1000);
  const b = cpuByType(); const f1 = await c.eval('window.__fr'); const dt = (b.at - a.at) / 1000;
  const pct = k => Math.round(((b.g[k] || 0) - (a.g[k] || 0)) / dt * 100);
  return { renderer: pct('renderer'), gpu: pct('gpu'), fps: Math.round((f1 - f0) / SECS) };
}

async function shotSidebar(name) {
  const rect = await c.eval(`(() => { const r = document.querySelector('#session-sidebar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: Math.min(r.height, 420) }; })()`);
  const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 2 } });
  const file = path.join(OUT, `${LABEL}-${name}.png`); fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); return file;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-running-mark-'));
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await getFreePort(), windowMode: 'visible', label: 'running mark',
    extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
  c = await connectFirstPage(hub); await waitFor(c, '!!window.__hubE2E', 60000);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  // 默认按「系统开着动画效果」测（公司电脑多为此设置）；--reduced-motion 时按系统关动画测。
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: argv.includes('--reduced-motion') ? 'reduce' : 'no-preference' }] });
  const now = Date.now();
  await c.eval(`window.__hubE2E.addFakeSessions(${JSON.stringify([
    { id: 'run-claude', kind: 'claude', title: '运行中 · Claude 写代码', status: 'running', lastMessageTime: now },
    { id: 'run-codex', kind: 'codex', title: '运行中 · Codex 跑测试', status: 'running', lastMessageTime: now - 1000 },
    { id: 'run-gemini', kind: 'gemini', title: '运行中 · Gemini 查资料', status: 'running', lastMessageTime: now - 2000 },
    { id: 'wait-codex', kind: 'codex', title: '等你响应 · 需要确认', status: 'running', attentionState: 'needs-input', needsUserInput: true, lastMessageTime: now - 3000 },
    { id: 'err-claude', kind: 'claude', title: '运行异常 · 连接失败', status: 'failed', lastMessageTime: now - 4000 },
    { id: 'idle-kimi', kind: 'kimi', title: '就绪 · 空闲会话', status: 'idle', lastMessageTime: now - 60000 },
    { id: 'dorm-claude', kind: 'claude', title: '休眠 · 昨天的会话', status: 'dormant', lastMessageTime: now - 120000 },
    { id: 'gm-a', kind: 'claude', title: '成员 A', status: 'running', meetingId: 'g1' },
    { id: 'gm-b', kind: 'codex', title: '成员 B', status: 'idle', meetingId: 'g1' },
  ])});
  meetings['g1'] = { id: 'g1', title: '群聊 · 有成员在干活', groupChat: true, status: 'idle', subSessions: ['gm-a', 'gm-b'], participants: [0, 1], turns: [], log: [], lastMessageTime: ${now} };
  renderSessionList(); 1`);
  await sleep(1500);
  const anims = await c.eval(RUNNING_ANIMS);
  const states = await c.eval(`[...document.querySelectorAll('#session-list .session-item')].map(r => (r.dataset.sessionId || r.dataset.meetingId) + ':' + r.className.replace('session-item', '').trim() + ':' + ((r.querySelector('.sl-kind') || {}).dataset || {}).state)`);
  const sample = await c.eval(`(() => { const el = document.querySelector('[data-session-id="run-claude"] .sl-kind'); const cs = getComputedStyle(el); return { animation: cs.animationName, opacity: cs.opacity, outline: cs.outline, boxShadow: cs.boxShadow, transform: cs.transform }; })()`);
  if (arg('--eval')) console.log('eval', JSON.stringify(await c.eval(fs.readFileSync(arg('--eval'), 'utf8'))));
  const shots = [];
  for (const theme of ['dark', 'codex']) {
    await c.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); 1`); await sleep(500);
    shots.push(await shotSidebar(theme));
  }
  await c.eval(`document.documentElement.setAttribute('data-theme', 'dark'); 1`); await sleep(1500);
  const cost = await measure();
  const result = { label: LABEL, secs: SECS, cost, anims, states, sample, shots };
  fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { c && c.close(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); setTimeout(() => process.exit(), 500); });
