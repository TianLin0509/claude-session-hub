'use strict';
/*
 * 群聊「首次打开、历史还没回来就发消息」的即时出卡回归（2026-09-07）
 * ─────────────────────────────────────────────────────────────────
 * 起因：评审 Codex 2 实测 —— 第一次打开一个群聊房间、`groupchat:get-state` 还没返回时
 *   发消息，输入框已经清空，用户那张气泡卡 1.4 秒都不出现，等历史读回来才冒出来。
 *   根因是「没有面板缓存时的兜底」走了 refreshGroupChatPanel，而它要先 await 历史查询。
 *
 * 这份脚本在隔离 Hub 里把 `groupchat:get-state` 人为拖慢，然后走真实的 handleMeetingSend
 * 路径，量「按下发送之后多久看得到自己那张气泡、有没有滚到底」。
 *
 * 跑法（不碰生产 Hub：隔离数据目录 + 独立 CDP 端口）：
 *   node tests/e2e-groupchat-first-send-card-cdp.js
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SLOW_HISTORY_MS = 2500;
const CARD_DEADLINE_MS = 600; // 按下发送到看见自己那张卡的上限

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 从生产 state.json 里借一个真实群聊房间当 fixture：只读取，不写回。
// 剥掉 serialWorkflow，避免隔离实例开机自动续跑循环去拉起真 CLI。
function buildFixtureState() {
  const source = path.join(os.homedir(), '.claude-session-hub', 'state.json');
  if (!fs.existsSync(source)) return null;
  const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  const meeting = (parsed.meetings || []).find(m => m && m.scene && (m.subSessions || []).length >= 2);
  if (!meeting) return null;
  const memberIds = new Set(meeting.subSessions || []);
  const sessions = (parsed.sessions || [])
    .filter(s => s && memberIds.has(s.hubId))
    .map(s => ({ ...s, unreadCount: 0, attentionState: null, needsUserInput: false, replyReady: false }));
  const room = { ...meeting, serialWorkflow: null, pinned: true, status: 'dormant' };
  return {
    state: { version: parsed.version, cleanShutdown: true, sessions, meetings: [room] },
    meetingId: room.id,
  };
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async attach(port) {
    const WebSocket = require('ws');
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/json/list');
        const list = await res.json();
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* Hub 还没起来 */ }
      if (!target) await sleep(500);
    }
    assert.ok(target, '拿不到 CDP page target');
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const cdp = new Cdp(ws);
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id && cdp.pending.has(msg.id)) { cdp.pending.get(msg.id)(msg); cdp.pending.delete(msg.id); }
    });
    return cdp;
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const msg = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const details = msg.result && msg.result.exceptionDetails;
    const described = details && (details.exception && details.exception.description || details.text);
    assert.ok(!details, '页面里抛异常了：' + described);
    return msg.result && msg.result.result ? msg.result.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch { /* 已经断了 */ } }
}

const PROBE = `(async () => {
  const meetingId = __MEETING_ID__;
  const { ipcRenderer } = require('electron');
  if (!ipcRenderer.__slowHistoryPatched) {
    const original = ipcRenderer.invoke.bind(ipcRenderer);
    ipcRenderer.invoke = (channel, ...args) => {
      // 慢历史 fixture：只拖 groupchat:get-state。
      if (channel === 'groupchat:get-state') {
        return new Promise(resolve => setTimeout(() => resolve(original(channel, ...args)), __SLOW_MS__));
      }
      // 本轮永远挂着不 resolve：既不去唤醒成员拉起真 CLI，又能保持"这一轮还在飞"，
      // 好在下半程验证历史回来之后服务端状态确实接管了（乐观态还在 → 出现 AI 思考气泡）。
      if (channel === 'groupchat:turn') return new Promise(() => {});
      return original(channel, ...args);
    };
    ipcRenderer.__slowHistoryPatched = true;
  }
  // 走真实 UI 路径打开房间：点侧栏那一行。此时历史查询被拖住，面板缓存是空的。
  const row = document.querySelector('#session-list [data-meeting-id=' + JSON.stringify(meetingId) + ']');
  if (!row) return { error: 'sidebar-row-missing' };
  row.click();
  await new Promise(r => setTimeout(r, 400));
  if (window.MeetingRoom.getActiveMeetingId() !== meetingId) return { error: 'meeting-not-active' };
  const countBubbles = () => document.querySelectorAll(
    '.mr-gc-messages .mr-gc-msg[data-gc-msg-id^="pending-user-"]').length;
  const before = countBubbles();
  const startedAt = performance.now();
  window.MeetingRoom.debugSendGroupChat(meetingId, '首次打开就发的这条问题');
  let firstSeenMs = null;
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    await new Promise(r => setTimeout(r, 50));
    const n = countBubbles();
    const atMs = Math.round(performance.now() - startedAt);
    if (n > before && firstSeenMs === null) firstSeenMs = atMs;
    if (i === 3 || i === 27) samples.push({ atMs, bubbles: n });
    if (firstSeenMs !== null && i >= 5) break;
  }
  const scroller = document.querySelector('.mr-gc-messages');
  const bottomGap = scroller
    ? Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
    : null;
  // 下半程：等慢历史真的回来，确认服务端状态接住了这一帧 ——
  // 本地那份种子状态是 currentMode='idle'，只有服务端状态（带乐观态 group）
  // 才会渲染出 AI 的"正在发言"气泡。以此证明种子没有把真状态挡住。
  await new Promise(r => setTimeout(r, __SLOW_MS__ + 900 - (performance.now() - startedAt)));
  const afterHistory = {
    userBubbles: countBubbles(),
    aiPending: document.querySelectorAll(
      '.mr-gc-messages .mr-gc-msg.mr-gc-pending, .mr-gc-messages .mr-gc-msg[data-gc-msg-id^="pending-"]').length
      - countBubbles(),
    totalMsgs: document.querySelectorAll('.mr-gc-messages .mr-gc-msg').length,
  };
  return { before, firstSeenMs, samples, bottomGap, afterHistory };
})()`;

async function main() {
  const fixture = buildFixtureState();
  if (!fixture) {
    console.log('SKIP: 本机没有可借用的群聊房间 fixture');
    return;
  }
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'hub-gc-firstsend-' + process.pid + '-' + port);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(fixture.state), 'utf8');

  const env = {
    ...process.env,
    CLAUDE_HUB_DATA_DIR: dataDir,
    CLAUDE_HUB_HOME_DIR: dataDir,
    CLAUDE_HUB_E2E: '1',
    DEEPSEEK_API_KEY: '',
  };
  // 从 Claude Code 会话里 spawn 必须剥掉嵌套 env，否则子 CLI 自认嵌套子会话不写 transcript。
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
    delete env[key];
  }

  const hub = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port], { env, stdio: 'ignore', windowsHide: true });
  let cdp = null;
  try {
    cdp = await Cdp.attach(port);
    for (let i = 0; i < 60; i += 1) {
      const ready = await cdp.eval('!!(window.MeetingRoom && window.MeetingRoom.debugSendGroupChat'
        + ' && document.querySelector("#session-list [data-meeting-id=" + '
        + JSON.stringify(JSON.stringify(fixture.meetingId)) + ' + "]"))');
      if (ready) break;
      await sleep(500);
    }

    const report = await cdp.eval(PROBE
      .replaceAll('__MEETING_ID__', JSON.stringify(fixture.meetingId))
      .replaceAll('__SLOW_MS__', String(SLOW_HISTORY_MS)));

    console.log('slow-history probe:', JSON.stringify(report));
    assert.ok(!report.error, '探针前提不成立：' + report.error);
    assert.equal(report.before, 0, '前提不成立：发送前就已经有 pending 用户气泡');
    assert.notEqual(report.firstSeenMs, null,
      '历史查询被拖慢 ' + SLOW_HISTORY_MS + 'ms 期间，用户那张气泡卡始终没出现');
    assert.ok(report.firstSeenMs <= CARD_DEADLINE_MS,
      '气泡卡 ' + report.firstSeenMs + 'ms 才出现，超过 ' + CARD_DEADLINE_MS + 'ms 的即时出卡上限');
    assert.ok(report.bottomGap !== null && report.bottomGap <= 48,
      '发出消息后没有滚到底，离底部还有 ' + report.bottomGap + 'px');
    assert.ok(report.afterHistory.userBubbles >= 1,
      '慢历史回来之后用户那条气泡不见了：' + JSON.stringify(report.afterHistory));
    assert.ok(report.afterHistory.aiPending >= 1,
      '慢历史回来之后服务端状态没有接管（没出现 AI 正在发言的气泡），'
      + '本地种子状态可能把真状态挡住了：' + JSON.stringify(report.afterHistory));
    console.log('群聊首次发送即时出卡 + 置底：通过（历史被拖慢 ' + SLOW_HISTORY_MS
      + 'ms，气泡 ' + report.firstSeenMs + 'ms 出现）');
  } finally {
    if (cdp) cdp.close();
    try { hub.kill(); } catch { /* 已退出 */ }
    await sleep(1500);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
