'use strict';
// 「点后台」的开销对照（2026-10-13）：9 月做法（终端常驻卡片下）与 10 月做法（卡片视图收起终端、点后台再重建）。
// 隔离实例、后台窗口（不抢焦点），N 个会话跑长对话替身；用真实鼠标事件点「后台」按钮来回切换，
// 每次点击记录：点击到画面更新的时间、随后 3 秒内主线程最长卡顿与长任务总时长、终端收到的字节数；
// 另外量卡片视图里静置 15 秒的进程 CPU（9 月做法的代价）。
//   node tests/perf-backstage-click.js --backstage september|october [--tui claude|opentui] [--history-kb 300]
//        [--sessions 3] [--clicks 6] [--gpu on|off] [--width 1720 --height 926] [--css "<额外样式>"] [--out <dir>]
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const BACKSTAGE = arg('--backstage', 'october'), TUI = arg('--tui', 'claude');
const N = Number(arg('--sessions', 3)), CLICKS = Number(arg('--clicks', 6)), gpuOff = arg('--gpu', 'on') === 'off';
const W = Number(arg('--width', 1720)), H = Number(arg('--height', 926));
const outDir = path.resolve(arg('--out', 'artifacts/20261013-backstage-click-claude1')); fs.mkdirSync(outDir, { recursive: true });
process.env.HUB_TEST_PRIORITY = 'normal';
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const STANDIN = TUI === 'opentui'
  ? path.join(__dirname, 'fixtures', 'codeagent-tui-standin', 'codeagent.cmd')
  : path.join(__dirname, 'fixtures', 'claude-tui-standin', 'claude.cmd');
const ps = script => String(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout || '').trim();
let hub, c;

function cpuSample() {
  const cmd = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime+$_.UserModeTime),($_.CommandLine -replace '\\|',' ') }";
  const rows = ps(cmd).split(/\r?\n/).map(l => { const [pid, ppid, cpu, ...rest] = l.split('|'); return { pid: +pid, ppid: +ppid, cpu: +cpu / 1e7, cmd: rest.join('|') }; }).filter(x => x.pid);
  const ids = new Set([hub.pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (!ids.has(x.pid) && ids.has(x.ppid)) { ids.add(x.pid); grew = true; } }
  const g = {};
  for (const x of rows) if (ids.has(x.pid)) {
    const type = (x.cmd.match(/--type=([a-z-]+)/) || [])[1];
    const k = x.pid === hub.pid ? 'main' : type === 'renderer' ? 'renderer' : type === 'gpu-process' ? 'gpu' : null;
    if (k) g[k] = (g[k] || 0) + x.cpu;
  }
  return { at: Date.now(), g };
}

// 页面内探针：100ms 定时器量主线程卡顿，longtask 观察长任务，terminal-data 计字节，点击后两帧算「画面更新」。
const PROBE = `(() => {
  const m = window.__bp = { lag: 0, longTotal: 0, longMax: 0, bytes: 0, clickAt: 0, paintMs: null };
  let last = performance.now();
  setInterval(() => { const n = performance.now(); m.lag = Math.max(m.lag, n - last - 100); last = n; }, 100);
  new PerformanceObserver(list => { for (const e of list.getEntries()) { m.longTotal += e.duration; m.longMax = Math.max(m.longMax, e.duration); } }).observe({ entryTypes: ['longtask'] });
  ipcRenderer.on('terminal-data', (_e, p) => { m.bytes += (p && p.data ? p.data.length : 0); });
  document.getElementById('btn-backstage').addEventListener('click', () => {
    m.clickAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => { m.paintMs = performance.now() - m.clickAt; }));
  }, true);
  return 1; })()`;
const RESET = `(() => { const m = window.__bp; Object.assign(m, { lag: 0, longTotal: 0, longMax: 0, bytes: 0, paintMs: null }); return 1; })()`;
const TAKE = `(() => { const m = window.__bp; return { paintMs: m.paintMs == null ? null : Math.round(m.paintMs), maxLag: Math.round(m.lag), longTotal: Math.round(m.longTotal), longMax: Math.round(m.longMax), kb: Math.round(m.bytes / 1024), view: currentView }; })()`;

async function clickBackstage() {
  const r = await c.eval(`(() => { const b = document.getElementById('btn-backstage'); if (!b || b.hidden) return null; const x = b.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; })()`);
  if (!r) throw new Error('「后台」按钮不可见');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

async function measureClick(label) {
  await c.eval(RESET);
  await clickBackstage();
  await sleep(3000);
  const v = await c.eval(TAKE);
  const row = { label, ...v };
  console.log(`${label} paint=${v.paintMs}ms maxLag=${v.maxLag}ms longTotal=${v.longTotal}ms longMax=${v.longMax}ms term=${v.kb}KB view=${v.view}`);
  return row;
}

async function idleCost(label, secs) {
  await c.eval(RESET);
  const a = cpuSample(); await sleep(secs * 1000); const b = cpuSample();
  const dt = (b.at - a.at) / 1000, pct = k => Math.round(((b.g[k] || 0) - (a.g[k] || 0)) / dt * 100);
  const v = await c.eval(TAKE);
  const row = { label, renderer: pct('renderer'), gpu: pct('gpu'), main: pct('main'), maxLag: v.maxLag, longTotal: v.longTotal };
  console.log(`${label} renderer=${row.renderer}% gpu=${row.gpu}% main=${row.main}% maxLag=${row.maxLag}ms longTotal=${row.longTotal}ms`);
  return row;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bsclick-'));
  const cac = path.join(root, '.cac'), work = path.join(root, 'work'); for (const d of [cac, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'background', label: `backstage ${BACKSTAGE}`, extraEnv: {
    AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
    AI_HUB_BACKSTAGE_PATH: BACKSTAGE, FAKE_HISTORY_KB: arg('--history-kb', '300'), ...(gpuOff ? { AI_HUB_DISABLE_GPU: '1' } : {}),
    HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
  c = await connectFirstPage(hub);
  for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
  // 窗口留在屏幕外、不激活，只把大小调成与日常使用相同（SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE）。
  // PowerShell 进程不感知 DPI，SetWindowPos 的尺寸按逻辑像素给，系统会自己乘缩放。
  let hwnd = '0';
  for (let i = 0; i < 30 && hwnd === '0'; i++) { hwnd = ps(`(Get-Process -Id ${hub.pid}).MainWindowHandle.ToInt64()`) || '0'; if (hwnd === '0') await sleep(500); }
  ps(`Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);'; [W.U]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]::Zero, 0, 0, ${W}, ${H}, 0x16) | Out-Null`);
  await sleep(1500);
  const extraCss = arg('--css', '');
  if (extraCss) await c.eval(`(() => { const s = document.createElement('style'); s.textContent = ${j(extraCss)}; document.head.appendChild(s); return 1; })()`);
  const env = await c.eval(`({ size: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio, gpuFlag: process.argv.includes('--ai-hub-gpu-disabled') })`);
  console.log('env', j({ backstage: BACKSTAGE, tui: TUI, ...env }));
  const ids = [];
  for (let i = 0; i < N; i++) { const s = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`); ids.push(s.id); await sleep(1500); }
  await sleep(8000);
  await c.eval(`selectSession(${j(ids[0])})`); await sleep(500);
  await c.eval(`applyViewMode('card')`); await sleep(2500);
  await c.eval(PROBE);
  const rows = [];
  rows.push(await idleCost('card-idle', 15));
  for (let i = 0; i < CLICKS; i++) {
    rows.push(await measureClick(`to-backstage-${i + 1}`));
    rows.push(await measureClick(`to-card-${i + 1}`));
    // 换一个会话再点，模拟在几个会话之间来回看后台。
    await c.eval(`selectSession(${j(ids[(i + 1) % ids.length])})`); await sleep(1500);
  }
  const shot = await c.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) fs.writeFileSync(path.join(outDir, `shot-${BACKSTAGE}-${TUI}.png`), Buffer.from(shot.data, 'base64'));
  const med = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const pick = (prefix, k) => rows.filter(r => r.label.startsWith(prefix)).map(r => r[k]);
  const summary = { backstage: BACKSTAGE, tui: TUI, css: arg('--css', ''), historyKb: Number(arg('--history-kb', '300')), sessions: N, clicks: CLICKS, gpuOff, env,
    idle: rows[0],
    toBackstage: { paintMedian: med(pick('to-backstage', 'paintMs')), maxLagMedian: med(pick('to-backstage', 'maxLag')), maxLagWorst: Math.max(...pick('to-backstage', 'maxLag')),
      longTotalMedian: med(pick('to-backstage', 'longTotal')), termKbMedian: med(pick('to-backstage', 'kb')) },
    toCard: { paintMedian: med(pick('to-card', 'paintMs')), maxLagMedian: med(pick('to-card', 'maxLag')), maxLagWorst: Math.max(...pick('to-card', 'maxLag')) } };
  console.log('SUMMARY', j(summary));
  fs.writeFileSync(path.join(outDir, `click-${BACKSTAGE}-${TUI}-${Date.now()}.json`), j({ summary, rows }, null, 1));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { c && c.close(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); setTimeout(() => process.exit(), 500); });
