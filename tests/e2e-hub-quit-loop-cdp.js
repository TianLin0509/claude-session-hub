'use strict';
// 反复「启动 → 正常关闭」隔离 Hub，核对每次进程都以退出码 0 干净结束、没有新的崩溃转储（2026-10-18）。
// 背景：v2.1.9 升级验收时，Hub 在自己的退出流程走完之后被 Node 平台的 V8Worker 线程打断（0x80000003），
// 转储栈：MemoryPool::ReleasePooledChunksTask → PostDelayedTask → uv_async_send → uv_fatal_error。
// 桌宠开着（公司版默认开）；可选每轮先打开一次桌宠右键菜单。
// 用法：node tests/e2e-hub-quit-loop-cdp.js [--runs 4] [--dwell-ms 1500] [--pet-menu] [--entry <Hub 目录>] [--js-flags=<V8 开关>] [--affinity-cores 1] [--dump-hangs] [--out <输出目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');

function arg(name, fallback) {
  const inline = process.argv.find(a => a.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? true : v;
}
const RUNS = Math.max(1, Number(arg('--runs', 4)) || 4);
const DWELL_MS = Math.max(0, Number(arg('--dwell-ms', 1500)) || 0);
const PET_MENU = !!arg('--pet-menu', false);
const ENTRY = arg('--entry', null);
// 诊断用：给被测 Hub 主进程加 V8 开关（例如 --js-flags=--memory-pool-timeout=0 做对照）。
const JS_FLAGS = arg('--js-flags', null);
// 放大器：把被测 Hub 主进程限制在 N 个逻辑核上（默认不限）。公司真机和验收机忙的时候，
// V8 后台线程会被挤到主线程之后才跑——单核能把这种「后台线程慢半拍」稳定地复现出来，不额外占 CPU。
const AFFINITY = Math.max(0, Number(arg('--affinity-cores', 0)) || 0);
// 诊断：JS 退出流程走完（app-quit）后进程还活着超过 8 秒，就先给它写一份小型转储（线程栈）再交给 gracefulQuit 收尾。
const DUMP_HANGS = !!arg('--dump-hangs', false);
const HANG_DUMP_AFTER_MS = 8000;

function writeMinidump(pid, file) {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HubMd { [DllImport(\"dbghelp.dll\", SetLastError=true)] public static extern bool MiniDumpWriteDump(IntPtr p, uint id, IntPtr f, uint t, IntPtr e, IntPtr u, IntPtr c); }'",
    `$p = Get-Process -Id ${Number(pid)}`,
    `$fs = [IO.File]::Create('${file.replace(/'/g, "''")}')`,
    // 0x1000 ThreadInfo | 0x4 HandleData | 0x0 Normal（全部线程栈）
    '$ok = [HubMd]::MiniDumpWriteDump($p.Handle, [uint32]$p.Id, $fs.SafeFileHandle.DangerousGetHandle(), 0x1004, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)',
    '$fs.Close(); if (-not $ok) { exit 1 }',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
}

function quitEventMs(dataDir, pid) {
  try {
    const lines = fs.readFileSync(path.join(dataDir, 'diagnostics', `process-lifecycle-${pid}.jsonl`), 'utf8').trim().split(/\r?\n/);
    for (const line of lines.reverse()) { const r = JSON.parse(line); if (r.event === 'app-quit') return r.epochMs; }
  } catch (_) {}
  return null;
}
const OUT = path.resolve(arg('--out', path.join(__dirname, '..', 'output', 'e2e-hub-quit-loop')));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function waitFor(fn, label, ms = 30000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await _waitMs(150);
  }
  throw new Error('timeout: ' + label + ' ' + (last && last.message ? last.message : JSON.stringify(last)));
}

function crashDumps(dataDir) {
  const dir = path.join(dataDir, 'electron-userdata', 'Crashpad', 'reports');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.dmp')).map(f => path.join(dir, f)); } catch (_) { return []; }
}

function lifecycleTail(dataDir, pid) {
  try {
    return fs.readFileSync(path.join(dataDir, 'diagnostics', `process-lifecycle-${pid}.jsonl`), 'utf8')
      .trim().split(/\r?\n/).slice(-4).map(line => { try { const r = JSON.parse(line); return `${r.event}:${r.phase}`; } catch (_) { return line.slice(0, 80); } });
  } catch (_) { return []; }
}

async function oneRun(index, root) {
  const dataDir = path.join(root, 'data');
  const before = new Set(crashDumps(dataDir));
  const record = { run: index + 1, exitCode: null, signal: null, newDumps: [], error: null };
  let hub = null;
  const conns = [];
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: `quit-loop-${index + 1}`, ...(ENTRY ? { entryPath: path.resolve(ENTRY) } : {}), ...(JS_FLAGS ? { extraArgs: [`--js-flags=${JS_FLAGS}`] } : {}), extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SHOW_PET: '1' } });
    record.pid = hub.pid;
    if (AFFINITY) {
      const mask = (2 ** AFFINITY) - 1;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${hub.pid}).ProcessorAffinity = ${mask}`], { windowsHide: true, stdio: 'ignore' });
      record.affinityMask = mask;
    }
    const main = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    conns.push(main);
    await waitFor(() => main.eval('document.readyState === "complete"'), 'main page');
    const debug = req => main.eval('require("electron").ipcRenderer.invoke("hub-pet:debug", ' + JSON.stringify(req) + ')');
    const petState = await waitFor(async () => { const s = await debug({ op: 'state' }); return s && s.visible && s.lastSent ? s : null; }, 'pet visible');
    record.pet = { role: petState.lastSent.role, visible: petState.visible };
    if (PET_MENU) {
      const target = re => waitFor(async () => (await listCdpTargets(hub)).find(t => t.type === 'page' && re.test(t.url || '')), String(re));
      const pet = await connectCDP((await target(/hub-pet[\\/]pet\.html/i)).webSocketDebuggerUrl);
      conns.push(pet);
      const b = petState.bounds;
      await debug({ op: 'cursor', pos: { x: b.x + 140, y: b.y + 260 } });
      await pet.eval('window.hubPet.menu(); true');
      const menu = await connectCDP((await target(/hub-pet[\\/]pet-menu\.html/i)).webSocketDebuggerUrl);
      conns.push(menu);
      await waitFor(async () => { const d = await menu.eval('window.__hubPetMenuDebug && window.__hubPetMenuDebug()'); return d && d.state ? d : null; }, 'menu state');
      record.petMenu = true;
    }
    if (DWELL_MS) await _waitMs(DWELL_MS);
    for (const c of conns.splice(0)) { try { await c.close(); } catch (_) {} }
    let watching = DUMP_HANGS;
    const watcher = (async () => {
      while (watching && hub.isAlive()) {
        const quitAt = quitEventMs(dataDir, hub.pid);
        if (quitAt && Date.now() - quitAt > HANG_DUMP_AFTER_MS) {
          const file = path.join(OUT, `hang-run${index + 1}-pid${hub.pid}.dmp`);
          try { writeMinidump(hub.pid, file); record.hangDump = file; } catch (error) { record.hangDumpError = String(error.message || error).slice(0, 200); }
          return;
        }
        await _waitMs(250);
      }
    })();
    let exit;
    try { exit = await gracefulQuit(hub); } finally { watching = false; await watcher; }
    record.exitCode = exit.exitCode;
    record.signal = exit.exitSignal;
  } catch (error) {
    record.error = String(error && error.message || error).slice(0, 400);
    // 启动阶段就失败（例如机器很忙时 CDP 端口归属核对超时，启动器按规矩拒绝连接并结束子进程）：单独记，不算退出崩溃。
    if (!hub) record.launchFailed = true;
    if (hub) {
      // gracefulQuit 把非零退出码当错误抛出；等进程真正结束后照实记下退出码。
      for (let i = 0; i < 100 && hub.isAlive(); i++) await _waitMs(100);
      record.exitCode = hub.exitCode();
      record.signal = hub.exitSignal();
      if (hub.isAlive()) { try { await gracefulQuit(hub); } catch (_) {} }
    }
  } finally {
    for (const c of conns) { try { await c.close(); } catch (_) {} }
  }
  // Crashpad 在进程结束后才把转储改成 .dmp，稍等一下再数。
  await _waitMs(1500);
  record.newDumps = crashDumps(dataDir).filter(f => !before.has(f));
  if (hub) {
    record.lifecycle = lifecycleTail(dataDir, hub.pid);
    record.shutdownLog = hub.log().filter(line => /\[shutdown\]|V8 memory-pool/.test(line)).slice(-6);
  }
  record.clean = record.exitCode === 0 && !record.signal && !record.newDumps.length && !record.error;
  return record;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quit-loop-e2e-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  // 公司版形状：桌宠开着。
  fs.writeFileSync(path.join(root, 'data', 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle' }));
  const runs = [];
  const startedAt = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const r = await oneRun(i, root);
    runs.push(r);
    console.log(`${r.clean ? '✓' : r.launchFailed ? '△' : '✗'} 第 ${r.run}/${RUNS} 次：退出码 ${r.exitCode}${r.signal ? ' 信号 ' + r.signal : ''}${r.newDumps.length ? '，新增崩溃转储 ' + r.newDumps.length + ' 个' : ''}${r.error ? '，' + r.error.split('\n')[0] : ''}`);
  }
  const launchFailed = runs.filter(r => r.launchFailed);
  const crashed = runs.filter(r => !r.clean && !r.launchFailed);
  const exited = RUNS - launchFailed.length;
  const summary = { runs: RUNS, dwellMs: DWELL_MS, petMenu: PET_MENU, jsFlags: JS_FLAGS, affinityCores: AFFINITY, entry: ENTRY ? path.resolve(ENTRY) : 'worktree', launched: exited, clean: exited - crashed.length, unclean: crashed.length, launchFailed: launchFailed.length, seconds: Math.round((Date.now() - startedAt) / 1000), dataRoot: root, details: runs };
  fs.writeFileSync(path.join(OUT, 'quit-loop-result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ clean: summary.clean, unclean: summary.unclean, launchFailed: summary.launchFailed, runs: RUNS, seconds: summary.seconds, out: OUT }));
  assert.equal(crashed.length, 0, `${crashed.length}/${exited} 次没有干净退出`);
  assert.equal(launchFailed.length, 0, `${launchFailed.length}/${RUNS} 次没能启动（不是退出问题，看 details 里的 error）`);
})().catch(error => { console.error(error && error.message || error); process.exitCode = 1; });
