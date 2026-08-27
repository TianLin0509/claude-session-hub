'use strict';

// 全机残留卡片的端到端验证。
//
// 最要紧的一条断言在 STEP 5：**活跃会话的 pty 进程绝不能出现在任何可回收项里**。
// 这个功能唯一会真正伤到用户的失误就是把在跑的会话外壳当成垃圾，
// 所以这条不变量必须由测试守住，不能靠人肉 review。
//
// 步骤顺序有讲究：UI 交互必须在建会话**之前**做完。Hub 打开会话时会把整个主页
// （#empty-state 子树）从文档里摘下来，那之后 document.querySelector 找不到卡片。

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(client, expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch (err) { lastError = err; }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
}

(async () => {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-reclaim-${process.pid}-${Date.now()}`);
  const workDir = path.join(dataDir, 'work');
  const port = await getFreePort();
  let hub = null;
  let client = null;
  const sessionIds = [];

  try {
    fs.mkdirSync(workDir, { recursive: true });
    hub = await launchIsolatedHub({ dataDir, port, label: 'process-reclaim', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // ── STEP 1：卡片存在，且初始是「还没扫描过」的空态 ──────────
    await waitFor(client, `document.querySelector('[data-home-card="reclaim"]')`);
    await waitFor(client, `/还没扫描过/.test(document.querySelector('#home-reclaim-summary')?.innerText || '')`);
    console.log('STEP 1 ok — 卡片存在且初始为空态');

    // ── STEP 2：点「扫描」，UI 真的把结果渲染出来 ────────────────
    await client.eval(`document.querySelector('[data-reclaim-action="scan"]').click()`);
    await waitFor(client, `/正在扫描/.test(document.querySelector('#home-reclaim-summary')?.innerText || '')`, 10_000);
    await waitFor(client, `!/正在扫描/.test(document.querySelector('#home-reclaim-summary')?.innerText || '')`);

    const summaryText = await client.eval(`document.querySelector('#home-reclaim-summary')?.innerText || ''`);
    assert.ok(/未发现残留|检出 \d+ 个残留进程/.test(summaryText), `摘要行渲染异常: ${summaryText}`);
    const guardText = await client.eval(`document.querySelector('#home-reclaim-guard')?.innerText || ''`);
    assert.ok(/已保护 \d+ 个进程/.test(guardText), `保护区未渲染: ${guardText}`);
    console.log(`STEP 2 ok — UI 摘要「${summaryText.split('\n')[0]}」`);

    // ── STEP 3：报告结构自洽 ────────────────────────────────────
    const report = await client.eval(
      `require('electron').ipcRenderer.invoke('get-process-reclaim-report', { force: false })`,
    );
    assert.ok(report && report.ok, `扫描失败: ${JSON.stringify(report && report.error)}`);
    assert.ok(report.totals.processes > 50, `全机进程数看起来不对: ${report.totals.processes}`);
    // 全机至少有本实例这一个 Hub；生产实例若在跑，也必须一并被认出来。
    assert.ok(report.totals.hubAlive >= 1, `活着的 Hub 至少应有 1 个，实际 ${report.totals.hubAlive}`);
    assert.ok(report.totals.protectedCount > 0, '保护区不应为空');
    console.log(`STEP 3 ok — 全机 ${report.totals.processes} 进程 / ${report.totals.hubAlive} 个 Hub 在跑 / `
      + `保护 ${report.totals.protectedCount} / 可回收 ${report.totals.reclaimableCount} 个 `
      + `${(report.totals.reclaimableBytes / 1048576).toFixed(0)} MB`);

    // ── STEP 4：勾选 → 出预演脚本 → 落盘带 BOM、默认 WhatIf ─────
    if (report.totals.reclaimableCount > 0) {
      await client.eval(`document.querySelector('[data-reclaim-action="select-all"]').click()`);
      const saved = await client.eval(
        `require('electron').ipcRenderer.invoke('save-process-reclaim-script', {})`,
      );
      assert.ok(saved && saved.ok && saved.filePath, `预演脚本落盘失败: ${JSON.stringify(saved)}`);
      assert.ok(fs.existsSync(saved.filePath), `脚本文件不存在: ${saved.filePath}`);

      const buffer = fs.readFileSync(saved.filePath);
      assert.deepStrictEqual([buffer[0], buffer[1], buffer[2]], [0xEF, 0xBB, 0xBF],
        '脚本必须带 UTF-8 BOM，否则 PowerShell 5.1 读中文会直接解析崩');

      const text = buffer.toString('utf8');
      assert.ok(/\$WhatIfOnly = \$true/.test(text), '预演脚本默认必须是 WhatIf 模式');
      assert.ok(/PID 已被复用/.test(text), '脚本必须带 PID 复用校验');
      assert.ok(!new RegExp(`ProcessId = ${report.selfPid};`).test(text), '预演脚本里出现了 Hub 自身 PID');
      console.log(`STEP 4 ok — 预演脚本 ${saved.itemCount} 项 / ${saved.processCount} 进程，BOM + WhatIf + 防复用校验通过`);
    } else {
      console.log('STEP 4 skip — 本机当前没有残留，无脚本可生成');
    }

    // ── STEP 5：安全底线 —— 活跃会话绝不能被算成可回收 ──────────
    for (const title of ['Reclaim guard A', 'Reclaim guard B']) {
      const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
        kind: 'powershell',
        opts: { title: ${JSON.stringify(title)}, cwd: ${JSON.stringify(workDir)} }
      })`);
      assert.ok(session && session.id, `会话创建失败: ${JSON.stringify(session)}`);
      sessionIds.push(session.id);
    }
    await _waitMs(1500);

    const after = await client.eval(
      `require('electron').ipcRenderer.invoke('get-process-reclaim-report', { force: true })`,
    );
    assert.ok(after && after.ok, `二次扫描失败: ${JSON.stringify(after && after.error)}`);
    assert.strictEqual(after.liveSessionsKnown, true, '本实例必须能报出活跃会话名单');

    const livePtyPids = after.liveSessionPids || [];
    assert.ok(livePtyPids.length >= sessionIds.length,
      `应至少报出 ${sessionIds.length} 个活跃 pty PID，实际 ${livePtyPids.length}`);

    const reclaimablePids = new Set();
    for (const bucket of after.groups.deadHub || []) {
      for (const item of bucket.items || []) for (const pid of item.pids || []) reclaimablePids.add(pid);
    }
    for (const item of [...(after.groups.endedSession || []), ...(after.groups.unattributed || [])]) {
      for (const pid of item.pids || []) reclaimablePids.add(pid);
    }

    const leaked = livePtyPids.filter(pid => reclaimablePids.has(pid));
    assert.deepStrictEqual(leaked, [],
      `活跃会话的 pty 进程被算进了可回收，这是本功能最严重的失误: ${leaked.join(', ')}`);
    assert.ok(!reclaimablePids.has(after.selfPid), '当前 Hub 主进程被算进了可回收，严重错误');
    console.log(`STEP 5 ok — 可回收 ${reclaimablePids.size} 个 PID，与 ${livePtyPids.length} 个活跃 pty 零交集`);

    console.log('\n全部通过 ✓');
  } finally {
    if (client) {
      for (const id of sessionIds) {
        try { await client.eval(`require('electron').ipcRenderer.invoke('close-session', ${JSON.stringify(id)})`); } catch {}
      }
      try { await client.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => {
  console.error('E2E FAILED:', err && err.message);
  process.exit(1);
});
