'use strict';
// 真实 CLI + "隐藏态被 resize 再切回"路径。
// 纯窗口 resize 已验证真实 Codex 完全自适应（diag-real-cli-resize.js）。
// 剩下最可疑的是：会话处于隐藏态时窗口变了 —— 隐藏的终端 getBoundingClientRect 为 0，
// fitAndResizeTerminal 直接早退，PTY 不会收到新尺寸；切回来时 showTerminal 才补 fit，
// 而它对 Codex 类会话恰好不做 scrollToBottom（pinOnShow = !isCodexSession && focus）。
//   node tests/diag-real-cli-hidden-resize.js [codex|kimi]

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const KIND = process.argv[2] === 'kimi' ? 'kimi' : 'codex';
const ROOT = path.join(os.tmpdir(), `hub-hidden-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(e => (e ? reject(e) : resolve(a.port))); });
  });
}

async function waitFor(label, fn, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

const MEASURE = `(() => {
  const terms = (window.__diagTerms || []).filter(t => t.element && t.element.offsetParent !== null);
  const term = terms[0];
  if (!term) return { error: 'no visible terminal' };
  const buf = term.buffer.active;
  let widest = 0;
  const start = Math.max(0, buf.length - term.rows);
  for (let i = start; i < buf.length; i++) {
    const l = buf.getLine(i);
    if (!l) continue;
    const w = l.translateToString(true).replace(/\\s+$/, '').length;
    if (w > widest) widest = w;
  }
  let blankTop = 0;
  for (let i = 0; i < term.rows; i++) {
    const l = buf.getLine(buf.viewportY + i);
    const t = l ? l.translateToString(true) : '';
    if (t.trim()) break;
    blankTop++;
  }
  const vp = term.element.querySelector('.xterm-viewport');
  return { cols: term.cols, rows: term.rows, widestDrawn: widest, blankTop,
           bufLen: buf.length, viewportY: buf.viewportY,
           scrollGap: vp ? Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight) : null };
})()`;

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'hidden',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WS, CLAUDE_HUB_NO_EFFORT_MAX: '1' },
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

    await client.send('Emulation.setDeviceMetricsOverride',
      { width: 1700, height: 1300, deviceScaleFactor: 0, mobile: false });
    await _waitMs(600);

    // 会话 A（要观察的那个）
    const a = await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('A');
      const s = await window.WorkspaceController.createSession(${JSON.stringify(KIND)}, { workspace: w });
      return { id: s.id };
    })()`);
    await waitFor('A drawn', async () => {
      const m = await client.eval(MEASURE);
      return m && !m.error && m.widestDrawn > 30;
    });
    await _waitMs(4000);
    const before = await client.eval(MEASURE);

    // 会话 B —— 建出来后 A 变成隐藏态
    await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('B');
      await window.WorkspaceController.createSession(${JSON.stringify(KIND)}, { workspace: w });
      return true;
    })()`);
    await _waitMs(6000);

    // A 隐藏期间大幅改窗口
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: 820, height: 560, deviceScaleFactor: 0, mobile: false });
    await _waitMs(4000);

    // 切回 A
    const switched = await client.eval(`(() => {
      const items = Array.from(document.querySelectorAll('.session-item'));
      const t = items[0];
      if (t) t.click();
      return items.length;
    })()`);
    await _waitMs(6000);
    const after = await client.eval(MEASURE);

    console.log(`kind = ${KIND} | 侧栏条目 ${switched}`);
    console.log(`隐藏前 : xterm ${before.cols}x${before.rows} | TUI 画到 ${before.widestDrawn} 列 | 顶部空白 ${before.blankTop}`);
    console.log(`切回后 : xterm ${after.cols}x${after.rows} | TUI 画到 ${after.widestDrawn} 列 | 顶部空白 ${after.blankTop} | bufLen=${after.bufLen} vpY=${after.viewportY} 距底=${after.scrollGap}px`);
    console.log('');
    const widthOk = Math.abs(after.widestDrawn - after.cols) <= 2;
    console.log(widthOk ? '✅ 切回后 TUI 宽度跟上了' : `❌ 切回后 TUI 仍按旧宽度画（画到 ${after.widestDrawn}，终端 ${after.cols}）`);
    console.log(after.blankTop <= 3 ? '✅ 无顶部大片空白' : `❌ 复现顶部空白 ${after.blankTop} 行`);
    if (!widthOk || after.blankTop > 3) process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
