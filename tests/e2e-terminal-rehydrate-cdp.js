'use strict';
// 终端显式重建后的内容保全（回归测试）。
//
// 生产缓存现在跟随 Session 生命周期，不再按数量驱逐仍存活的 xterm。Renderer
// reload/丢失仍需要用 SessionManager 快照恢复，因此这里通过隔离 E2E hook 显式
// 销毁一个 xterm，再验证重建内容不会大面积缺失或出现"大片空白"。
//
// 用 PowerShell 会话产出确定数量的可校验行（免费、不依赖任何模型），
// 显式重建后校验这些行还在不在。
//   node tests/e2e-terminal-rehydrate-cdp.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-rehydrate-${Date.now()}-${process.pid}`);
const WS = path.join(ROOT, 'workspaces');
const LINES = 400;

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
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

// 数缓冲里还剩多少条 REHYDRATE-MARK-<n>
const COUNT_MARKS = `(() => {
  const terms = (window.__diagTerms || []).filter(t => t.element && t.element.offsetParent !== null);
  const term = terms[0];
  if (!term) return { error: 'no visible terminal' };
  const buf = term.buffer.active;
  const seen = new Set();
  for (let i = 0; i < buf.length; i++) {
    const l = buf.getLine(i);
    if (!l) continue;
    const m = /REHYDRATE-MARK-(\\d+)/.exec(l.translateToString(true));
    if (m) seen.add(Number(m[1]));
  }
  let blankTop = 0;
  for (let i = 0; i < term.rows; i++) {
    const l = buf.getLine(buf.viewportY + i);
    const t = l ? l.translateToString(true) : '';
    if (t.trim()) break;
    blankTop++;
  }
  return { marks: seen.size, bufLen: buf.length, rows: term.rows,
           blankTop, liveTerms: (window.__diagTerms || []).length };
})()`;

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  const port = await reservePort();
    const hub = await launchIsolatedHub({
      dataDir: path.join(ROOT, 'hub-data'), port, label: 'rehydrate',
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
      { width: 1500, height: 1100, deviceScaleFactor: 0, mobile: false });
    await _waitMs(600);

    const s0 = await client.eval(`(async () => {
      const w = await window.WorkspaceController.createScratch('S0');
      const s = await window.WorkspaceController.createSession('powershell', { workspace: w });
      return { id: s.id };
    })()`);
    await _waitMs(3500);

    // 产出 LINES 行可校验内容
    const cmd = `1..${LINES} | ForEach-Object { "REHYDRATE-MARK-$_ ................................................" }`;
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(s0.id)}, data: ${JSON.stringify(cmd)} + '\\r' });
      return true;
    })()`);
    const filled = await waitFor('marks produced', async () => {
      const m = await client.eval(COUNT_MARKS);
      return m && !m.error && m.marks >= LINES * 0.9 ? m : null;
    }, 120000);
    await _waitMs(3000);
    const before = await client.eval(COUNT_MARKS);
    console.log(`重建前 : 可见标记 ${before.marks}/${LINES} | bufLen=${before.bufLen} | 活terminal ${before.liveTerms}`);

    // 生产路径不会再按数量驱逐；隔离测试显式销毁后重新选择 S0。
    const disposed = await client.eval(`window.__hubE2E.disposeTerminal(${JSON.stringify(s0.id)})`);
    assert.strictEqual(disposed, true, 'isolated E2E hook must dispose the selected xterm');
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(s0.id)}, { forceScrollBottom: true })`);
    await _waitMs(7000);
    const after = await client.eval(COUNT_MARKS);
    console.log(`重建后 : 可见标记 ${after.marks}/${LINES} | bufLen=${after.bufLen} | 顶部空白 ${after.blankTop} | 活terminal ${after.liveTerms}`);

    const kept = before.marks > 0 ? after.marks / before.marks : 0;
    console.log(`\n内容保全率: ${(kept * 100).toFixed(1)}%`);

    assert.ok(before.marks >= LINES * 0.9, `前置条件：重建前应看到约 ${LINES} 条标记，实际 ${before.marks}`);
    assert.ok(kept >= 0.9,
      `切回会话后内容大量丢失（${before.marks} → ${after.marks} 条），用户看到的就是大片空白`);
    assert.ok(after.blankTop <= 3, `切回后顶部空白 ${after.blankTop} 行`);
    console.log('✅ 显式重建终端后，内容完整保留');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('E2E FAILED:', e && e.message); process.exitCode = 1; });
