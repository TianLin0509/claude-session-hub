'use strict';
// 测「PTY 顶部空白」的命中率。之前唯一一次命中（顶部空白=20 且不自愈）出现在
// 双会话 + 切换 + 改窗口高度的组合下，单会话怎么都复现不出来。
// 这里把那个组合固化成可重复实验，跑 N 轮统计命中率——用来判断
// fitAndResizeTerminal 的通用置底、以及快照回灌后补 fit 这两处修复是否真的有效。
//
//   node tests/diag-pty-blank-rate.js [轮数=5]

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROUNDS = Math.max(1, Math.min(20, Number(process.argv[2]) || 5));

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

function writeFakeTui(bin) {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fake-tui.js'), `
const out = s => process.stdout.write(s);
for (let i = 1; i <= 120; i++) out('history line ' + i + '\\r\\n');
function frame(tag) {
  const rows = process.stdout.rows || 24;
  out('\\x1b[2J\\x1b[H');
  out('\\x1b[' + Math.max(1, rows - 1) + ';1H> INPUT rows=' + rows + ' [' + tag + ']');
  out('\\x1b[' + rows + ';1HSTATUS [' + tag + ']');
}
frame('init');
process.stdout.on('resize', () => frame('r' + (process.stdout.rows || 0)));
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  for (const n of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, `${n}.cmd`),
      `@echo off\r\nnode "${path.join(bin, 'fake-tui.js')}"\r\n`, 'utf8');
  }
}

const GEOM = `(() => {
  const terms = (window.__diagTerms || []).filter(t => t.element && t.element.offsetParent !== null);
  const term = terms[0];
  if (!term) return { error: 'no visible terminal' };
  const buf = term.buffer.active;
  let first = -1, last = -1;
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    const txt = line ? line.translateToString(true) : '';
    if (txt.trim()) { if (first < 0) first = i; last = i; }
  }
  return { rows: term.rows, bufLen: buf.length, viewportY: buf.viewportY,
           blankTop: first < 0 ? term.rows : first, firstRow: first, lastRow: last };
})()`;

async function runOnce(round) {
  const root = path.join(os.tmpdir(), `hub-blank-rate-${Date.now()}-${round}`);
  const bin = path.join(root, 'fake-bin');
  const wsRoot = path.join(root, 'workspaces');
  fs.mkdirSync(wsRoot, { recursive: true });
  writeFakeTui(bin);
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(root, 'hub-data'), port, label: `rate${round}`,
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: wsRoot,
      PATH: `${bin};${process.env.PATH}`,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
    },
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

    for (const tag of ['A', 'B']) {
      await client.eval(`(async () => {
        const ws = await window.WorkspaceController.createScratch(${JSON.stringify(tag)});
        await window.WorkspaceController.createSession('codex', { workspace: ws });
        return true;
      })()`);
      await _waitMs(1400);
    }

    // 切到另一个会话（复刻当初命中的那一步）
    await client.eval(`(() => {
      const items = Array.from(document.querySelectorAll('.session-item'));
      const t = items[items.length - 1];
      if (t) t.click();
      return !!t;
    })()`);
    await _waitMs(1200);

    const worst = { blankTop: -1 };
    for (const h of [560, 1300, 900]) {
      await client.send('Emulation.setDeviceMetricsOverride',
        { width: 1400, height: h, deviceScaleFactor: 0, mobile: false });
      await _waitMs(2000);
      const g = await client.eval(GEOM);
      if (!g.error && g.blankTop > worst.blankTop) Object.assign(worst, g, { at: h });
    }
    return worst;
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const results = [];
  for (let i = 1; i <= ROUNDS; i++) {
    try {
      const r = await runOnce(i);
      results.push(r);
      console.log(`round ${i}: 最差顶部空白=${r.blankTop} rows=${r.rows} bufLen=${r.bufLen} `
        + `内容=[${r.firstRow}..${r.lastRow}] @高度${r.at}`);
    } catch (e) {
      console.log(`round ${i}: 失败 ${e.message}`);
      results.push({ blankTop: -1, failed: true });
    }
  }
  const usable = results.filter(r => !r.failed);
  const hits = usable.filter(r => r.blankTop > 2);
  console.log(`\n有效轮次 ${usable.length}/${ROUNDS}，命中(顶部空白>2) ${hits.length} 次`);
  console.log(hits.length === 0 ? '✅ 本次配置下未复现' : `❌ 仍会复现，最差 ${Math.max(...hits.map(h => h.blankTop))} 行`);
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
