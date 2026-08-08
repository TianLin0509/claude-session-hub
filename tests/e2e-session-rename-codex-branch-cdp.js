'use strict';
// 回答「codex-resume / 分支会话能不能点标题改名」——用真实隔离 Hub 走完整 UI 路径。
//
// 走的是用户实际的操作链，不是直接调 IPC：
//   点 .terminal-title → 出现 .terminal-title-input → 输入 → Enter → 标题落地 + userRenamed 落盘
//
// 覆盖四种形态：
//   codex          —— 基线
//   codex-resume   —— 用户明确问到的那一种
//   codex 分支     —— 带 branchSourceSessionId + branchAutoTitlePending 的会话
//   claude 分支    —— 另一条分支路径，确认不是 codex 专属行为
//
// 分支会话这里按 fork-session 的产物形态直接构造，不走真实 fork：fork-session 要求
// 源会话已经绑定原生 session id（ccSessionId / codexSid），而那要等 CLI 真的答完一轮。
// 改名路径只关心 kind / readOnly / branch* 这几个字段，构造出同样的形态即可等价，
// 顺带把「没答过话的会话不能拉分支」这条实测结论一并记进报告。
//
// 隔离要求同 e2e-session-family-filter-cdp.js：CLAUDE_HUB_DATA_DIR + CLAUDE_HUB_HOME_DIR
// + 空 DEEPSEEK_API_KEY，否则梦境调度器会扫真实 home。

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(HUB_ROOT, 'output', 'playwright', 'session-rename-codex-branch-e2e.png');

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
  throw new Error(`Timed out waiting for: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
}

// 完整走一遍用户的改名手势，返回过程中每一步的观察值。
function renameViaUi(sessionId, newTitle) {
  return `(async () => {
    const out = { sessionId: ${JSON.stringify(sessionId)} };
    const span = document.querySelector('.terminal-title');
    if (!span) return { ...out, error: 'no .terminal-title in DOM' };
    out.titleBefore = span.textContent;
    out.tooltip = span.title;
    out.clickable = span.title !== '只读会话';

    span.click();
    await new Promise(r => setTimeout(r, 120));
    const input = document.querySelector('.terminal-title-input');
    if (!input) return { ...out, error: 'click did not open .terminal-title-input' };
    out.inputAppeared = true;
    out.inputValue = input.value;

    input.value = ${JSON.stringify(newTitle)};
    // startRename 在 blur 上提交，Enter 只是调用 input.blur()。CDP 里窗口没有真实
    // 焦点时 focus()/blur() 是 no-op，blur 事件不会触发——这是测试环境的限制，不是
    // 产品行为。所以先发 Enter 走真实路径，若输入框还在就补一个 blur 事件兜底，
    // 并记录到底是哪条路径提交的。
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    out.committedByEnter = !document.querySelector('.terminal-title-input');
    if (!out.committedByEnter) {
      input.dispatchEvent(new FocusEvent('blur'));
      await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 500));

    const after = document.querySelector('.terminal-title');
    out.titleAfterDom = after ? after.textContent : null;
    const sidebar = [...document.querySelectorAll('#session-list .sl-title')].map(e => e.textContent.trim());
    out.inSidebar = sidebar.some(t => t.includes(${JSON.stringify(newTitle)}));
    return out;
  })()`;
}

const READ_MAIN_STATE = `(async () => {
  const all = await require('electron').ipcRenderer.invoke('get-sessions');
  return all.map(s => ({ id: s.id, kind: s.kind, title: s.title, userRenamed: !!s.userRenamed,
                          branchSourceSessionId: s.branchSourceSessionId || null }));
})()`;

(async () => {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-rename-${process.pid}-${Date.now()}`);
  const homeDir = path.join(dataDir, 'home');
  const workDir = path.join(dataDir, 'work');
  const port = await getFreePort();
  let hub = null;
  let client = null;
  const sessionIds = [];
  const report = {};

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    hub = await launchIsolatedHub({
      dataDir, port, label: 'session-rename',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: homeDir, DEEPSEEK_API_KEY: '' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await waitFor(client, `document.querySelector('#session-list')`);

    // --- 起源会话：codex / codex-resume / claude ---
    const created = {};
    for (const [key, kind] of [['codex', 'codex'], ['codexResume', 'codex-resume'], ['claude', 'claude']]) {
      const s = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
        kind: ${JSON.stringify(kind)},
        opts: { title: ${JSON.stringify('RENAME-SRC-' + kind.toUpperCase())}, cwd: ${JSON.stringify(workDir)} }
      })`);
      assert.ok(s && s.id, `create-session(${kind}) failed: ${JSON.stringify(s)}`);
      created[key] = s.id;
      sessionIds.push(s.id);
    }

    // 先记录真实 fork 的行为（源会话还没答过话，预期是 native-session-id-missing）。
    report.realForkAttempt = await client.eval(`require('electron').ipcRenderer.invoke('fork-session', {
      sourceSessionId: ${JSON.stringify(created.codex)}
    })`);

    // --- 构造两个分支形态的会话 ---
    const branches = {};
    for (const [key, kind] of [['codex', 'codex'], ['claude', 'claude']]) {
      const s = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
        kind: ${JSON.stringify(kind)},
        opts: {
          title: ${JSON.stringify('分支: RENAME-SRC-' + kind.toUpperCase())},
          cwd: ${JSON.stringify(workDir)},
          branchSourceSessionId: ${JSON.stringify(created[key])},
          branchAutoTitlePending: true
        }
      })`);
      assert.ok(s && s.id, `create branch(${kind}) failed: ${JSON.stringify(s)}`);
      assert.strictEqual(s.branchSourceSessionId, created[key],
        `分支形态未建立（branchSourceSessionId 没落上）：${JSON.stringify(s)}`);
      branches[key] = s.id;
      sessionIds.push(s.id);
    }
    report.beforeRename = await client.eval(READ_MAIN_STATE);

    // --- 逐个选中并用 UI 手势改名 ---
    const targets = [
      { label: 'codex 会话', id: created.codex, newTitle: 'RN-CODEX-改名成功' },
      { label: 'codex-resume 会话', id: created.codexResume, newTitle: 'RN-CODEXRESUME-改名成功' },
      { label: 'codex 分支', id: branches.codex, newTitle: 'RN-CODEX-BRANCH-改名成功' },
      { label: 'claude 分支', id: branches.claude, newTitle: 'RN-CLAUDE-BRANCH-改名成功' },
    ];
    report.renames = {};
    for (const t of targets) {
      await client.eval(`window.selectSession(${JSON.stringify(t.id)})`);
      await waitFor(client, `document.querySelector('.terminal-title')`);
      await _waitMs(300);
      const result = await client.eval(renameViaUi(t.id, t.newTitle));
      report.renames[t.label] = result;
      assert.ok(!result.error, `${t.label}: ${result.error}`);
      assert.ok(result.clickable, `${t.label}: 标题不可点（被当成只读会话）`);
      assert.ok(result.inputAppeared, `${t.label}: 点击后没有出现改名输入框`);
      assert.strictEqual(result.titleAfterDom, t.newTitle, `${t.label}: 顶栏标题没有更新`);
      assert.ok(result.inSidebar, `${t.label}: 侧栏列表没有跟着更新`);
    }

    // --- 主进程状态：标题落地 + userRenamed 置位（这是防自动改名覆盖的关键）---
    const after = await client.eval(READ_MAIN_STATE);
    report.afterRename = after;
    for (const t of targets) {
      const s = after.find(x => x.id === t.id);
      assert.ok(s, `${t.label}: 主进程里找不到该会话`);
      assert.strictEqual(s.title, t.newTitle, `${t.label}: 主进程标题未更新（拿到 ${s.title}）`);
      assert.strictEqual(s.userRenamed, true,
        `${t.label}: userRenamed 未置位 —— 自动标题会在之后把用户改的名字覆盖掉`);
    }

    const rect = await client.eval(`(() => {
      const r = document.querySelector('#session-sidebar').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 360) };
    })()`);
    const shot = await client.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, clip: { ...rect, scale: 2 },
    });
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      renames: report.renames,
      afterRename: report.afterRename.filter(s => /^RN-/.test(s.title || '')),
      screenshot: SCREENSHOT_PATH,
      isolatedDataDir: dataDir,
      isolatedHubPid: hub.pid,
      hubLogTail: hub.log().slice(-6),
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    console.error('--- report so far ---');
    console.error(JSON.stringify(report, null, 2).slice(0, 4000));
    if (hub) console.error(hub.log().slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) {
      for (const id of sessionIds) {
        try { await client.eval(`require('electron').ipcRenderer.invoke('delete-session', ${JSON.stringify(id)})`); } catch {}
      }
      try { await client.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-rename-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
})();
