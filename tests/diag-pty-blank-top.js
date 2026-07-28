'use strict';
// 诊断：PTY 顶部大片空白、内容挤在底部（Codex / Claude 都出现过）。
// 关键改进：假 TUI 先吐 200 行制造真实滚动回缓冲，再画底部锚定的一帧——
// 之前的版本每次清屏、bufLen == rows，没有 scrollback，所以复现不稳定。
//   node tests/diag-pty-blank-top.js [claude|codex]

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const KIND = process.argv[2] === 'codex' ? 'codex' : 'claude';
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-blank-top-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      server.close(e => (e ? reject(e) : resolve(a.port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(150);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

function writeFakeTui() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const js = `
const out = s => process.stdout.write(s);
// 1) 先制造真实 scrollback：200 行历史
for (let i = 1; i <= 200; i++) out('history line ' + i + ' ' + 'x'.repeat(20) + '\\r\\n');
// 2) 再画底部锚定的一帧（Codex/Kimi 的输入框就是这么定位的）
function frame(tag) {
  const rows = process.stdout.rows || 24;
  out('\\x1b[' + Math.max(1, rows - 1) + ';1H> input box  rows=' + rows + ' [' + tag + ']');
  out('\\x1b[' + rows + ';1Hstatus line [' + tag + ']');
}
frame('init');
process.stdout.on('resize', () => frame('r' + (process.stdout.rows || 0)));
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`;
  fs.writeFileSync(path.join(FAKE_BIN, 'fake-tui.js'), js, 'utf8');
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${name}.cmd`),
      `@echo off\r\nnode "${path.join(FAKE_BIN, 'fake-tui.js')}"\r\n`, 'utf8');
  }
}

const GEOM = tag => `(() => {
  const terms = (window.__diagTerms || []).filter(t => t.element && t.element.offsetParent !== null);
  const term = terms[0];
  if (!term) return { tag: ${JSON.stringify(tag)}, error: 'no visible terminal' };
  const buf = term.buffer.active;
  let first = -1, last = -1;
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    const txt = line ? line.translateToString(true) : '';
    if (txt.trim()) { if (first < 0) first = i; last = i; }
  }
  const vp = term.element.querySelector('.xterm-viewport');
  const atBottom = vp ? (vp.scrollHeight - vp.scrollTop - vp.clientHeight) <= 24 : null;
  return {
    tag: ${JSON.stringify(tag)},
    rows: term.rows, bufLen: buf.length, baseY: buf.baseY, viewportY: buf.viewportY,
    blankTop: first < 0 ? term.rows : first, firstRow: first, lastRow: last,
    atBottom,
    scrollGap: vp ? Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight) : null,
  };
})()`;

async function main() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  writeFakeTui();
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR, port, label: 'blank-top',
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
      PATH: `${FAKE_BIN};${process.env.PATH}`,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
    },
  });

  let client = null;
  const steps = [];
  try {
    client = await waitFor('cdp page', async () => {
      try { return await connectFirstPage(hub); } catch { return null; }
    });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));
    await waitFor('WorkspaceController', () => client.eval(
      '!!(window.WorkspaceController && window.WorkspaceController.createScratch)'));

    await client.eval(`(() => {
      const xterm = require('@xterm/xterm');
      if (window.__diagTerms) return 'already';
      window.__diagTerms = [];
      const orig = xterm.Terminal.prototype.open;
      xterm.Terminal.prototype.open = function (p) { window.__diagTerms.push(this); return orig.call(this, p); };
      return 'patched';
    })()`);

    await client.eval(`(async () => {
      const ws = await window.WorkspaceController.createScratch('blank-top');
      await window.WorkspaceController.createSession(${JSON.stringify(KIND)}, { workspace: ws });
      return true;
    })()`);
    await waitFor('terminal', () => client.eval('(window.__diagTerms||[]).length > 0'));
    await _waitMs(3000);

    const snap = async tag => { const g = await client.eval(GEOM(tag)); steps.push(g); return g; };
    const setH = async h => {
      await client.send('Emulation.setDeviceMetricsOverride',
        { width: 1400, height: h, deviceScaleFactor: 0, mobile: false });
      await _waitMs(2200);
    };

    await snap('1-初始');
    await setH(560);  await snap('2-缩到 560');
    await setH(1300); await snap('3-放到 1300');
    await setH(900);  await snap('4-回到 900');

    console.log(`--- kind=${KIND} ---`);
    for (const s of steps) {
      if (s.error) { console.log(`${s.tag}: ${s.error}`); continue; }
      console.log(`${s.tag}: rows=${s.rows} bufLen=${s.bufLen} baseY=${s.baseY} vpY=${s.viewportY} `
        + `顶部空白=${s.blankTop} 内容=[${s.firstRow}..${s.lastRow}] 在底部=${s.atBottom} 距底=${s.scrollGap}px`);
    }
    const rowsChanged = new Set(steps.filter(s => !s.error).map(s => s.rows)).size > 1;
    const bad = steps.filter(s => !s.error && s.blankTop > 2);
    console.log(`\nrows 是否变化: ${rowsChanged}`);
    console.log(`复现: ${bad.length > 0 ? 'YES' : 'no'} (顶部空白>2 的步骤 ${bad.length}/${steps.length})`);
    if (!rowsChanged) console.log('⚠ rows 没变，这一轮没有真正触发 resize 路径，结果不作数');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('diag failed:', err && err.message);
  if (err && err.logTail) console.error(err.logTail);
  process.exitCode = 1;
});
