'use strict';
// Main-process load + profile harness (2026-10-11).
//
// Isolated Hub with a production-sized sidebar (a sanitized read-only copy of a
// state.json passed via --state) and N CodeAgent sessions driven by the
// full-screen TUI stand-in (~24 chunks/s each). While the load runs it records,
// for --secs seconds: main-process CPU and working set every second, renderer
// -> main ipcRenderer.invoke round trips every 100 ms, and a main-process V8
// CPU profile + event-loop stalls (core/main-cpu-profiler.js).
//
//   node tests/perf-main-process-load.js --state <copy of state.json> [--sessions 8] [--secs 60] [--warmup 20] [--out <dir>] [--label before]
//
// Never point --state at a live Hub's file: it is copied into the isolated data
// directory, but the copy step reads it while that Hub may be writing.
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path');
const { spawn } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const N = Number(arg('--sessions', 8)), SECS = Number(arg('--secs', 60)), WARMUP = Number(arg('--warmup', 20));
const LABEL = arg('--label', 'run');
const statePath = arg('--state');
const outDir = path.resolve(arg('--out', path.join(os.tmpdir(), 'hub-main-perf')));
fs.mkdirSync(outDir, { recursive: true });
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-tui-standin', 'codeagent.cmd');

function sanitizeState(src, dst) {
  const state = JSON.parse(fs.readFileSync(src, 'utf8'));
  state.cleanShutdown = true;
  // Dormant sidebar entries only: nothing may look live or pending.
  for (const s of state.sessions || []) {
    s.status = 'dormant';
    s.runStartedAt = null;
    s.needsUserInput = false;
  }
  fs.writeFileSync(dst, JSON.stringify(state));
  return { sessions: (state.sessions || []).length, meetings: (state.meetings || []).length };
}

// One PowerShell process samples the main PID once a second (no per-sample spawn).
function startProcessSampler(pid, seconds) {
  const script = `$p=${pid}; for($i=0;$i -le ${seconds};$i++){ $x=Get-Process -Id $p -ErrorAction SilentlyContinue; if(-not $x){break}; `
    + `[Console]::Out.WriteLine(('{0}|{1}|{2}|{3}' -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(),$x.TotalProcessorTime.TotalMilliseconds,$x.WorkingSet64,$x.PrivateMemorySize64)); Start-Sleep -Milliseconds 1000 }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const rows = [];
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const [at, cpuMs, ws, priv] = line.split('|').map(Number);
      if (at) rows.push({ at, cpuMs, ws, priv });
    }
  });
  return { done: new Promise(r => child.on('exit', r)), rows };
}

const RTT_START = `(() => { const r = window.__ipcRtt = { samples: [], stop: false };
  const loop = async () => { while (!r.stop) { const t = performance.now(); try { await ipcRenderer.invoke('is-window-focused'); } catch {} r.samples.push(performance.now() - t); await new Promise(f => setTimeout(f, 100)); } };
  loop(); return 1; })()`;
const RTT_STOP = `(() => { const r = window.__ipcRtt; r.stop = true; return r.samples; })()`;

// Chromium trace of every process (browser main thread included) via the browser CDP target.
async function captureBrowserTrace(wsUrl, secs, file) {
  const WebSocket = require('ws');
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map(); const events = [];
  let complete;
  const completed = new Promise(r => { complete = r; });
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); else if (m.method === 'Tracing.tracingComplete') complete(); });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const r = await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordContinuously', includedCategories: ['toplevel', 'ipc', 'mojom', 'electron', 'node', 'v8', 'base', 'benchmark', 'disabled-by-default-devtools.timeline', 'devtools.timeline', 'toplevel.flow', 'gpu', 'cc', 'viz', 'ui', 'views', 'input'] } });
  if (r.error) { console.warn('trace start failed', r.error); ws.close(); return; }
  await sleep(secs * 1000);
  await send('Tracing.end');
  await Promise.race([completed, sleep(30000)]);
  ws.close();
  fs.writeFileSync(file, JSON.stringify({ traceEvents: events }));
  console.log('trace', file, events.length);
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

async function main() {
  if (!statePath) throw new Error('--state <copy of state.json> required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-main-perf-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const stateInfo = sanitizeState(statePath, path.join(dataDir, 'state.json'));
  const cac = path.join(root, '.cac'), work = path.join(root, 'work'), empty = path.join(root, 'empty');
  const fakeHome = path.join(root, 'userprofile');
  for (const d of [cac, work, empty, fakeHome, path.join(root, 'codex-home'), path.join(root, 'claude-config'), path.join(root, 'kimi-home')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  const trigger = path.join(root, 'profile.trigger');
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'main-perf ' + LABEL, ...(arg('--entry') ? { entryPath: path.resolve(arg('--entry')) } : {}), extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      CODEX_HOME: path.join(root, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), KIMI_CODE_HOME: path.join(root, 'kimi-home'),
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: empty,
      // Account pollers resolve ~/.codex etc. from os.homedir() (not CODEX_HOME):
      // give the test Hub its own empty profile so no poller can read or write
      // the real ~/.codex / ~/.claude.
      USERPROFILE: fakeHome, HOME: fakeHome,
      HUB_MAIN_CPU_PROFILE: String(SECS), HUB_MAIN_CPU_PROFILE_TRIGGER: trigger,
    } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function" && sessions.size > 0').catch(() => false)); i++) await sleep(400);
    const sidebar = await c.eval('sessions.size');
    const ids = [];
    for (let i = 0; i < N; i++) {
      const s = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`);
      ids.push(s.id); await sleep(800);
    }
    await c.eval(`selectSession(${j(ids[0])})`); await sleep(500);
    await c.eval(`applyViewMode('pty')`).catch(() => {});
    console.log(`[${LABEL}] sidebar=${sidebar} live=${ids.length}; warmup ${WARMUP}s`);
    await sleep(WARMUP * 1000);

    const ringFill = async () => (await c.eval(`Promise.all(${j(ids)}.map(id => ipcRenderer.invoke('debug:get-session-buffer', id).then(b => (b || '').length)))`)).map(n => Math.round(n / 1024) + 'K').join(',');
    console.log(`[${LABEL}] ring buffer chars before window: ${await ringFill()}`);
    await c.eval(RTT_START);
    const sampler = startProcessSampler(hub.pid, SECS + 1);
    fs.writeFileSync(trigger, '1');
    const threadsScript = arg('--threads-ps1');
    let threadsOut = null;
    if (threadsScript) {
      const t = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', threadsScript, '-ProcessId', String(hub.pid), '-Seconds', String(Math.min(SECS, 30))], { windowsHide: true });
      threadsOut = ''; t.stdout.on('data', d => { threadsOut += d; });
    }
    await sleep(SECS * 1000 + 1500);
    if (threadsOut != null) console.log(threadsOut);
    const traceSecs = Number(arg('--trace-secs', 0));
    if (traceSecs > 0) await captureBrowserTrace(hub.cdpUrl, traceSecs, path.join(outDir, `${LABEL}-${Date.now()}.trace.json`));
    const rtt = await c.eval(RTT_STOP);
    console.log(`[${LABEL}] ring buffer chars after window: ${await ringFill()}`);
    await sampler.done;

    // Wait for the profiler to write its files.
    const diag = path.join(dataDir, 'diagnostics');
    let profileFiles = [];
    for (let i = 0; i < 40 && profileFiles.length < 2; i++) {
      await sleep(500);
      try { profileFiles = fs.readdirSync(diag).filter(f => f.startsWith('main-cpu-profile-')); } catch {}
    }
    const cpuSeries = [];
    for (let i = 1; i < sampler.rows.length; i++) {
      const a = sampler.rows[i - 1], b = sampler.rows[i];
      cpuSeries.push((b.cpuMs - a.cpuMs) / (b.at - a.at) * 100);
    }
    const rows = sampler.rows;
    const avgCpu = rows.length > 1 ? (rows.at(-1).cpuMs - rows[0].cpuMs) / (rows.at(-1).at - rows[0].at) * 100 : null;
    const summary = {
      label: LABEL, sessions: N, secs: SECS, stateInfo, sidebar,
      mainCpu: { avgPct: r1(avgCpu), peakPct: r1(Math.max(...cpuSeries)), p95Pct: r1(pct(cpuSeries, 95)) },
      memory: { wsStartMB: r1(rows[0]?.ws / 1048576), wsEndMB: r1(rows.at(-1)?.ws / 1048576), privEndMB: r1(rows.at(-1)?.priv / 1048576) },
      ipcRtt: { n: rtt.length, p50: r1(pct(rtt, 50)), p95: r1(pct(rtt, 95)), p99: r1(pct(rtt, 99)), max: r1(Math.max(...rtt)), over50: rtt.filter(v => v > 50).length },
    };
    const meta = profileFiles.find(f => f.endsWith('.json'));
    const prof = profileFiles.find(f => f.endsWith('.cpuprofile'));
    if (meta) {
      const m = JSON.parse(fs.readFileSync(path.join(diag, meta), 'utf8'));
      const win = (m.spawns || []).filter(x => x.at >= m.startedAt);
      // Profiler.start itself blocks Main briefly; ignore the first second.
      const realStalls = m.stallsOver50ms.filter(x => x.at - m.startedAt > 1000);
      summary.profiler = { cpuPercentOfOneCore: m.cpuPercentOfOneCore, stalls: realStalls.length, maxStallMs: Math.max(0, ...realStalls.map(s => s.lagMs)), loopDelay: m.loopDelay, spawns: win.length, spawnMaxMs: Math.max(0, ...win.map(x => x.ms)), spawnTotalMs: r1(win.reduce((a, x) => a + x.ms, 0)), bootSpawns: (m.spawns || []).filter(x => x.at < m.startedAt).map(x => `${path.basename(x.file)} home=${x.userProfile} codex=${x.codexHome}`), heapUsedMB: r1(m.memoryEnd.heapUsed / 1048576), rssMB: r1(m.memoryEnd.rss / 1048576), externalMB: r1(m.memoryEnd.external / 1048576) };
    }
    const stamp = `${LABEL}-${Date.now()}`;
    if (prof) fs.copyFileSync(path.join(diag, prof), path.join(outDir, `${stamp}.cpuprofile`));
    if (meta) fs.copyFileSync(path.join(diag, meta), path.join(outDir, `${stamp}.profile.json`));
    fs.writeFileSync(path.join(outDir, `${stamp}.summary.json`), j({ summary, cpuSeries, rtt }, null, 1));
    console.log('SUMMARY', j(summary));
  } catch (error) {
    if (hub) console.error('hub log tail:\n' + hub.log().slice(-40).join('\n'));
    throw error;
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => console.warn('quit:', e.message));
    // The copied state.json is user data: never leave it behind.
    try { fs.rmSync(path.join(dataDir, 'state.json'), { force: true }); } catch {}
    // Only remove the temp tree when it holds no links/junctions that a recursive delete could follow.
    const links = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isSymbolicLink()) links.push(p); else if (e.isDirectory()) walk(p); } };
    try { walk(root); } catch {}
    if (links.length) console.warn('cleanup skipped, links present:', links.slice(0, 5));
    else try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.warn('cleanup:', e.message); }
  }
}
main().catch(e => { console.error(e); if (e.logTail) console.error(e.logTail); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 500));
