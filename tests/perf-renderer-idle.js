'use strict';
// 界面进程「空转」开销取证（2026-10-11）：隔离 Hub + N 个持续输出的 CodeAgent 替身会话，停在卡片视图，
// 按条件各测一段：页面 TaskDuration / 样式重算次数 / 布局次数 / 脚本耗时，以及界面与 GPU 进程 CPU。
//   node tests/perf-renderer-idle.js [--sessions 3] [--secs 15] [--view card|pty] [--gpu on|off]
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const N = Number(arg('--sessions', 3)), SECS = Number(arg('--secs', 15)), VIEW = arg('--view', 'card');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-tui-standin', 'codeagent.cmd');
let hub, c;
process.env.HUB_E2E_SHOW_WINDOWS = '1';
const WIN32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);'`;
const ps = script => String(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout || '').trim();
function cpu() {
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime+$_.UserModeTime),($_.CommandLine -replace '\\|',' ') }";
  const rows = String(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout || '')
    .split(/\r?\n/).map(l => { const [pid, ppid, t, ...rest] = l.split('|'); return { pid: +pid, ppid: +ppid, t: +t / 1e7, cmd: rest.join('|') }; }).filter(x => x.pid);
  const ids = new Set([hub.pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (!ids.has(x.pid) && ids.has(x.ppid)) { ids.add(x.pid); grew = true; } }
  const g = {}; for (const x of rows) if (ids.has(x.pid)) { const type = (x.cmd.match(/--type=([a-z-]+)/) || [])[1]; const k = x.pid === hub.pid ? 'main' : type === 'renderer' ? 'renderer' : type === 'gpu-process' ? 'gpu' : null; if (k) g[k] = (g[k] || 0) + x.t; }
  return { at: Date.now(), g };
}
async function measure(label, setup = '', teardown = '') {
  if (setup) await c.eval(setup);
  await sleep(1500);
  await c.send('Performance.enable');
  const m = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  if (argv.includes('--fps')) await c.eval(`(() => { window.__fr = 0; if (!window.__frOn) { window.__frOn = 1; const t = () => { window.__fr++; requestAnimationFrame(t); }; requestAnimationFrame(t); } return 1; })()`);
  const a = await m(); const ca = cpu();
  await sleep(SECS * 1000);
  const b = await m(); const cb = cpu(); const fps = argv.includes('--fps') ? Math.round(await c.eval('window.__fr') / SECS) : '-'; const animN = await c.eval(`document.getAnimations().filter(a => a.playState === 'running').length`); const dt = (cb.at - ca.at) / 1000;
  const pct = k => Math.round(((cb.g[k] || 0) - (ca.g[k] || 0)) / dt * 100);
  const row = { label, taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000 / SECS), scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000 / SECS),
    styleMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000 / SECS), styleN: Math.round((b.RecalcStyleCount - a.RecalcStyleCount) / SECS),
    layoutN: Math.round((b.LayoutCount - a.LayoutCount) / SECS), fps, animN, renderer: pct('renderer'), gpu: pct('gpu'), main: pct('main') };
  console.log(`${label.padEnd(28)} task ${row.taskMs}ms/s script ${row.scriptMs}ms/s style ${row.styleMs}ms/s (${row.styleN}/s) layout ${row.layoutN}/s fps ${row.fps} anims ${row.animN} | renderer ${row.renderer}% gpu ${row.gpu}% main ${row.main}%`);
  if (argv.includes('--trace')) await traceStyle(label);
  if (argv.includes('--profile')) await profileCallers(label, '_measure');
  if (teardown) await c.eval(teardown);
  return row;
}
async function profileCallers(label, fn) {
  await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 200 }); await c.send('Profiler.start');
  await sleep(3000); const { profile } = await c.send('Profiler.stop');
  const byId = new Map(profile.nodes.map(n => [n.id, n])); const parent = new Map();
  for (const n of profile.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
  const hits = new Map(); profile.samples.forEach((id, i) => {
    let cur = id; const chain = []; let found = false;
    while (cur != null) { const cf = byId.get(cur).callFrame; const name = (cf.functionName || '(anon)') + '@' + String(cf.url).split(/[\/]/).pop() + ':' + cf.lineNumber + ':' + cf.columnNumber; if (cf.functionName === fn) found = true; if (found) chain.push(name); cur = parent.get(cur); }
    if (found) { const k = chain.slice(0, 14).join(' < '); hits.set(k, (hits.get(k) || 0) + (profile.timeDeltas[i] || 0)); } });
  console.log('callers of', fn, 'in', label);
  for (const [k, us] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log('  ' + Math.round(us / 1000) + 'ms ' + k);
}
async function traceStyle(label) {
  const events = [];
  const onMsg = data => { try { const m = JSON.parse(String(data)); if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); } catch {} };
  c.ws.on('message', onMsg);
  const done = new Promise(r => { const h = data => { try { if (JSON.parse(String(data)).method === 'Tracing.tracingComplete') { c.ws.off('message', h); r(); } } catch {} }; c.ws.on('message', h); });
  await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.animations', transferMode: 'ReportEvents' });
  await sleep(2000); await c.send('Tracing.end'); await done; c.ws.off('message', onMsg);
  const names = {}; for (const e of events) if (e.ph === 'X' || e.ph === 'B') names[e.name] = (names[e.name] || 0) + 1;
  console.log('trace', label, Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => k + '=' + v).join(' '));
  const stacks = {};
  for (const e of events) if (/UpdateLayoutTree|RecalculateStyles/.test(e.name)) { const st = (e.args && (e.args.beginData || e.args.data || {}).stackTrace) || []; const k = st.slice(0, 9).map(f => (f.functionName || '?') + '@' + String(f.url).split(/[\/]/).pop() + ':' + f.lineNumber).join(' < ') || '(no js stack)'; stacks[k] = (stacks[k] || 0) + 1; }
  console.log(Object.entries(stacks).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => '  ' + v + ' ' + k).join(String.fromCharCode(10)));
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-perf-'));
  const cac = path.join(root, '.cac'), work = path.join(root, 'work'); for (const d of [cac, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'visible', label: 'perf idle', extraEnv: {
    AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
    HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), ...(arg('--gpu', 'on') === 'off' ? { AI_HUB_DISABLE_GPU: '1' } : {}) } });
  c = await connectFirstPage(hub);
  for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
  let hwnd = '0'; for (let i = 0; i < 30 && hwnd === '0'; i++) { hwnd = ps(`(Get-Process -Id ${hub.pid}).MainWindowHandle.ToInt64()`) || '0'; if (hwnd === '0') await sleep(500); }
  ps(`${WIN32}; [W.U]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]::Zero, 0, 0, 1600, 950, 0x14) | Out-Null`);
  const ids = [];
  for (let i = 0; i < N; i++) { const s = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`); ids.push(s.id); await sleep(1200); }
  await sleep(5000);
  await c.eval(`selectSession(${j(ids[0])})`); await sleep(800); await c.eval(`applyViewMode(${j(VIEW)})`); await sleep(2000);
  console.log('state', j(await c.eval(`({ vis: document.visibilityState, anims: document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName), size: innerWidth + 'x' + innerHeight })`)));
  if (arg('--probe-js')) console.log('probe setup', j(await c.eval(fs.readFileSync(arg('--probe-js'), 'utf8'))));
  const rows = [];
  rows.push(await measure('baseline'));
  rows.push(await measure('sidebar animations off', `(() => { const s = document.createElement('style'); s.id = '__perf_noanim'; s.textContent = '#session-list *{animation:none !important}'; document.head.appendChild(s); return 1; })()`, `document.getElementById('__perf_noanim').remove(), 1`));
  const extra = arg('--extra-css'); if (extra) rows.push(await measure('extra css', `(() => { const s = document.createElement('style'); s.id = '__perf_extra'; s.textContent = ${j(extra)}; document.head.appendChild(s); return 1; })()`, `document.getElementById('__perf_extra').remove(), 1`));
  if (arg('--probe-read')) console.log('probe', await c.eval(fs.readFileSync(arg('--probe-read'), 'utf8')));
  const out = path.resolve(arg('--out', 'artifacts/20261011-backstage-render-claude1')); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `perf-idle-${Date.now()}.json`), j({ N, SECS, VIEW, rows }, null, 1));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { c && c.close(); } catch {} if (hub) await gracefulQuit(hub).catch(() => {}); setTimeout(() => process.exit(), 500); });
