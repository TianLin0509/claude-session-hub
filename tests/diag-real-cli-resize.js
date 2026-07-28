'use strict';
// 决定性实验：真实 CLI 在 Hub 里被 resize 后，会不会重新按新尺寸排版？
// 合成探针已证明 Node 的 process.stdout.on('resize') 在 ConPTY 下不触发，
// 但真实 Codex/Kimi 可能有自己的尺寸查询路径。这条不确定不排掉，就没法选修复方案。
//
// 判据：TUI 的状态栏/边框宽度会随终端宽度变化。resize 后读 xterm 缓冲里
// 每行的实际字符跨度，看最宽的一行有没有跟着变。
//   node tests/diag-real-cli-resize.js [codex|kimi]

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const KIND = process.argv[2] === 'kimi' ? 'kimi' : 'codex';
const ROOT = path.join(os.tmpdir(), `hub-realcli-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(e => (e ? reject(e) : resolve(a.port))); });
  });
}

async function waitFor(label, fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

// 量 TUI 实际画到第几列：取缓冲里所有行的最右非空字符位置的最大值
const MEASURE = `(() => {
  const terms = (window.__diagTerms || []).filter(t => t.element && t.element.offsetParent !== null);
  const term = terms[0];
  if (!term) return { error: 'no terminal' };
  const buf = term.buffer.active;
  let widest = 0, sample = '';
  const start = Math.max(0, buf.length - term.rows);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const txt = line.translateToString(true);
    const w = txt.replace(/\\s+$/, '').length;
    if (w > widest) { widest = w; sample = txt.trim().slice(0, 40); }
  }
  // 视口内顶部有多少连续空行 —— 这正是用户看到的"大片空白"
  let blankTop = 0;
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    const txt = line ? line.translateToString(true) : '';
    if (txt.trim()) break;
    blankTop++;
  }
  const vp = term.element.querySelector('.xterm-viewport');
  return {
    cols: term.cols, rows: term.rows, widestDrawn: widest, sample,
    blankTop, bufLen: buf.length, viewportY: buf.viewportY,
    scrollGap: vp ? Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight) : null,
  };
})()`;

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'realcli',
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

    // 宽窗口起会话
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: 1700, height: 1000, deviceScaleFactor: 0, mobile: false });
    await _waitMs(600);

    await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('realcli');
      await window.WorkspaceController.createSession(${JSON.stringify(KIND)}, { workspace: w });
      return true;
    })()`);

    // 等 TUI 真正画出来（宽度稳定）
    await waitFor('tui drawn', async () => {
      const m = await client.eval(MEASURE);
      return m && !m.error && m.widestDrawn > 30;
    }, 90000);
    await _waitMs(4000);

    const steps = [];
    const snap = async label => {
      const m = await client.eval(MEASURE);
      steps.push({ label, ...m });
      return m;
    };
    const resize = async (w, h) => {
      await client.send('Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: 0, mobile: false });
      await _waitMs(5000);
    };

    await snap('1-初始(宽窗口)');
    await resize(900, 1000);  await snap('2-变窄');
    await resize(900, 500);   await snap('3-再变矮');
    await resize(1700, 1400); await snap('4-放大回去');
    await resize(1300, 900);  await snap('5-中等');

    console.log(`kind = ${KIND}\n--- 每步 ---`);
    for (const s of steps) {
      if (s.error) { console.log(`${s.label}: ${s.error}`); continue; }
      console.log(`${s.label}: xterm ${s.cols}x${s.rows} | TUI 画到 ${s.widestDrawn} 列 | `
        + `顶部空白 ${s.blankTop} 行 | bufLen=${s.bufLen} vpY=${s.viewportY} 距底=${s.scrollGap}px`);
    }
    const usable = steps.filter(s => !s.error);
    const widthOk = usable.every(s => Math.abs(s.widestDrawn - s.cols) <= 2);
    const blanks = usable.filter(s => s.blankTop > 3);
    console.log('');
    console.log(widthOk ? '✅ 每一步 TUI 宽度都跟上了终端' : '❌ 有步骤 TUI 宽度与终端不符');
    console.log(blanks.length === 0
      ? '✅ 未出现顶部大片空白'
      : `❌ 复现顶部空白：${blanks.map(b => `${b.label}(${b.blankTop}行)`).join(' , ')}`);
    if (blanks.length > 0) process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
