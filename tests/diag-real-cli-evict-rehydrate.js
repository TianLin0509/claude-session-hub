'use strict';
// 端到端复现「顶部大片空白」：真实 Codex + 大输出 + 终端缓存驱逐后的快照重建。
// ef31eb2 引入 MAX_TERMINAL_CACHE_SIZE=4，会话超过 4 个时切换会丢弃 xterm 并用
// 环形缓冲的原始 PTY 字节重放重建；缓冲按字节尾切，切掉 \x1b[2J 之后只剩绝对定位
// 序列 → 内容落在指定行、上方全空。
//   node tests/diag-real-cli-evict-rehydrate.js

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-evict-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');
const SESSIONS = 6;   // > MAX_TERMINAL_CACHE_SIZE(4)

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
  let blankTop = 0;
  for (let i = 0; i < term.rows; i++) {
    const l = buf.getLine(buf.viewportY + i);
    const t = l ? l.translateToString(true) : '';
    if (t.trim()) break;
    blankTop++;
  }
  let nonEmpty = 0;
  for (let i = 0; i < term.rows; i++) {
    const l = buf.getLine(buf.viewportY + i);
    if (l && l.translateToString(true).trim()) nonEmpty++;
  }
  return { cols: term.cols, rows: term.rows, blankTop, nonEmpty,
           bufLen: buf.length, viewportY: buf.viewportY, liveTerms: (window.__diagTerms || []).length };
})()`;

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'evict',
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
      { width: 1600, height: 1200, deviceScaleFactor: 0, mobile: false });
    await _waitMs(600);

    // 第一个会话：真实 Codex，产出大量输出把环形缓冲塞满
    const first = await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('S0');
      const s = await window.WorkspaceController.createSession('codex', { workspace: w });
      return { id: s.id };
    })()`);
    await waitFor('S0 drawn', async () => {
      const m = await client.eval(MEASURE);
      return m && !m.error && m.nonEmpty > 5;
    });
    await _waitMs(4000);

    const prompt = '直接运行这条 PowerShell 命令后结束：1..600 ^| ForEach-Object { "filler line $_ ------------------------------" }';
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(first.id)}, data: ${JSON.stringify(prompt)} });
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(first.id)}, data: '\\r' }), 500);
      return true;
    })()`);
    await waitFor('buffer filled', async () => {
      const m = await client.eval(MEASURE);
      return m && !m.error && m.bufLen > 400;
    }, 180000).catch(() => null);
    await _waitMs(10000);
    const before = await client.eval(MEASURE);

    // 再建 5 个 powershell 会话把 S0 挤出终端缓存（便宜，不消耗额度）
    for (let i = 1; i < SESSIONS; i++) {
      await client.eval(`(async () => {
        const w = await window.WorkspaceController.createScratch('S${i}');
        await window.WorkspaceController.createSession('powershell', { workspace: w });
        return true;
      })()`);
      await _waitMs(1200);
    }
    await _waitMs(2000);

    // 切回 S0 —— 此时它的 xterm 已被驱逐，只能靠快照重建
    await client.eval(`(() => {
      const items = Array.from(document.querySelectorAll('.session-item'));
      const t = items[items.length - 1];
      if (t) t.click();
      return items.length;
    })()`);
    await _waitMs(8000);
    const after = await client.eval(MEASURE);

    console.log(`驱逐前 : xterm ${before.cols}x${before.rows} | 顶部空白 ${before.blankTop} | 非空行 ${before.nonEmpty} | bufLen=${before.bufLen} | 活terminal ${before.liveTerms}`);
    console.log(`重建后 : xterm ${after.cols}x${after.rows} | 顶部空白 ${after.blankTop} | 非空行 ${after.nonEmpty} | bufLen=${after.bufLen} | 活terminal ${after.liveTerms}`);
    console.log('');
    const evicted = after.liveTerms > before.liveTerms + SESSIONS - 2;
    console.log(evicted ? '（已确认发生了驱逐+重建）' : '（未发生驱逐，本轮不作数）');
    if (after.blankTop > 3) {
      console.log(`❌ 复现：重建后顶部有 ${after.blankTop} 行空白`);
      process.exitCode = 1;
    } else {
      console.log(`✅ 重建后顶部空白 ${after.blankTop} 行，内容完整（非空 ${after.nonEmpty} 行）`);
    }
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
