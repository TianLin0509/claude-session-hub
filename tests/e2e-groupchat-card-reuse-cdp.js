'use strict';
// AI 群聊复用子 session 卡片视图 E2E（2026-07-29 道雪）—— 真实隔离 Hub + 真 PTY 成员 + CDP 驱动真 UI。
//
// 要证明的就是用户那句话：
//   "我们每个 session 都有自己的卡片视图，我为什么不能直接复用各自 session 的卡片视图……
//    这样就很方便了，不用一直显示思考中。"
//
// 场景：
//   1. 建群 + 2 位真实 PTY 成员（PowerShell —— 走完全相同的 dispatch / watcher / PTY
//      链路，永远不 emit turn-complete，天然模拟"AI 还在思考"）
//   2. 发一轮 → 成员进入思考中。此时**还没有任何产出**，「思考中」是诚实的 → 断言基线
//   3. 推第一批 transcript-tap 形状的 blocks：**只有 thinking，没有 text**
//      （这正是旧实现永久卡在「思考中」的那个状态：partial.text 恒为空）
//      → 断言群聊里已经挂出真 .turn-card + .turn-thinking，「思考中」空壳消失
//   4. 推第二批：thinking + 2 个 tool_use + 带代码块的 text
//      → 断言工具簇 / Prism 代码块 / meta pills 都在（与子 session 卡片同款）
//   5. 切到「卡片」视图 → 断言同一张卡片也在，不是另一套渲染
//   6. 隔离断言：#msg-overlay 无污染、window._sessionTurns 不被写、无 streaming indicator
//   7. 群聊专属状态（superseded）仍由外壳表达：占位文案 + 状态条 class
//   8. 截图存档（运行中真实内容 / 卡片视图）
//
// 降级说明（如实记录）：
//   成员是 PowerShell 而不是真 AI CLI —— 建群 / 派发 / PTY / watcher / 轮次全是真的，
//   但 PowerShell 不产生 transcript，所以 transcript-tap 不会自己吐 blocks。第 3/4 步用
//   ipcRenderer.emit 注入**与 core/transcript-tap.js 产出同构**的 blocks，驱动 renderer
//   的真 handler（groupchat-partial-update）。即：渲染链路是真的，blocks 的**生产**环节
//   被替身覆盖。用真 AI CLI 跑同样断言只是把第 3/4 步的数据换成 CLI 自己产的。
//
// 运行：node tests/e2e-groupchat-card-reuse-cdp.js
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
const SHOT_CHAT = path.join(ARTIFACT_DIR, `groupchat-card-reuse-chat-${STAMP}.png`);
const SHOT_CARD = path.join(ARTIFACT_DIR, `groupchat-card-reuse-cardview-${STAMP}.png`);

const PREFERRED_PORT = Number(process.env.GC_CARD_REUSE_E2E_PORT || 9236);
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || path.join(os.tmpdir(), 'hub-test-gccard');

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

// 注意：**不要**把 expression 包进 Boolean(...) —— 异步表达式会退化成 Boolean(Promise)
//   恒为 true，等待条件形同虚设。
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

// transcript-tap 产出的 block 形状（core/transcript-tap.js：thinking / text / tool_use）
const BLOCKS_THINKING_ONLY = [
  { type: 'thinking', text: '用户让我核对群聊卡片复用。先想清楚顺序：\n1) 读 turn-card-renderer 的挂载接缝\n2) 确认 meeting-room 里三个渲染面都接上了\n3) 跑一遍隔离 Hub 验证\n这一步还没有任何正文产出——旧实现就是卡在这里显示「思考中」。' },
];
const BLOCKS_FULL = [
  ...BLOCKS_THINKING_ONLY,
  { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\Vibe\\Worktrees\\hub\\gccard\\renderer\\turn-card-renderer.js' } },
  { type: 'tool_use', name: 'Bash', input: { command: 'grep -n "mountSessionTurnCard" renderer/*.js' } },
  { type: 'text', text: '我读完了 `turn-card-renderer.js`。\n\n**结论**：接缝本来就在，`opts.container` 可以传任意容器。\n\n```js\nwin._mountSessionTurnCard(sid, turn, {\n  container: host,\n  skipTurnRegistry: true,\n});\n```\n\n正在继续核对第二处调用点…' },
];

function pushPartial(cdp, meetingId, sid, payload) {
  return cdp.eval(`(() => {
    require('electron').ipcRenderer.emit('groupchat-partial-update', {}, Object.assign({
      meetingId: ${j(meetingId)}, sid: ${j(sid)},
    }, ${j(payload)}));
    return true;
  })()`);
}

async function snapshot(cdp, scope) {
  return cdp.eval(`(() => {
    const root = document.querySelector(${j(scope)});
    const card = root && root.querySelector('.turn-card');
    return {
      cards: root ? root.querySelectorAll('.turn-card').length : 0,
      hosts: root ? root.querySelectorAll('.mr-gc-card-host').length : 0,
      thinkingBlocks: root ? root.querySelectorAll('.turn-thinking').length : 0,
      toolClusters: root ? root.querySelectorAll('.tc-cluster').length : 0,
      toolRows: root ? root.querySelectorAll('.tc-row-name').length : 0,
      codeBlocks: root ? root.querySelectorAll('.code-block-wrap').length : 0,
      metaPills: root ? root.querySelectorAll('.turn-meta-pills .pill').length : 0,
      waitingShells: root ? root.querySelectorAll('.mr-gc-waiting').length : 0,
      bodyText: card ? (card.querySelector('.turn-body') || {}).innerText || '' : '',
      cardSessionId: card ? card.dataset.sessionId : null,
      // 与单会话面板的隔离
      overlayCards: document.querySelectorAll('#msg-overlay .turn-card').length,
      overlayIndicators: document.querySelectorAll('#msg-overlay .streaming-indicator').length,
      sessionTurnsSize: (window._sessionTurns && window._sessionTurns.size) || 0,
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
      label: 'groupchat-card-reuse',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready');

    // 复用的前提：turn-card-renderer 的挂载接缝对外可用
    const seam = await cdp.eval("({ mount: typeof window._mountSessionTurnCard, render: typeof window._renderTurnCard })");
    assert.strictEqual(seam.mount, 'function', 'window._mountSessionTurnCard 必须可用（群聊复用的唯一入口）');

    // --- 1. 建群 + 2 位真实 PTY 成员 ---
    const meeting = await cdp.eval("(async () => await require('electron').ipcRenderer.invoke('create-meeting', { title: '卡片复用 E2E', scene: 'general' }))()");
    assert.ok(meeting && meeting.id, 'create-meeting IPC should return a meeting');
    const meetingId = meeting.id;

    await cdp.eval(`(async () => {
      localStorage.setItem('mr-group-chat-view-mode', 'chat');
      const ipc = require('electron').ipcRenderer;
      const all = await ipc.invoke('get-meetings');
      window.MeetingRoom.openMeeting(${j(meetingId)}, all.find(x => x.id === ${j(meetingId)}));
      return true;
    })()`);
    await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell');

    for (const [trigger, expected] of [
      ["document.getElementById('mr-btn-add-sub').click()", 1],
      ["document.querySelector('[data-gc-add-member]').click()", 2],
    ]) {
      await cdp.eval(trigger);
      await waitFor(cdp, "!!document.getElementById('mr-add-sub-menu')", 'add-member menu');
      const clicked = await cdp.eval("(() => { const i = [...document.querySelectorAll('#mr-add-sub-menu .mr-quote-menu-item')].find(e => e.textContent.trim() === 'PowerShell'); if (!i) return false; i.click(); return true; })()");
      assert.strictEqual(clicked, true, 'PowerShell add-member menu item should be available');
      await waitFor(cdp, `window.MeetingRoom.getMeetingData(${j(meetingId)}).subSessions.length === ${expected}`, `member #${expected}`, 30000);
    }
    const sids = await cdp.eval(`window.MeetingRoom.getMeetingData(${j(meetingId)}).subSessions`);
    assert.strictEqual(sids.length, 2, '应有 2 位成员');
    const sid = sids[0];
    // 断言范围：只看**有产出的那位成员**的气泡。第二位成员什么都没产出，
    //   它继续显示「思考中」是诚实的 —— 这次改的是"有内容却显示思考中"，
    //   不是把所有等待状态都抹掉。
    const SCOPE = `.mr-gc-msg[data-gc-msg-id="pending-${sid}"]`;

    // --- 2. 发一轮真提问 → 真 dispatch → 成员进入思考中 ---
    await cdp.eval(`(() => {
      const box = document.getElementById('mr-input-box');
      box.textContent = '卡片复用 E2E：这条会让成员进入思考中';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mr-send-btn').click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg.pending').length > 0", 'members thinking', 25000);

    // 基线：还没有任何产出时，「思考中」是诚实的
    const baseline = await snapshot(cdp, SCOPE);
    assert.strictEqual(baseline.cards, 0, '还没产出时不该凭空造卡片');
    assert.ok(baseline.waitingShells > 0, '还没产出时「思考中」占位是正确的');

    // --- 3. 只有 thinking、没有 text（旧实现永久卡在「思考中」的那个状态）---
    await pushPartial(cdp, meetingId, sid, {
      status: 'streaming', text: '', source: 'tap', cleanBufLen: 96, blocks: BLOCKS_THINKING_ONLY,
    });
    await _waitMs(500);
    const thinkingOnly = await snapshot(cdp, SCOPE);
    assert.ok(thinkingOnly.cards >= 1,
      '只有 thinking 块时，群聊也必须挂出真 turn 卡片（这就是"不用一直显示思考中"）');
    assert.strictEqual(thinkingOnly.thinkingBlocks, 1, '必须渲染 💭 思考过程折叠块');
    assert.strictEqual(thinkingOnly.cardSessionId, sid, '卡片必须带该成员的 sessionId');

    // --- 4. thinking + 工具调用 + 带代码块的正文 ---
    await pushPartial(cdp, meetingId, sid, {
      status: 'streaming', text: '我读完了 turn-card-renderer.js。', source: 'tap', cleanBufLen: 640, blocks: BLOCKS_FULL,
    });
    await _waitMs(600);
    const full = await snapshot(cdp, SCOPE);
    assert.ok(full.cards >= 1, '群聊消息区必须有真 .turn-card');
    assert.strictEqual(full.thinkingBlocks, 1, 'thinking 折叠块必须在');
    assert.ok(full.toolClusters >= 1, '工具簇必须在（与子 session 卡片同款折叠形态）');
    assert.ok(full.toolRows >= 2, '两个工具调用都要在');
    assert.ok(full.codeBlocks >= 1, '正文代码块必须被 postProcessCardCodeBlocks 接管（Prism + 复制按钮）');
    assert.ok(full.metaPills >= 1, 'meta pills（🔧 工具数等）必须在');
    assert.ok(/接缝本来就在/.test(full.bodyText), '正文 markdown 必须真的渲染出来');
    assert.strictEqual(full.waitingShells, 0, '该成员有真实内容后，它的气泡不得再是「思考中」空壳');
    const otherStillWaiting = await cdp.eval(`document.querySelectorAll('.mr-gc-waiting').length`);
    assert.strictEqual(otherStillWaiting, 1, '另一位真的什么都没产出的成员应当仍显示「思考中」——诚实的等待态不该被抹掉');

    // 隔离：单会话面板完全不受影响
    assert.strictEqual(full.overlayCards, 0, '群聊卡片不得挂进 #msg-overlay');
    assert.strictEqual(full.overlayIndicators, 0, '群聊不得触发 #msg-overlay 的 streaming indicator');
    assert.strictEqual(full.sessionTurnsSize, 0, '群聊卡片不得写进全局 window._sessionTurns');

    await cdp.send('Page.bringToFront');
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_CHAT, Buffer.from(shot1.data, 'base64'));

    // --- 5. 切到「卡片」视图：同一张卡片，不是另一套渲染 ---
    await cdp.eval("document.getElementById('mr-btn-group-card-view').click()");
    await waitFor(cdp, "!!document.querySelector('.mr-ft')", 'card view rendered', 15000);
    await pushPartial(cdp, meetingId, sid, {
      status: 'streaming', text: '我读完了 turn-card-renderer.js。', source: 'tap', cleanBufLen: 640, blocks: BLOCKS_FULL,
    });
    await _waitMs(600);
    const cardView = await cdp.eval(`(() => {
      const slot = document.querySelector('.mr-ft[data-ft-sid=' + JSON.stringify(${j(sid)}) + ']');
      return {
        found: !!slot,
        cards: slot ? slot.querySelectorAll('.turn-card').length : 0,
        thinkingBlocks: slot ? slot.querySelectorAll('.turn-thinking').length : 0,
        toolRows: slot ? slot.querySelectorAll('.tc-row-name').length : 0,
        codeBlocks: slot ? slot.querySelectorAll('.code-block-wrap').length : 0,
        progressOnly: slot ? slot.querySelectorAll('.mr-ft-progress').length : 0,
      };
    })()`);
    assert.strictEqual(cardView.found, true, '卡片视图应渲染出该成员的 slot');
    assert.ok(cardView.cards >= 1, '卡片视图的正文同样必须是真 turn 卡片');
    assert.strictEqual(cardView.thinkingBlocks, 1, '卡片视图也要有 thinking 折叠块');
    assert.ok(cardView.toolRows >= 2, '卡片视图也要有工具调用');
    assert.strictEqual(cardView.progressOnly, 0, '有内容时不该只剩一根进度条');

    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_CARD, Buffer.from(shot2.data, 'base64'));

    // --- 6. 群聊专属状态仍由外壳表达（不塞进 turn-card-renderer）---
    await cdp.eval("document.getElementById('mr-btn-group-chat-view').click()");
    await waitFor(cdp, "!!document.querySelector('.mr-gc-messages')", 'back to chat view', 15000);
    await pushPartial(cdp, meetingId, sids[1], { status: 'superseded', text: '', source: 'tap', blocks: [] });
    await _waitMs(500);
    const superseded = await cdp.eval(`(() => {
      const el = document.querySelector('.mr-gc-msg[data-gc-status="superseded"]');
      return {
        found: !!el,
        shellClass: el ? el.classList.contains('mr-gc-st-superseded') : false,
        placeholder: el ? !!el.querySelector('.mr-gc-empty-placeholder') : false,
        text: el ? el.innerText : '',
        pending: el ? el.classList.contains('pending') : null,
      };
    })()`);
    assert.strictEqual(superseded.found, true, 'superseded 必须落到外壳的 data-gc-status 上');
    assert.strictEqual(superseded.shellClass, true, '外壳必须带状态条 class（群聊语义不进通用卡片渲染器）');
    assert.strictEqual(superseded.placeholder, true, '无回答终态仍走占位文案，不被卡片吞掉');
    assert.ok(/被新提问覆盖/.test(superseded.text), '状态标签必须可读');
    assert.strictEqual(superseded.pending, false, 'settle 态不得再算 pending');

    console.log(JSON.stringify({
      ok: true,
      port,
      dataDir: DATA_DIR,
      meetingId,
      baseline: { cards: baseline.cards, waitingShells: baseline.waitingShells },
      thinkingOnly,
      full,
      cardView,
      superseded,
      screenshots: [SHOT_CHAT, SHOT_CARD],
      screenshotBytes: [fs.statSync(SHOT_CHAT).size, fs.statSync(SHOT_CARD).size],
      degradation: 'members are PowerShell PTY (real dispatch/watcher/turn chain); blocks injected in transcript-tap shape because PowerShell produces no transcript',
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
