'use strict';
// 补上此前所有复现尝试都缺的变量：**大滚动缓冲**。
// 用户截图是 5 分钟长对话（Context 已用 22%），而我之前的测试会话只有启动横幅，
// bufLen 只有几十行。这里让真实 Codex 先产出几百行输出，再做 resize / 切换，
// 在真实的大缓冲条件下量顶部空白。
//   node tests/diag-real-cli-bigbuffer.js [codex|kimi]

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const KIND = process.argv[2] === 'kimi' ? 'kimi' : 'codex';
const ROOT = path.join(os.tmpdir(), `hub-bigbuf-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(e => (e ? reject(e) : resolve(a.port))); });
  });
}

async function waitFor(label, fn, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(250);
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
           bufLen: buf.length, viewportY: buf.viewportY, baseY: buf.baseY,
           scrollGap: vp ? Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight) : null };
})()`;

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'bigbuf',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WS, CLAUDE_HUB_NO_EFFORT_MAX: '1' },
  });
  let client = null;
  const steps = [];
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

    const s = await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('bigbuf');
      const s = await window.WorkspaceController.createSession(${JSON.stringify(KIND)}, { workspace: w });
      return { id: s.id };
    })()`);
    await waitFor('tui drawn', async () => {
      const m = await client.eval(MEASURE);
      return m && !m.error && m.widestDrawn > 30;
    });
    await _waitMs(5000);

    const snap = async label => { const m = await client.eval(MEASURE); steps.push({ label, ...m }); return m; };
    const resize = async (w, h) => {
      await client.send('Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: 0, mobile: false });
      await _waitMs(5000);
    };

    await snap('1-启动完成');

    // 造大缓冲：让 Codex 跑一条只产出文本的本地命令（不联网、不写文件）
    const prompt = '请直接运行这条 PowerShell 命令并结束：1..400 ^| ForEach-Object { "bigbuffer line $_" }';
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(s.id)}, data: ${JSON.stringify(prompt)} });
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(s.id)}, data: '\\r' }), 400);
      return true;
    })()`);

    // 等缓冲显著变大
    const grew = await waitFor('buffer grew', async () => {
      const m = await client.eval(MEASURE);
      return m && !m.error && m.bufLen > 250 ? m : null;
    }, 180000).catch(() => null);
    await _waitMs(8000);
    const big = await snap('2-大缓冲已形成');
    console.log(`   （缓冲行数 ${big.bufLen}${grew ? '' : ' —— 未达预期，后续结果参考价值下降'}）`);

    await resize(900, 1300);  await snap('3-变窄');
    await resize(900, 520);   await snap('4-再变矮');
    await resize(1700, 1400); await snap('5-放大回去');
    await resize(1250, 900);  await snap('6-中等');

    console.log(`\nkind = ${KIND}\n--- 每步 ---`);
    for (const st of steps) {
      if (st.error) { console.log(`${st.label}: ${st.error}`); continue; }
      console.log(`${st.label}: xterm ${st.cols}x${st.rows} | TUI 画到 ${st.widestDrawn} 列 | `
        + `顶部空白 ${st.blankTop} 行 | bufLen=${st.bufLen} baseY=${st.baseY} vpY=${st.viewportY} 距底=${st.scrollGap}px`);
    }
    const usable = steps.filter(x => !x.error);
    const blanks = usable.filter(x => x.blankTop > 3);
    const widthBad = usable.filter(x => Math.abs(x.widestDrawn - x.cols) > 2);
    console.log('');
    console.log(widthBad.length === 0 ? '✅ 每步 TUI 宽度都跟上了终端'
      : `❌ 宽度不符: ${widthBad.map(x => x.label).join(' , ')}`);
    console.log(blanks.length === 0 ? '✅ 未出现顶部大片空白'
      : `❌ 复现顶部空白: ${blanks.map(x => `${x.label}(${x.blankTop}行)`).join(' , ')}`);
    if (blanks.length > 0 || widthBad.length > 0) process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
