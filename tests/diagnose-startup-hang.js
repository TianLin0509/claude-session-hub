'use strict';
// 启动卡死取证（2026-10-11）：公司电脑上 v0.5.9 启动约 80 秒后界面无响应，20 秒后界面进程崩溃，v0.5.8 正常。
// 用真实数据的副本单独启动一个 Hub，不碰正在用的 Hub，也不改真实的 Code Agent 配置目录（用它顶层文件的副本）。
// 先静置观察；界面一卡住，就用调试器暂停，记下当时正在执行的 JS 调用栈（连抓 3 次），
// 同时保留卡住前每 10 秒一段的 CPU 剖析、每秒的帧数 / 堆 / 页面元素 / 各进程 CPU、界面报错。
// 静置期间没卡住，再点开最近的几个 CodeAgent 会话、在卡片和终端之间来回切，继续观察。
//
// 用法：node tests/diagnose-startup-hang.js --exe "<AI Hub Community.exe>" [--seconds 150] [--label v059] [--report <file>]
//   --data-src <目录>        要复制的数据目录，默认 %USERPROFILE%\.ai-hub-community
//   --self-test-hang <秒>    自测：到点在界面里制造一个死循环，检查能否抓到调用栈
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const exe = arg('--exe') || '';
const quietSecs = Math.max(30, Number(arg('--seconds', 150)));
const label = arg('--label', path.basename(path.dirname(exe || 'hub')));
const reportCopy = arg('--report', '');
const selfTest = Number(arg('--self-test-hang', 0)) || 0;
const home = process.env.USERPROFILE || os.homedir();
const dataSrc = path.resolve(arg('--data-src', path.join(home, '.ai-hub-community')));
const cacSrc = path.resolve(process.env.AI_HUB_CODEAGENT_CONFIG_DIR || process.env.CODEAGENT3_CONFIG_DIR || path.join(home, '.cac'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-startup-hang-'));
const out = path.join(root, 'report'); fs.mkdirSync(out, { recursive: true });
process.env.HUB_E2E_SHOW_WINDOWS = '1';
process.env.HUB_TEST_PRIORITY = 'normal';

const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const user = path.basename(home);
const redact = t => String(t || '').split(home).join('%USERPROFILE%').split(user).join('<USER>').replace(/https?:\/\/[^\s'"]+/g, '<URL>');
const shortUrl = u => redact(String(u || '').replace(/^file:\/+/, '').replace(/^.*?(app\.asar|resources)[\\/]/, ''));

let hub = null, c = null, crashed = false, t0 = 0;
const timeline = [], events = [], consoleLines = [], exceptions = [], stacks = [], profiles = [];
const scripts = new Map();
const pausedWaiters = [];
const since = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
const note = s => { const line = `${since()} ${s}`; events.push(line); console.log(line); };

async function timed(expr, ms) {
  let timer;
  try { return { ok: true, v: await Promise.race([c.eval(expr), new Promise((_, r) => { timer = setTimeout(() => r(new Error('timeout')), ms); })]) }; }
  catch (e) { return { ok: false, err: e.message }; } finally { clearTimeout(timer); }
}
function processSample() {
  const script = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(AI Hub Community|codeagentcli)\\.exe$' } | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId,$_.ParentProcessId,$_.Name,($_.KernelModeTime+$_.UserModeTime),$_.WorkingSetSize,($_.CommandLine -replace '\\|',' ') }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const rows = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const [pid, ppid, name, cpu, ws, ...rest] = line.split('|'); if (!pid) continue;
    rows.push({ pid: +pid, ppid: +ppid, name, cpu: +cpu / 1e7, ws: +ws, type: ((rest.join('|')).match(/--type=([a-z-]+)/) || [])[1] || '' });
  }
  return { at: Date.now(), rows };
}
function cpuLine(a, b) {
  const ids = new Set([hub && hub.pid]); let grew = true;
  while (grew) { grew = false; for (const r of b.rows) if (!ids.has(r.pid) && ids.has(r.ppid)) { ids.add(r.pid); grew = true; } }
  const prev = new Map(a.rows.map(r => [r.pid, r])); const secs = (b.at - a.at) / 1000; const g = new Map();
  for (const r of b.rows.filter(x => ids.has(x.pid))) {
    const k = r.pid === hub.pid ? '主' : /codeagentcli/i.test(r.name) ? 'CLI' : ({ renderer: '界面', 'gpu-process': 'GPU', utility: '辅助' }[r.type] || '子');
    const p = prev.get(r.pid); const cur = g.get(k) || { cpu: 0, ws: 0 };
    cur.cpu += p ? Math.max(0, r.cpu - p.cpu) : 0; cur.ws += r.ws; g.set(k, cur);
  }
  return [...g.entries()].map(([k, v]) => `${k} ${Math.round(v.cpu / secs * 100)}%/${Math.round(v.ws / 2 ** 20)}MB`).join(' ');
}

const MON = `(() => { if (window.__sh) return 1; const m = window.__sh = { frames: 0, lagMax: 0, long: 0, longMs: 0 };
  const f = () => { m.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
  let last = performance.now(); setInterval(() => { const n = performance.now(); m.lagMax = Math.max(m.lagMax, n - last - 100); last = n; }, 100);
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { m.long++; m.longMs += e.duration; } }).observe({ entryTypes: ['longtask'] }); } catch {}
  return 1; })()`;
const TAKE = `(() => { const m = window.__sh || {}; const r = { frames: m.frames, lagMax: Math.round(m.lagMax || 0), long: m.long, longMs: Math.round(m.longMs || 0),
  heapMB: Math.round(((performance.memory || {}).usedJSHeapSize || 0) / 1048576), dom: document.getElementsByTagName('*').length,
  sessions: typeof sessions !== 'undefined' ? sessions.size : -1, vis: document.visibilityState };
  Object.assign(m, { frames: 0, lagMax: 0, long: 0, longMs: 0 }); return r; })()`;

function summarizeProfile(p) {
  const byId = new Map(p.nodes.map(n => [n.id, n])); const self = new Map(); const dt = p.timeDeltas || [];
  (p.samples || []).forEach((id, i) => {
    const n = byId.get(id); if (!n) return; const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${shortUrl(f.url)}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0));
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(6)} ms ${(us / total * 100).toFixed(1).padStart(5)}%  ${k}`);
}
let profiling = false, profileStartedAt = 0;
async function startProfile() {
  await c.send('Profiler.setSamplingInterval', { interval: 1000 }).catch(() => {});
  profiling = await c.send('Profiler.start').then(() => true, () => false); profileStartedAt = Date.now();
}
async function rotateProfile() {
  if (!profiling) return;
  const from = Math.round((profileStartedAt - t0) / 1000);
  const res = await Promise.race([c.send('Profiler.stop'), sleep(5000).then(() => null)]).catch(() => null);
  profiling = false;
  if (res && res.profile) {
    profiles.push({ range: `+${from}s～${since()}`, top: summarizeProfile(res.profile) });
    if (profiles.length > 4) profiles.shift();
    await startProfile();
  }
}

function waitPaused(ms) {
  return new Promise(resolve => { const w = { resolve, timer: setTimeout(() => { pausedWaiters.splice(pausedWaiters.indexOf(w), 1); resolve(null); }, ms) }; pausedWaiters.push(w); });
}
async function captureStacks(reason) {
  note(`界面无响应（${reason}），开始抓调用栈`);
  for (let k = 1; k <= 3 && !crashed; k++) {
    const waiting = waitPaused(8000);
    c.send('Debugger.pause').catch(() => {});
    const ev = await waiting;
    if (!ev) { stacks.push({ k, at: since(), frames: ['（8 秒内没能暂停：多半卡在排版、样式计算或垃圾回收，不在 JS 里）'] }); note(`第 ${k} 次暂停失败`); continue; }
    const frames = (ev.callFrames || []).slice(0, 20).map(f => {
      const url = f.url || (scripts.get(f.location && f.location.scriptId) || '');
      return `${f.functionName || '(anonymous)'}  ${shortUrl(url)}:${(f.location ? f.location.lineNumber : 0) + 1}:${(f.location ? f.location.columnNumber : 0) + 1}`;
    });
    stacks.push({ k, at: since(), reason: ev.reason, frames });
    note(`第 ${k} 次暂停成功，栈顶：${frames[0] || '（空）'}`);
    await c.send('Debugger.resume').catch(() => {});
    await sleep(1500);
  }
}

function copyData(dest) {
  if (!fs.existsSync(dataSrc)) throw new Error('没有找到数据目录：' + redact(dataSrc));
  fs.cpSync(dataSrc, dest, { recursive: true, filter: s => !/[\\/](electron-userdata|cache|Cache|GPUCache|Code Cache|logs)([\\/]|$)/.test(s) });
}
function copyCacTopFiles(dest) {
  fs.mkdirSync(dest, { recursive: true });
  try { for (const e of fs.readdirSync(cacSrc, { withFileTypes: true })) if (e.isFile()) fs.copyFileSync(path.join(cacSrc, e.name), path.join(dest, e.name)); } catch {}
}
function dirSizeMB(p) {
  let total = 0; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else try { total += fs.statSync(f).size; } catch {} } };
  try { walk(p); } catch {} return (total / 2 ** 20).toFixed(1);
}

async function monitor(secs, phase) {
  note(`阶段：${phase}（${secs} 秒）`);
  const end = Date.now() + secs * 1000; let misses = 0, captured = false, lastProc = processSample(), lastRotate = Date.now(), tick = 0;
  while (Date.now() < end && !crashed) {
    const r = await timed(TAKE, 3000);
    if (r.ok) {
      misses = 0; const v = r.v || {};
      let proc = '';
      if (++tick % 3 === 0) { const now = processSample(); proc = ' | ' + cpuLine(lastProc, now); lastProc = now; }
      timeline.push(`${since()} 帧 ${v.frames ?? '?'} 延迟 ${v.lagMax}ms 长任务 ${v.long}/${v.longMs}ms 堆 ${v.heapMB}MB 元素 ${v.dom} 会话 ${v.sessions} ${v.vis}${proc}`);
      if (Date.now() - lastRotate > 10000) { await rotateProfile(); lastRotate = Date.now(); }
      await sleep(700);
    } else {
      misses++;
      const now = processSample(); timeline.push(`${since()} 界面 3 秒内没回应（连续 ${misses} 次）| ${cpuLine(lastProc, now)}`); lastProc = now;
      if (misses >= 2 && !captured) { captured = true; await captureStacks(`连续 ${misses} 次 3 秒内没回应`); }
      if (captured && misses >= 12) { note('界面持续无响应超过 40 秒，结束观察'); return 'hung'; }
    }
  }
  return crashed ? 'crashed' : (captured ? 'hung' : 'ok');
}

async function main() {
  if (!exe || !fs.existsSync(exe)) throw new Error('请用 --exe 指定「AI Hub Community.exe」的完整路径');
  const dataDir = path.join(root, 'data'), cacDir = path.join(root, 'cac');
  copyData(dataDir); copyCacTopFiles(cacDir);
  const gpuOff = fs.existsSync(path.join(dataSrc, 'gpu-disabled.json'));
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), executablePath: exe, windowMode: 'visible', label: 'startup-hang', allowExternalState: true,
    extraEnv: { AI_HUB_CODEAGENT_CONFIG_DIR: cacDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', ...(gpuOff ? { AI_HUB_DISABLE_GPU: '1' } : {}) } });
  t0 = Date.now();
  c = await connectFirstPage(hub);
  c.ws.on('message', data => {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.method === 'Inspector.targetCrashed') { crashed = true; note('界面进程崩溃（Inspector.targetCrashed）'); }
    else if (msg.method === 'Debugger.scriptParsed') scripts.set(msg.params.scriptId, msg.params.url);
    else if (msg.method === 'Debugger.paused') { const w = pausedWaiters.shift(); if (w) { clearTimeout(w.timer); w.resolve(msg.params); } else c.send('Debugger.resume').catch(() => {}); }
    else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(msg.params.type) && consoleLines.length < 80) {
      consoleLines.push(`${since()} [${msg.params.type}] ${redact((msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')).slice(0, 300)}`);
    } else if (msg.method === 'Runtime.exceptionThrown' && exceptions.length < 40) {
      const d = msg.params.exceptionDetails || {}; exceptions.push(`${since()} ${redact((d.exception && d.exception.description) || d.text || '').slice(0, 400)}`);
    }
  });
  c.ws.on('close', () => { if (!crashed) note('与界面的调试连接断开'); crashed = true; });
  for (const m of ['Inspector.enable', 'Runtime.enable', 'Debugger.enable', 'Profiler.enable']) await c.send(m).catch(() => {});
  for (let i = 0; i < 100 && !(await timed('document.readyState === "complete" && typeof sessions !== "undefined"', 3000)).v; i++) await sleep(300);
  await timed(MON, 5000);
  const env = { label, hub: (await timed('document.title', 3000)).v, exe: redact(exe), gpu: gpuOff ? '关闭（数据目录有 gpu-disabled.json）' : '开启',
    dataMB: dirSizeMB(dataDir), sessions: (await timed('sessions.size', 3000)).v,
    codeagentSessions: (await timed('[...sessions.values()].filter(s => /^codeagent/.test(s.kind)).length', 3000)).v,
    backstage: (await timed("require('../core/backstage-path.js').backstagePath()", 3000)).v || '（旧版无此开关）',
    screen: (await timed('`${screen.width}x${screen.height} 缩放 ${devicePixelRatio}`', 3000)).v, cpu: `${os.cpus().length} 核`, mem: `${Math.round(os.totalmem() / 2 ** 30)} GB` };
  timeline.push(`${since()} 环境 ${j(env)}`);
  await startProfile();
  if (selfTest) setTimeout(() => { note('自测：注入死循环'); c.send('Runtime.evaluate', { expression: 'setTimeout(function __selfTestHang(){ const a = []; for (;;) { a.push(Math.random()); if (a.length > 1e6) a.length = 0; } }, 0)' }).catch(() => {}); }, selfTest * 1000);
  let result = await monitor(quietSecs, '静置观察，不做任何操作');
  if (result === 'ok') {
    const ids = (await timed(`[...sessions.values()].filter(s => /^codeagent/.test(s.kind)).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0)).slice(0, 3).map(s => s.id)`, 5000)).v || [];
    note(`静置期间没卡住；点开最近 ${ids.length} 个 CodeAgent 会话，在卡片和终端之间来回切`);
    for (const id of ids) { await timed(`selectSession(${j(id)})`, 8000); await sleep(4000); }
    for (let i = 0; i < 5 && ids.length; i++) { await timed(`applyViewMode('pty')`, 5000); await sleep(2500); await timed(`applyViewMode('card')`, 5000); await sleep(2500); }
    result = await monitor(60, '操作之后继续观察');
  }
  note(`结论：${{ ok: '全程没有卡住', hung: '界面卡住', crashed: '界面进程崩溃' }[result]}`);
  return { env, result };
}

main().then(r => r, e => { note('致命错误：' + redact(e && e.message)); return null; }).then(async r => {
  const md = [`# 启动卡死取证报告（${label}）`, '', `结论：${r ? { ok: '全程没有卡住', hung: '界面卡住', crashed: '界面进程崩溃' }[r.result] : '脚本出错，见事件'}`, ''];
  if (r) md.push('```json', j(r.env, null, 2), '```', '');
  md.push('## 事件', '```text', ...events, '```', '');
  if (stacks.length) { md.push('## 卡住时正在执行的 JS 调用栈（栈顶在上）'); for (const s of stacks) md.push('', `第 ${s.k} 次（${s.at}）`, '```text', ...s.frames, '```'); md.push(''); }
  if (profiles.length) { md.push('## 卡住前最近几段 CPU 剖析（每段约 10 秒，自身耗时前 15）'); for (const p of profiles) md.push('', p.range, '```text', ...p.top, '```'); md.push(''); }
  md.push('## 每秒采样（帧 / 主线程最大延迟 / 长任务 / JS 堆 / 页面元素；每 3 秒附各进程 CPU 与内存）', '```text', ...timeline.slice(0, 40), ...(timeline.length > 80 ? ['…'] : []), ...timeline.slice(Math.max(40, timeline.length - 40)), '```', '');
  if (exceptions.length) md.push('## 界面未捕获异常', '```text', ...exceptions, '```', '');
  if (consoleLines.length) md.push('## 界面报错与警告（前 80 条）', '```text', ...consoleLines, '```', '');
  try { const log = hub.log().filter(l => /error|warn|fail|crash|gone|unresponsive|memory|timeout|超时|失败/i.test(l)).slice(-50).map(redact); if (log.length) md.push('## Hub 主进程日志（相关行）', '```text', ...log, '```', ''); } catch {}
  try { const wl = fs.readFileSync(path.join(root, 'data', 'logs', 'window-events.log'), 'utf8').trim().split(/\r?\n/).slice(-30).map(redact); md.push('## 窗口事件日志（副本实例）', '```text', ...wl, '```', ''); } catch {}
  try { if (c) c.close(); } catch {}
  if (hub) {
    const quit = await Promise.race([gracefulQuit(hub, { allowAlreadyExited: true }).then(() => 'ok', e => e.message), sleep(25000).then(() => 'timeout')]);
    if (quit !== 'ok' && hub.isAlive()) { try { hub.child.kill(); } catch {} }
  }
  const text = md.join('\n').slice(0, 40000);
  fs.writeFileSync(path.join(out, 'startup-hang-report.md'), text, 'utf8');
  if (reportCopy) { try { fs.writeFileSync(path.resolve(reportCopy), text, 'utf8'); } catch {} }
  console.log('\n报告：' + path.join(out, 'startup-hang-report.md'));
  setTimeout(() => process.exit(0), 500);
});
