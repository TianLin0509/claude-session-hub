'use strict';

// 真机验证：隔离 Hub 里把一次真实的林铛决策采纳并打开，确认它是**左侧栏里的普通会话**。
//
// 为什么要真机：单元测试用的是假 sessionManager，证明不了「这个会话真的会出现在侧边栏」。
// 这里连的是生产 chuxin 后端（只读 /api/lindang/status），打开的是真的 claude --resume。
//
// 跑法：node tests/e2e-lindang-decision-session-cdp.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const PORT = 9341;
const DATA_DIR = path.join(os.tmpdir(), `hub-lindang-e2e-${process.pid}`);

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: PORT, label: 'lindang-e2e', windowMode: 'visible' });
  let client = null;
  try {
    client = await connectFirstPage(hub, (target) => target.type === 'page' && /renderer[\/]index\.html/.test(target.url || ''));

    const listed = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('chuxin:lindang-sessions');
    })()`);
    assert.ok(listed && listed.ok, `采纳失败：${JSON.stringify(listed)}`);
    assert.ok(listed.sessions.length > 0, '生产后端里应当有带会话身份的决策运行');
    const row = listed.sessions.find((item) => item.nativeSession && item.nativeSession.ccSessionId);
    assert.ok(row, '至少要有一条带原生会话的');
    console.log(`  采纳到 ${listed.sessions.length} 次决策；取最新一条：${row.title} → ${row.nativeSession.ccSessionId.slice(0, 8)}`);

    const opened = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('chuxin:open-lindang-session', { runId: ${JSON.stringify(row.lindangRunId)} });
    })()`);
    assert.ok(opened && opened.ok, `打开失败：${JSON.stringify(opened)}`);
    console.log(`  已开成 Hub 会话 ${opened.session.id}`);

    // 真正的判据：侧边栏的 DOM 里出现了这一条。会话表里 hidden=false 只是必要条件。
    const sid = JSON.stringify(opened.session.id);
    let item = null;
    for (let i = 0; i < 60; i += 1) {
      item = await client.eval(
        '(() => { const el = document.querySelector(".session-item[data-session-id=" + '
        + JSON.stringify(sid) + ' + "]"); '
        + 'return el ? { text: el.innerText.replace(/\\s+/g, " ").slice(0, 60) } : null; })()'
      );
      if (item) break;
      await _waitMs(500);
    }
    assert.ok(item, '决策会话没有出现在左侧栏');
    console.log('  左侧栏里看到了：' + item.text);

    console.log('PASS lindang decision session opens as a visible Hub session');
  } finally {
    try { if (client) await client.close(); } catch {}
    await gracefulQuit(hub, { label: 'lindang-e2e' }).catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL', error.stack || error.message);
  process.exitCode = 1;
});
