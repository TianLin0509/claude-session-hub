'use strict';
// 量化「拖窗口时 CLI 被迫重画多少次」。
// 假 TUI 每收到一次 SIGWINCH 就记一笔（真实 Codex/Kimi 收到后会 \x1b[2J 清屏重画，
// 正文因此被反复抹掉）。用连续变高度模拟拖动，统计重画次数。
//   node tests/diag-pty-resize-storm.js

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-storm-${Date.now()}-${process.pid}`);
const BIN = path.join(ROOT, 'fake-bin');
const WS = path.join(ROOT, 'workspaces');
const COUNT_FILE = path.join(ROOT, 'resize-count.log');

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

function writeFakeTui() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'fake-tui.js'), `
const fs = require('fs');
const COUNT = ${JSON.stringify(COUNT_FILE)};
const out = s => process.stdout.write(s);
for (let i = 1; i <= 60; i++) out('history ' + i + '\\r\\n');
function frame(tag) {
  const rows = process.stdout.rows || 24;
  out('\\x1b[2J\\x1b[H');
  out('\\x1b[' + Math.max(1, rows - 1) + ';1H> INPUT rows=' + rows);
  out('\\x1b[' + rows + ';1HSTATUS ' + tag);
}
frame('init');
process.stdout.on('resize', () => {
  try { fs.appendFileSync(COUNT, (process.stdout.rows || 0) + '\\n'); } catch {}
  frame('resize');
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  for (const n of ['claude', 'codex']) {
    fs.writeFileSync(path.join(BIN, `${n}.cmd`), `@echo off\r\nnode "${path.join(BIN, 'fake-tui.js')}"\r\n`, 'utf8');
  }
}

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  writeFakeTui();
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'storm',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WS, PATH: `${BIN};${process.env.PATH}`, CLAUDE_HUB_NO_EFFORT_MAX: '1' },
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
      const ws = await window.WorkspaceController.createScratch('storm');
      await window.WorkspaceController.createSession('codex', { workspace: ws });
      return true;
    })()`);
    await _waitMs(3000);

    const before = fs.existsSync(COUNT_FILE) ? fs.readFileSync(COUNT_FILE, 'utf8').split('\n').filter(Boolean).length : 0;

    // 模拟一次拖动：40 个中间高度，每 40ms 一步（约 1.6s，接近真人拖窗口）
    for (let i = 0; i < 40; i++) {
      const h = 700 + i * 15;
      await client.send('Emulation.setDeviceMetricsOverride',
        { width: 1400, height: h, deviceScaleFactor: 0, mobile: false });
      await _waitMs(40);
    }
    await _waitMs(2500);   // 等防抖落地

    const lines = fs.existsSync(COUNT_FILE) ? fs.readFileSync(COUNT_FILE, 'utf8').split('\n').filter(Boolean) : [];
    const repaints = lines.length - before;
    const lastRowsSeenByCli = lines.length ? Number(lines[lines.length - 1]) : null;

    // 一致性：CLI 最终认知的 rows 必须等于 xterm 的 rows，否则防抖吞掉了最后一次 resize
    const term = await client.eval(`(() => {
      const els = document.querySelectorAll('.terminal-container .xterm-rows');
      const t = (window.__diagTerms || [])[0];
      return t ? { rows: t.rows, cols: t.cols } : null;
    })()`).catch(() => null);
    const xtermRows = term && term.rows;

    console.log(`模拟拖动 40 步（约 1.6s）`);
    console.log(`CLI 被迫清屏重画次数: ${repaints}`);
    console.log(`xterm 最终 rows=${xtermRows} / CLI 认知 rows=${lastRowsSeenByCli}`);
    const consistent = xtermRows != null && lastRowsSeenByCli === xtermRows;
    console.log(repaints <= 5 ? '✅ 重画已合并' : '❌ 仍在风暴级别');
    console.log(consistent
      ? '✅ 最终尺寸已送达 CLI'
      : '❌ 最终尺寸没送达 —— 防抖吞掉了收尾的 resize，CLI 会停在错误宽度');
    if (!consistent) process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
