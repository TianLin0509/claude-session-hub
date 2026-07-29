'use strict';
// AI 群聊「运行中也能操作」E2E（2026-07-29 道雪）—— 真实隔离 Hub + 真 PTY 成员 + CDP 驱动真 UI。
//
// 场景（全部走真实 IPC，不 mock groupchat:turn / groupchat:interrupt）：
//   1. 建群 + 加 2 位真实 PTY 成员（PowerShell —— 不烧 AI CLI token，但走完全相同的
//      dispatch / watcher / PTY 链路；它永远不会 emit turn-complete，天然模拟"AI 还在思考"）
//   2. 发第一轮 → 成员进入"思考中"
//   3. **运行中断言**：输入框可编辑、发送按钮不灰、成员勾选不灰、「⏹ 停止本轮」入口出现
//   4. **运行中追加**第二问 → 断言后端 orchestrator 真收到 u1/u2 两轮，轮次不串
//   5. **运行中中断**：点「停止本轮」→ 断言 currentMode 收敛 idle、成员状态 = interrupted、
//      聊天区没有卡片停在永久"思考中"（.mr-gc-msg.pending 归零）
//   6. 截图存档
//
// 运行：node tests/e2e-groupchat-live-ops-cdp.js
// 铁律：CLAUDE_HUB_DATA_DIR 隔离 + PID 白名单（hub-launcher 内置），绝不碰生产 Hub。

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// 铁律 feedback_e2e_strip_claude_env：从 CC 会话 spawn Hub 前剥离嵌套 env
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[k];
}

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SHOT_RUNNING = path.join(ARTIFACT_DIR, `groupchat-live-ops-running-${STAMP}.png`);
const SHOT_STOPPED = path.join(ARTIFACT_DIR, `groupchat-live-ops-stopped-${STAMP}.png`);

const PREFERRED_PORT = Number(process.env.GC_LIVE_OPS_E2E_PORT || 9232);
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || path.join(os.tmpdir(), 'hub-test-groupchat');

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 40; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free CDP port from ${preferred}`);
}

// 注意：**不要**把 expression 包进 Boolean(...) —— 那样异步表达式会退化成
//   Boolean(Promise) 恒为 true，等待条件形同虚设（本文件初版踩过）。
//   直接求值、在 node 侧判真假，awaitPromise 由 cdp-client 负责。
async function waitFor(cdp, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.eval(expression);
      if (ok) return true;
    } catch (err) { last = err; }
    await _waitMs(200);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

const j = (v) => JSON.stringify(v);

async function addPowerShellMember(cdp, meetingId, triggerExpression, expectedCount) {
  await cdp.eval(triggerExpression);
  await waitFor(cdp, "!!document.getElementById('mr-add-sub-menu')", 'add-member menu');
  const clicked = await cdp.eval("(() => { const item = [...document.querySelectorAll('#mr-add-sub-menu .mr-quote-menu-item')].find(el => el.textContent.trim() === 'PowerShell'); if (!item) return false; item.click(); return true; })()");
  assert.strictEqual(clicked, true, 'PowerShell add-member menu item should be available');
  await waitFor(cdp, `window.MeetingRoom.getMeetingData(${j(meetingId)}).subSessions.length === ${expectedCount}`, `member #${expectedCount}`, 30000);
}

async function fetchState(cdp, meetingId) {
  return cdp.eval(`(async () => { const ipc = require('electron').ipcRenderer; return await ipc.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} }); })()`);
}

async function sendFromComposer(cdp, text) {
  return cdp.eval(`(() => {
    const box = document.getElementById('mr-input-box');
    box.textContent = ${j(text)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('mr-send-btn').click();
    return { cleared: !document.getElementById('mr-input-box').innerText.trim() };
  })()`);
}

async function composerSnapshot(cdp) {
  return cdp.eval(`(() => {
    const box = document.getElementById('mr-input-box');
    const btn = document.getElementById('mr-send-btn');
    const chks = [...document.querySelectorAll('.mr-free-avatar-chk[data-slot-idx]')];
    return {
      composerEditable: box.getAttribute('contenteditable') !== 'false',
      composerReadonly: box.hasAttribute('readonly'),
      composerDisabledClass: box.classList.contains('mr-gc-input-disabled'),
      sendDisabled: !!btn.disabled,
      memberChecks: chks.length,
      memberChecksDisabled: chks.filter(el => el.classList.contains('disabled') || (el.querySelector('input') || {}).disabled).length,
      stopChip: !!document.querySelector('[data-gc-stop-turn]'),
      pendingBubbles: document.querySelectorAll('.mr-gc-msg.pending').length,
      thinkingCards: document.querySelectorAll('.mr-ft.thinking-card, .mr-ft.streaming-card').length,
    };
  })()`);
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  let hub = null;
  let cdp = null;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'groupchat-live-ops',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready');

    // --- 1. 建群 + 2 位真实 PTY 成员 ---
    const meeting = await cdp.eval("(async () => { const ipc = require('electron').ipcRenderer; return await ipc.invoke('create-meeting', { title: '运行中可操作 E2E', scene: 'general' }); })()");
    assert.ok(meeting && meeting.id, 'create-meeting IPC should return a meeting');
    const meetingId = meeting.id;

    await cdp.eval(`(async () => {
      localStorage.setItem('mr-group-chat-view-mode', 'chat');
      const ipc = require('electron').ipcRenderer;
      const all = await ipc.invoke('get-meetings');
      const m = all.find(x => x.id === ${j(meetingId)});
      window.MeetingRoom.openMeeting(m.id, m);
      return true;
    })()`);
    await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell');

    await addPowerShellMember(cdp, meetingId, "document.getElementById('mr-btn-add-sub').click()", 1);
    await addPowerShellMember(cdp, meetingId, "document.querySelector('[data-gc-add-member]').click()", 2);
    await waitFor(cdp, `window.MeetingRoom.getMeetingData(${j(meetingId)}).participants.length === 2`, 'both members selected');

    // 记录后端广播的「本轮真实派发目标」——它在 sendToPty 全部成功之后、watcher 注册
    //   之前发出，是"本轮已经真的在跑"最可靠的信号，用来让中断断言不再靠 sleep 猜时机。
    await cdp.eval("(() => { window.__gcTargets = []; require('electron').ipcRenderer.on('groupchat-turn-targets', (_e, p) => window.__gcTargets.push(p)); return true; })()");

    // --- 2. 发第一轮（真 groupchat:turn，真 PTY）---
    const q1 = 'E2E 第一问：这条会让成员进入思考中';
    const first = await sendFromComposer(cdp, q1);
    assert.strictEqual(first.cleared, true, '点发送后输入框应立即清空');
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg.pending').length > 0", 'members thinking', 20000);

    // --- 3. 运行中的 UI 断言（核心：不许灰）---
    const during = await composerSnapshot(cdp);
    assert.strictEqual(during.composerEditable, true, '运行中输入框必须仍可编辑');
    assert.strictEqual(during.composerReadonly, false, '运行中输入框不得 readonly');
    assert.strictEqual(during.composerDisabledClass, false, '运行中输入框不得带灰态 class');
    assert.strictEqual(during.sendDisabled, false, '运行中发送按钮不得禁用');
    assert.strictEqual(during.memberChecks, 2, '应有 2 个成员勾选头像');
    assert.strictEqual(during.memberChecksDisabled, 0, '运行中成员勾选不得被禁用（用户说的"UI 都是灰的"）');
    assert.strictEqual(during.stopChip, true, '运行中必须出现「⏹ 停止本轮」入口');
    assert.ok(during.pendingBubbles > 0, '至少一位成员显示为思考中');

    await cdp.send('Page.bringToFront');
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_RUNNING, Buffer.from(shot1.data, 'base64'));

    // --- 4. 运行中追加第二问（真发送）---
    const q2 = 'E2E 第二问：在第一问还没答完时追加';
    const second = await sendFromComposer(cdp, q2);
    assert.strictEqual(second.cleared, true, '运行中追加同样应清空输入框（说明真的发出去了）');
    await waitFor(cdp, `(async () => { const s = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} }); return !!(s && (s.messages || []).filter(m => m.role === 'user').length >= 2); })()`, 'second turn accepted by backend', 45000);

    const stateAfterAppend = await fetchState(cdp, meetingId);
    const users = (stateAfterAppend.messages || []).filter(m => m.role === 'user');
    assert.ok(users.length >= 2, `后端必须真收到两轮用户提问，实际 ${users.length}`);
    const u1 = users.find(m => m.content === q1);
    const u2 = users.find(m => m.content === q2);
    assert.ok(u1 && u2, '两条提问都必须落进 orchestrator');
    assert.notStrictEqual(u1.turnNum, u2.turnNum, '追加提问必须归属新一轮，不得串进旧轮');
    assert.strictEqual(Number(u2.turnNum), Number(u1.turnNum) + 1, '追加提问轮号 = 上一轮 + 1');
    const stillEnabled = await composerSnapshot(cdp);
    assert.strictEqual(stillEnabled.sendDisabled, false, '追加之后输入仍然可用');
    assert.strictEqual(stillEnabled.memberChecksDisabled, 0, '追加之后成员勾选仍然可用');

    // --- 5. 运行中中断（点真实 UI 入口）---
    // 等追加的那一轮真的开跑（后端已发出 groupchat-turn-targets），这样中断打的是
    //   "确实在跑的成员"，而不是还没建 watcher 的空窗口。
    await waitFor(cdp, "window.__gcTargets.filter(p => p.turnNum >= 2 && (p.sids || []).length > 0).length > 0", 'appended turn actually dispatched', 60000);
    await _waitMs(400);
    await waitFor(cdp, "!!document.querySelector('[data-gc-stop-turn]')", 'stop chip present before interrupt');
    const stopClicked = await cdp.eval("(() => { const el = document.querySelector('[data-gc-stop-turn]'); if (!el) return false; el.click(); return true; })()");
    assert.strictEqual(stopClicked, true, '「停止本轮」入口必须可点');

    await waitFor(cdp, `(async () => { const s = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} }); return !!(s && s.currentMode === 'idle' && (s.turns || []).some(t => t.n >= 2)); })()`, 'backend converged to idle after interrupt', 40000);
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg.pending').length === 0", 'no card stuck in thinking', 20000);

    const stateAfterStop = await fetchState(cdp, meetingId);
    assert.strictEqual(stateAfterStop.currentMode, 'idle', '中断后 currentMode 必须收敛回 idle');
    const lastTurn = (stateAfterStop.turns || []).slice().sort((a, b) => a.n - b.n).pop();
    assert.ok(lastTurn, '中断后本轮必须留下轮记录（不是凭空消失）');
    const statuses = Object.values(lastTurn.byStatus || {});
    assert.ok(statuses.length > 0, '轮记录必须带成员状态');
    const SETTLED = new Set(['interrupted', 'completed', 'manual_extracted', 'absent', 'superseded', 'errored']);
    assert.ok(statuses.every(s => SETTLED.has(s)), `中断后不得有成员停在非终态：${j(statuses)}`);
    assert.ok(statuses.includes('interrupted'), `至少一位在跑成员应被标记为 interrupted，实际：${j(statuses)}`);

    const afterStop = await composerSnapshot(cdp);
    assert.strictEqual(afterStop.pendingBubbles, 0, '中断后不得有气泡停在永久"思考中"');
    assert.strictEqual(afterStop.thinkingCards, 0, '中断后不得有卡片停在 thinking/streaming');
    assert.strictEqual(afterStop.sendDisabled, false, '中断后输入仍然可用');
    assert.strictEqual(afterStop.stopChip, false, '中断后「停止本轮」入口应消失（本轮已结束）');

    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_STOPPED, Buffer.from(shot2.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      port,
      dataDir: DATA_DIR,
      meetingId,
      during,
      appendedTurns: { u1: u1.turnNum, u2: u2.turnNum },
      afterStopStatuses: statuses,
      afterStop,
      screenshots: [SHOT_RUNNING, SHOT_STOPPED],
      screenshotBytes: [fs.statSync(SHOT_RUNNING).size, fs.statSync(SHOT_STOPPED).size],
    }, null, 2));
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-80).join('\n'));
    }
    throw err;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
