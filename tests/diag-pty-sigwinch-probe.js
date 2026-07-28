'use strict';
// 先解决"没有可用验证手段"这个前置问题。
// 已知：Hub 的 PTY 里经 .cmd 起的 node 子进程收不到 process.stdout.on('resize')。
// 待验：stdout 是不是 TTY？轮询 process.stdout.rows 能不能看到尺寸变化？
// 只要轮询可行，就能造出会"清屏重画"的真实行为模型，PTY 问题才谈得上验证。
//   node tests/diag-pty-sigwinch-probe.js

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-winch-${Date.now()}-${process.pid}`);
const BIN = path.join(ROOT, 'fake-bin');
const WS = path.join(ROOT, 'workspaces');
const LOG = path.join(ROOT, 'probe.log');

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(e => (e ? reject(e) : resolve(a.port))); });
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(120);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

function writeProbeCli() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'probe.js'), `
const fs = require('fs');
const LOG = ${JSON.stringify(LOG)};
const log = o => { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\\n'); } catch {} };

log({ ev: 'boot',
      isTTY: !!process.stdout.isTTY,
      columns: process.stdout.columns || null,
      rows: process.stdout.rows || null,
      hasResizeEvent: typeof process.stdout.on === 'function' });

// A) 事件路径
process.stdout.on('resize', () => log({ ev: 'resize-event', rows: process.stdout.rows || null }));

// B) 轮询缓存值
let lastRows = process.stdout.rows || 0;
let lastCols = process.stdout.columns || 0;
setInterval(() => {
  const r = process.stdout.rows || 0;
  const c = process.stdout.columns || 0;
  if (r !== lastRows || c !== lastCols) {
    log({ ev: 'poll-change', from: lastRows + 'x' + lastCols, to: r + 'x' + c });
    lastRows = r; lastCols = c;
  }
}, 100);

// C) 强制向宿主控制台重查（绕过 Node 的缓存）。
//    如果这条能看到变化，说明 ConPTY 确实改了、只是 Node 不发 resize 事件 ——
//    那么所有 Node 系 CLI（Claude Code / Codex）都会一直按启动尺寸排版。
let refRows = 0, refCols = 0;
setInterval(() => {
  try {
    if (typeof process.stdout._refreshSize === 'function') process.stdout._refreshSize();
  } catch {}
  const r = process.stdout.rows || 0;
  const c = process.stdout.columns || 0;
  if (r !== refRows || c !== refCols) {
    if (refRows) log({ ev: 'refresh-change', from: refRows + 'x' + refCols, to: r + 'x' + c });
    refRows = r; refCols = c;
  }
}, 150);

process.stdout.write('PROBE_READY\\r\\n');
process.stdin.resume();
`, 'utf8');
  for (const n of ['claude', 'codex']) {
    fs.writeFileSync(path.join(BIN, `${n}.cmd`), `@echo off\r\nnode "${path.join(BIN, 'probe.js')}"\r\n`, 'utf8');
  }
}

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  writeProbeCli();
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'winch',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WS, PATH: `${BIN};${process.env.PATH}`, CLAUDE_HUB_NO_EFFORT_MAX: '1' },
  });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));
    await waitFor('wc', () => client.eval('!!(window.WorkspaceController && window.WorkspaceController.createScratch)'));
    // 拦渲染层的 terminal-resize，判断断点在"渲染层没发"还是"发了但没到子进程"
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      if (window.__resizeSends) return 'already';
      window.__resizeSends = [];
      const orig = ipcRenderer.send.bind(ipcRenderer);
      ipcRenderer.send = function (channel, payload) {
        if (channel === 'terminal-resize') window.__resizeSends.push(payload);
        return orig(channel, payload);
      };
      return 'patched';
    })()`);

    await client.eval(`(async () => {
      const ws = await window.WorkspaceController.createScratch('winch');
      await window.WorkspaceController.createSession('codex', { workspace: ws });
      return true;
    })()`);
    await _waitMs(3500);

    for (const h of [600, 1200, 800]) {
      await client.send('Emulation.setDeviceMetricsOverride',
        { width: 1400, height: h, deviceScaleFactor: 0, mobile: false });
      await _waitMs(2000);
    }
    await _waitMs(1500);

    const lines = fs.existsSync(LOG)
      ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const boot = lines.find(l => l.ev === 'boot');
    const events = lines.filter(l => l.ev === 'resize-event');
    const polls = lines.filter(l => l.ev === 'poll-change');

    const sends = await client.eval('window.__resizeSends || []').catch(() => []);
    console.log('boot:', JSON.stringify(boot));
    console.log(`渲染层发出 terminal-resize: ${sends.length} 次`);
    sends.slice(0, 8).forEach(s => console.log(`   -> ${s.cols}x${s.rows}`));
    const refreshes = lines.filter(l => l.ev === 'refresh-change');
    console.log(`子进程 resize 事件次数     : ${events.length}`);
    console.log(`子进程轮询(缓存)变化次数   : ${polls.length}`);
    console.log(`子进程强制重查变化次数     : ${refreshes.length}`);
    refreshes.slice(0, 6).forEach(r => console.log(`   ${r.from} -> ${r.to}`));
    console.log('');
    if (sends.length > 0 && refreshes.length > 0 && events.length === 0) {
      console.log('🔎 结论：ConPTY 确实改了尺寸，但 Node 不发 resize 事件、也不刷新缓存值。');
      console.log('   → 所有 Node 系 CLI（Claude Code / Codex）都会一直按【启动时】的尺寸排版，');
      console.log('     而 xterm 已经是新尺寸 —— 这就是画面错位/大片空白的来源。');
    } else if (sends.length > 0 && refreshes.length === 0) {
      console.log('🔎 结论：resize 根本没传到子进程（pty.resize 或 ConPTY 传播断了）。');
    }
    polls.slice(0, 6).forEach(p => console.log(`   ${p.from} -> ${p.to}`));
    console.log('');
    if (!boot) console.log('❌ 探针没启动，链路本身有问题');
    else if (!boot.isTTY) console.log('❌ stdout 不是 TTY —— 子进程根本拿不到尺寸，必须换成原生 exe 或去掉 .cmd 包装');
    else if (polls.length > 0) console.log('✅ 轮询可行 —— 可以据此造出会重画的行为模型，PTY 问题可验证');
    else if (events.length > 0) console.log('✅ 事件可行');
    else console.log('❌ 事件与轮询都拿不到变化 —— 需要换验证路径（真实 CLI 或原生 exe）');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
