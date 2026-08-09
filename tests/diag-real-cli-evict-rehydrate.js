'use strict';
// 端到端复现「顶部大片空白」：真实 Codex + 大输出 + 显式 xterm 重建。
// 生产缓存现在跟随 Session 生命周期，不再按数量驱逐 live xterm；隔离测试通过
// E2E hook 显式销毁首个 xterm，继续覆盖 renderer reload/丢失后的快照恢复。
//   node tests/diag-real-cli-evict-rehydrate.js

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-evict-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');
const SESSIONS = 6;

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
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WS,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
      CLAUDE_HUB_E2E: '1',
    },
  });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));
    await waitFor('wc', () => client.eval('!!(window.WorkspaceController && window.WorkspaceController.createScratch)'));
    await waitFor('e2e terminal API', () => client.eval('!!(window.__hubE2E && window.__hubE2E.disposeTerminal)'));
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

    // 再建 5 个 powershell 会话模拟多 Session 切换（便宜，不消耗额度）
    for (let i = 1; i < SESSIONS; i++) {
      await client.eval(`(async () => {
        const w = await window.WorkspaceController.createScratch('S${i}');
        await window.WorkspaceController.createSession('powershell', { workspace: w });
        return true;
      })()`);
      await _waitMs(1200);
    }
    await _waitMs(2000);

    // 生产不会驱逐 live xterm；隔离测试显式销毁 S0 后再靠快照重建。
    await client.eval(`window.__hubE2E.disposeTerminal(${JSON.stringify(first.id)})`);
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(first.id)}, { forceScrollBottom: true })`);
    await _waitMs(8000);
    const after = await client.eval(MEASURE);

    console.log(`重建前 : xterm ${before.cols}x${before.rows} | 顶部空白 ${before.blankTop} | 非空行 ${before.nonEmpty} | bufLen=${before.bufLen} | 活terminal ${before.liveTerms}`);
    console.log(`重建后 : xterm ${after.cols}x${after.rows} | 顶部空白 ${after.blankTop} | 非空行 ${after.nonEmpty} | bufLen=${after.bufLen} | 活terminal ${after.liveTerms}`);
    console.log('');
    console.log('（已通过隔离 E2E hook 显式触发快照重建）');
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
