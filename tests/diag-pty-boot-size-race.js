'use strict';
// Node 系 CLI 在 node-pty/ConPTY 下收不到 resize 事件（已实测，与进程拓扑无关），
// 也就是说 **CLI 只在自己启动那一刻读一次尺寸，此后永远按那个尺寸排版**。
// 而 Hub 是 pty.spawn(..., cols:120, rows:30) 硬编码，真正的尺寸由渲染层随后 resize，
// CLI 命令又是延迟写入的 —— 于是 CLI 启动时读到的可能是 120x30，而 xterm 早已是别的尺寸。
// 这里测量：CLI 启动时看到的尺寸 vs xterm 的实际尺寸，是否一致。
//   node tests/diag-pty-boot-size-race.js [轮数=3]

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROUNDS = Math.max(1, Math.min(10, Number(process.argv[2]) || 3));

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

function writeProbe(bin, log) {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'probe.js'), `
const fs = require('fs');
try {
  fs.appendFileSync(${JSON.stringify(log)},
    JSON.stringify({ cols: process.stdout.columns || null, rows: process.stdout.rows || null }) + '\\n');
} catch {}
process.stdout.write('PROBE_READY\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  for (const n of ['claude', 'codex', 'kimi']) {
    fs.writeFileSync(path.join(bin, `${n}.cmd`), `@echo off\r\nnode "${path.join(bin, 'probe.js')}"\r\n`, 'utf8');
  }
}

async function runOnce(round) {
  const root = path.join(os.tmpdir(), `hub-bootsize-${Date.now()}-${round}`);
  const bin = path.join(root, 'fake-bin');
  const ws = path.join(root, 'workspaces');
  const log = path.join(root, 'boot.log');
  fs.mkdirSync(ws, { recursive: true });
  writeProbe(bin, log);
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(root, 'hub-data'), port, label: `boot${round}`,
    extraEnv: { AI_HUB_WORKSPACE_ROOT: ws, PATH: `${bin};${process.env.PATH}`, CLAUDE_HUB_NO_EFFORT_MAX: '1' },
  });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));
    await waitFor('wc', () => client.eval('!!(window.WorkspaceController && window.WorkspaceController.createScratch)'));
    await client.eval(`(() => {
      const xterm = require('@xterm/xterm');
      if (window.__diagTerms) return 'already';
      window.__diagTerms = [];
      const orig = xterm.Terminal.prototype.open;
      xterm.Terminal.prototype.open = function (p) { window.__diagTerms.push(this); return orig.call(this, p); };
      return 'patched';
    })()`);
    await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('boot');
      await window.WorkspaceController.createSession('codex', { workspace: w });
      return true;
    })()`);
    await _waitMs(6000);

    const term = await client.eval(`(() => {
      const t = (window.__diagTerms || [])[0];
      return t ? { cols: t.cols, rows: t.rows } : null;
    })()`);
    const lines = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const boot = lines[0] || null;
    return { round, boot, term };
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const rows = [];
  for (let i = 1; i <= ROUNDS; i++) {
    try { rows.push(await runOnce(i)); }
    catch (e) { rows.push({ round: i, error: e.message }); }
  }
  let mismatch = 0;
  for (const r of rows) {
    if (r.error) { console.log(`round ${r.round}: 失败 ${r.error}`); continue; }
    const b = r.boot ? `${r.boot.cols}x${r.boot.rows}` : 'n/a';
    const t = r.term ? `${r.term.cols}x${r.term.rows}` : 'n/a';
    const ok = r.boot && r.term && r.boot.cols === r.term.cols && r.boot.rows === r.term.rows;
    if (!ok) mismatch++;
    console.log(`round ${r.round}: CLI 启动看到 ${b} | xterm 实际 ${t} | ${ok ? '一致' : '❌ 不一致'}`);
  }
  console.log(`\n不一致 ${mismatch}/${rows.filter(r => !r.error).length}`);
  console.log(mismatch === 0
    ? '✅ CLI 启动尺寸与 xterm 一致'
    : '❌ CLI 一启动就按错误尺寸排版，且此后收不到 resize —— 画面必然错位');
  if (mismatch > 0) process.exitCode = 1;
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
