'use strict';
// 「恢复历史会话」picker 必须能看到全部目录的会话。
//
// 背景：会话以前都在用户主目录下，picker 一开就能凭记忆挑。改用 C:\Vibe\_scratch\*
// 之后，各家 picker 默认只列当前目录 → 里面几乎什么都没有。
// Codex 和 Kimi 各自内置了"看全部"开关（实测：Codex 右方向键、Kimi Ctrl+A），
// Hub 在 picker 画出来后替用户按一下。
//
//   node tests/e2e-resume-picker-global-cdp.js [codex|kimi]

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const KIND = process.argv[2] === 'kimi' ? 'kimi' : 'codex';
const ROOT = path.join(os.tmpdir(), `hub-picker-${Date.now()}-${process.pid}`);
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
    await _waitMs(250);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

// 读当前终端缓冲的全部可见文本
const READ_TEXT = `(() => {
  const terms = (window.__diagTerms || []).filter(t => t.element && t.element.offsetParent !== null);
  const term = terms[0];
  if (!term) return { error: 'no visible terminal' };
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const l = buf.getLine(i);
    if (l) out.push(l.translateToString(true));
  }
  return { text: out.join('\\n') };
})()`;

async function main() {
  fs.mkdirSync(WS, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: path.join(ROOT, 'hub-data'), port, label: 'picker',
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

    // 直接以 picker kind 建会话（Hub 侧栏「恢复历史会话」走的就是这条路）
    await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('create-session', { kind: ${JSON.stringify(`${KIND}-resume`)}, opts: {} });
      return true;
    })()`);

    // 判据必须排除 picker 自己的 cwd。resume picker 启动在 USERPROFILE
    // （C:\Users\lintian），那本来就是老会话所在地——把它算进"跨目录"会让测试
    // 在关掉自动展开时照样通过（2026-07-28 反向验证踩过这个坑）。
    // 真正的判据：出现 C:\Vibe\ 下的会话，那只有 All 视图才看得到。
    const OUTSIDE_RE = /C:[\\/]Vibe[\\/][^\s│|]*/g;
    const collect = text => Array.from(new Set((text.match(OUTSIDE_RE) || [])
      .map(s => s.replace(/[.,)\]]+$/, ''))));

    const found = await waitFor('picker shows sessions outside its cwd', async () => {
      const r = await client.eval(READ_TEXT);
      if (!r || r.error) return null;
      const hits = collect(r.text);
      return hits.length >= 1 ? hits : null;
    }, 90000).catch(() => null);

    const final = await client.eval(READ_TEXT);
    const text = (final && final.text) || '';
    const uniq = found || collect(text);
    const counter = (text.match(/Showing\s+\d+-\d+\s+of\s+\d+|\d+\s*\/\s*\d+\s*·/i) || [])[0] || '(无计数行)';
    const cwdOnly = /Filter:\s*\[Cwd\]/i.test(text);

    console.log(`kind = ${KIND}-resume`);
    console.log(`picker 计数行     : ${counter}`);
    console.log(`Filter 仍停在 Cwd : ${cwdOnly}`);
    console.log(`C:\\Vibe 下的会话  : ${uniq.length} 个`);
    uniq.slice(0, 5).forEach(p => console.log(`   ${p}`));
    console.log('');

    // Codex 的 picker 列的是会话标题而非路径，All 模式下也不会渲染 C:\Vibe\...，
    // 所以路径命中只能当辅助信号。真正有牙齿的判据是 Filter 的选中态本身
    // （已双向验证：开启自动展开 → false，关掉 → true）。
    // Codex 计数形如 `1 / 50 ·`，Kimi 形如 `Showing 1-4 of 30 sessions`
    const total = Number(
      (text.match(/\d+\s*\/\s*(\d+)\s*·/) || [])[1]
      || (text.match(/Showing\s+\d+-\d+\s+of\s+(\d+)/i) || [])[1]
      || 0);
    // Kimi 默认视图在别处目录会直接显示 "No sessions found."
    const kimiEmpty = /No sessions found/i.test(text);

    if (KIND === 'codex') {
      // 有牙齿的判据：Filter 的选中态（已双向验证：开启→false，关掉→true）
      assert.ok(!cwdOnly, 'Filter 仍停在 Cwd —— 自动展开没生效，用户必须先想起路径才能恢复历史会话');
    } else {
      assert.ok(!kimiEmpty, 'picker 仍显示「No sessions found」—— Ctrl+A 展开没生效');
      assert.ok(uniq.length >= 1, 'picker 里看不到 C:\\Vibe 下的会话，仍是当前目录视图');
    }
    assert.ok(total >= 2 || uniq.length >= 1,
      `picker 只列出了 ${total} 条会话，看起来仍是当前目录视图`);
    console.log(`✅ picker 已展开为全局视图（共列出 ${total} 条会话，跨目录条目 ${uniq.length} 个）`);
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('E2E FAILED:', e && e.message); process.exitCode = 1; });
