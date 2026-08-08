'use strict';
// 侧栏 AI 家族筛选页签的真实 Hub 验证（隔离实例 + CDP）。
//
// 验证链条：起 claude / codex / powershell 三种真实会话 → 页签计数对得上 →
//   点 Claude 页签只剩 Claude 会话 → 点 Codex 只剩 Codex → 点「其他」只剩 powershell
//   → 选择落盘 localStorage → 截图。
//
// 隔离要求（CLAUDE.md 血泪 2026-08-01）：CLAUDE_HUB_DATA_DIR 只隔 Hub 自身状态，
//   梦境调度器的 home 仍指真实用户目录，所以必须同时给 CLAUDE_HUB_HOME_DIR 与
//   空 DEEPSEEK_API_KEY，否则隔离实例会扫真实 memory 并触发真实 LLM 调用。

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(HUB_ROOT, 'output', 'playwright', 'session-family-filter-e2e.png');

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

async function waitFor(client, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch (error) { lastError = error; }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for: ${expression}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

// 页签文本 → { label: count }，同时带上当前选中的 key。
const READ_TABS = `(() => {
  const tabs = [...document.querySelectorAll('#session-filter-tabs .session-filter-tab')];
  const counts = {};
  for (const tab of tabs) counts[tab.dataset.family] = Number(tab.querySelector('.sft-count')?.textContent || 0);
  return {
    order: tabs.map(t => t.textContent.replace(/\\d+$/, '').trim()),
    counts,
    selected: tabs.find(t => t.getAttribute('aria-selected') === 'true')?.dataset.family || null,
  };
})()`;

// 侧栏当前实际列出的会话标题（排除分区头/时间组头/空提示）。
const READ_LISTED = `[...document.querySelectorAll('#session-list .session-item .sl-title')]
  .map(el => el.textContent.trim())`;

function clickTab(family) {
  return `(() => {
    const btn = document.querySelector('#session-filter-tabs [data-family="${family}"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`;
}

(async () => {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-family-filter-${process.pid}-${Date.now()}`);
  const homeDir = path.join(dataDir, 'home');
  const workDir = path.join(dataDir, 'work');
  const port = await getFreePort();
  let hub = null;
  let client = null;
  const sessionIds = [];

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'session-family-filter',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: homeDir, DEEPSEEK_API_KEY: '' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await waitFor(client, `document.querySelector('#session-filter-tabs')`);

    // 三种 kind 各起一个真实会话：claude → Claude 族，codex → Codex 族，powershell → 其他。
    const plan = [
      { kind: 'claude', title: 'FAMFILTER-CLAUDE', family: 'claude' },
      { kind: 'codex', title: 'FAMFILTER-CODEX', family: 'codex' },
      { kind: 'powershell', title: 'FAMFILTER-SHELL', family: 'other' },
    ];
    for (const item of plan) {
      const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
        kind: ${JSON.stringify(item.kind)},
        opts: { title: ${JSON.stringify(item.title)}, cwd: ${JSON.stringify(workDir)} }
      })`);
      assert.ok(session && session.id, `create-session(${item.kind}) failed: ${JSON.stringify(session)}`);
      sessionIds.push(session.id);
    }
    await waitFor(client, `(${READ_LISTED}).filter(t => t.startsWith('FAMFILTER-')).length === 3`);

    // --- 默认「全部」：计数与顺序 ---
    const initial = await client.eval(READ_TABS);
    assert.deepStrictEqual(initial.order, ['全部', 'Claude', 'Codex', '其他'], JSON.stringify(initial));
    assert.strictEqual(initial.selected, 'all', `默认应选中「全部」：${JSON.stringify(initial)}`);
    assert.strictEqual(initial.counts.claude, 1, JSON.stringify(initial));
    assert.strictEqual(initial.counts.codex, 1, JSON.stringify(initial));
    assert.strictEqual(initial.counts.other, 1, JSON.stringify(initial));
    assert.strictEqual(initial.counts.all, 3, JSON.stringify(initial));

    // --- 逐个页签：只剩本族会话，且计数不塌成「视图剩余」 ---
    const perTab = {};
    for (const item of plan) {
      assert.ok(await client.eval(clickTab(item.family)), `找不到 ${item.family} 页签`);
      await waitFor(client, `(${READ_LISTED}).filter(t => t.startsWith('FAMFILTER-')).length === 1`);
      const listed = (await client.eval(READ_LISTED)).filter(t => t.startsWith('FAMFILTER-'));
      const tabs = await client.eval(READ_TABS);
      assert.deepStrictEqual(listed, [item.title], `${item.family} 页应只剩 ${item.title}，实际 ${JSON.stringify(listed)}`);
      assert.strictEqual(tabs.selected, item.family, JSON.stringify(tabs));
      assert.strictEqual(tabs.counts.all, 3, `筛选后「全部」计数仍应是 3：${JSON.stringify(tabs)}`);
      assert.strictEqual(tabs.counts.claude, 1, `筛选后 Claude 计数仍应是 1：${JSON.stringify(tabs)}`);
      assert.strictEqual(tabs.counts.codex, 1, `筛选后 Codex 计数仍应是 1：${JSON.stringify(tabs)}`);
      perTab[item.family] = listed;
    }

    // --- 选择落盘：重新渲染后仍是上次选择 ---
    const persisted = await client.eval(`localStorage.getItem('hubSessionFamilyFilter')`);
    assert.strictEqual(persisted, 'other', `落盘值应为最后一次点击的 other，实际 ${persisted}`);

    // --- 回到「全部」并截图取证 ---
    await client.eval(clickTab('all'));
    await waitFor(client, `(${READ_LISTED}).filter(t => t.startsWith('FAMFILTER-')).length === 3`);
    const rect = await client.eval(`(() => {
      const sidebar = document.querySelector('#session-sidebar');
      const r = sidebar.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 420) };
    })()`);
    const shot = await client.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, clip: { ...rect, scale: 2 },
    });
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      initialTabs: initial,
      perTab,
      persisted,
      screenshot: SCREENSHOT_PATH,
      isolatedDataDir: dataDir,
      isolatedHubPid: hub.pid,
      cdpPort: port,
      hubLogTail: hub.log().slice(-8),
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) {
      for (const sessionId of sessionIds) {
        try { await client.eval(`require('electron').ipcRenderer.invoke('delete-session', ${JSON.stringify(sessionId)})`); } catch {}
      }
      try { await client.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-family-filter-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
})();
