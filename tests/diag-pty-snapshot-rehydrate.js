'use strict';
// 定位 PTY 顶部大片空白的根因。
//
// 生产缓存现在跟随 Session 生命周期，不再按数量驱逐 live xterm。这里通过隔离
// E2E hook 显式销毁首个 xterm，再走 hydrateTerminalFromSnapshot —— 把快照重放进
// 一个**当前尺寸**的终端。
// TUI 的绝对定位序列（\x1b[<row>;1H）是按快照拍摄时的行数算的，尺寸一变就落在错误的
// 行上，正文上方留白。末尾的 scrollToBottom 只能修滚动位置，修不了画错的行。
//
//   node tests/diag-pty-snapshot-rehydrate.js

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-rehydrate-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const SESSION_COUNT = 6;

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
    await _waitMs(150);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

// 与 Codex/Kimi 同构：先滚一屏历史，再用绝对定位把输入框钉在底部两行。
function writeFakeTui() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.writeFileSync(path.join(FAKE_BIN, 'fake-tui.js'), `
const out = s => process.stdout.write(s);
for (let i = 1; i <= 60; i++) out('history line ' + i + '\\r\\n');
function frame(tag) {
  const rows = process.stdout.rows || 24;
  out('\\x1b[' + Math.max(1, rows - 1) + ';1H> INPUT rows=' + rows + ' [' + tag + ']');
  out('\\x1b[' + rows + ';1HSTATUS [' + tag + ']');
}
frame('init');
process.stdout.on('resize', () => frame('r' + (process.stdout.rows || 0)));
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  for (const n of ['claude', 'codex', 'kimi']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${n}.cmd`),
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
  return {
    tag: ${JSON.stringify(tag)}, rows: term.rows, bufLen: buf.length,
    viewportY: buf.viewportY, blankTop: first < 0 ? term.rows : first,
    firstRow: first, lastRow: last, liveTerms: (window.__diagTerms || []).length,
  };
})()`;

async function main() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  writeFakeTui();
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR, port, label: 'rehydrate',
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
      PATH: `${FAKE_BIN};${process.env.PATH}`,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
      CLAUDE_HUB_E2E: '1',
    },
  });

  let client = null;
  const steps = [];
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));
    await waitFor('WorkspaceController', () => client.eval(
      '!!(window.WorkspaceController && window.WorkspaceController.createScratch)'));
    await waitFor('e2e terminal API', () => client.eval(
      '!!(window.__hubE2E && window.__hubE2E.disposeTerminal)'));

    await client.eval(`(() => {
      const xterm = require('@xterm/xterm');
      if (window.__diagTerms) return 'already';
      window.__diagTerms = [];
      const orig = xterm.Terminal.prototype.open;
      xterm.Terminal.prototype.open = function (p) { window.__diagTerms.push(this); return orig.call(this, p); };
      return 'patched';
    })()`);

    // 1. 在"大窗口"下建第一个会话，让它的快照按大 rows 定位
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 1300, deviceScaleFactor: 0, mobile: false });
    await _waitMs(800);

    const first = await client.eval(`(async () => {
      const ws = await window.WorkspaceController.createScratch('s0');
      const s = await window.WorkspaceController.createSession('codex', { workspace: ws });
      return { id: s.id };
    })()`);
    await waitFor('term0', () => client.eval('(window.__diagTerms||[]).length > 0'));
    await _waitMs(2500);
    steps.push(await client.eval(GEOM('1-大窗口下的原始会话')));

    // 2. 再建 5 个，确认多 Session 场景下首个 live xterm 不会被数量策略驱逐
    for (let i = 1; i < SESSION_COUNT; i++) {
      await client.eval(`(async () => {
        const ws = await window.WorkspaceController.createScratch('s${i}');
        await window.WorkspaceController.createSession('codex', { workspace: ws });
        return true;
      })()`);
      await _waitMs(900);
    }
    steps.push(await client.eval(GEOM('2-建满 6 个会话后(当前是最后一个)')));

    await client.eval(`window.__hubE2E.disposeTerminal(${JSON.stringify(first.id)})`);

    // 3. 把窗口改小 —— 第一个 xterm 已由测试 hook 显式销毁，不会跟着 fit
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 620, deviceScaleFactor: 0, mobile: false });
    await _waitMs(1800);
    steps.push(await client.eval(GEOM('3-窗口改小')));

    // 4. 切回第一个会话 → 走快照重建：旧尺寸的字节重放进新尺寸终端
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(first.id)}, { forceScrollBottom: true })`);
    await _waitMs(3000);
    steps.push(await client.eval(GEOM('4-切回显式销毁的会话(快照重建)')));

    console.log('--- 每步 ---');
    for (const s of steps) {
      if (s.error) { console.log(`${s.tag}: ${s.error}`); continue; }
      console.log(`${s.tag}: rows=${s.rows} bufLen=${s.bufLen} vpY=${s.viewportY} `
        + `顶部空白=${s.blankTop} 内容=[${s.firstRow}..${s.lastRow}] 活terminal=${s.liveTerms}`);
    }
    const bad = steps.filter(s => !s.error && s.blankTop > 2);
    console.log(`\n复现: ${bad.length > 0 ? 'YES' : 'no'} (顶部空白>2 的步骤 ${bad.length}/${steps.length})`);
    if (bad.length) console.log('命中步骤:', bad.map(b => b.tag).join(' / '));
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
