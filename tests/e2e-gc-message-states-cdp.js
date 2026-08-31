'use strict';
// 2026-07-12 道雪：群聊聊天视图消息状态渲染 E2E（真实隔离 Hub + CDP，截图血泪回归）。
//
// 覆盖修复：
//   1. 持久化 errored 空消息 → 「发送失败」+ 占位文案（含失败原因）+「同步」按钮，
//      不再渲染成"空气泡 + 裸图标排"；不显示「正在发言」。
//   2. superseded / absent → 明确状态标签 + 占位文案。
//   3. completed 但空内容（PTY 干净退出兜底）→ 仍保留「同步」逃生入口。
//   4. pending 期 errored（partial）→ 无「正在发言」、无闪烁光标、占位文案带原因。
//   5. 正常 completed 消息 → 无「同步」按钮（不误导）、字数 chip 正常。
//   6. 正常 pending streaming → 「正在发言」+ 光标（确认没把好路径修坏）。
//   7. 进行中轮次已有持久化结果 → 只显示正式答案，不再叠一张同成员「思考中」。
//
// 运行：node tests/e2e-gc-message-states-cdp.js
// 铁律：CLAUDE_HUB_DATA_DIR 隔离 + PID 白名单（hub-launcher 已内置），不碰生产 Hub。

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
const ARTIFACT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'groupchat-message-states');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `20260831-ai-hub-groupchat-message-states-codex1-${STAMP}.png`);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 80; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free CDP port from ${preferred}`);
}

async function waitForEval(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const ok = await client.eval(`Boolean(${expression})`);
      if (ok) return true;
    } catch (err) { lastErr = err; }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function cleanupDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmpRoot + path.sep)) return;
  if (!path.basename(resolved).startsWith('claude-session-hub-gc-states-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.GC_STATES_E2E_PORT || 19431));
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-gc-states-e2e-${process.pid}-${STAMP}`);

  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'gc-message-states',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });

    client = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1365, height: 960, deviceScaleFactor: 1, mobile: false });

    await waitForEval(client, 'window.MeetingRoom && window.MeetingRoom.debugRenderGroupChatState && document.getElementById("meeting-room-panel") && typeof sessions !== "undefined" && typeof meetings !== "undefined" && window.__hubE2E && typeof window.__hubE2E.selectMeeting === "function"', 'MeetingRoom E2E API + renderer globals');

    const result = await client.eval(`(async () => {

      const sids = ['e2e-claude', 'e2e-gemini', 'e2e-codex'];
      const now = Date.now();
      const fakeSessions = [
        { id: sids[0], kind: 'claude', title: 'Claude E2E', status: 'active', createdAt: now, lastMessageTime: now },
        { id: sids[1], kind: 'gemini', title: 'Gemini E2E', status: 'active', createdAt: now, lastMessageTime: now },
        { id: sids[2], kind: 'codex', title: 'Codex 2', status: 'active', createdAt: now, lastMessageTime: now },
      ];
      if (typeof sessions === 'undefined' || !(sessions instanceof Map)) throw new Error('renderer sessions Map unavailable');
      fakeSessions.forEach(s => sessions.set(s.id, s));

      const meeting = {
        id: 'e2e-gc-states',
        title: 'GC States E2E',
        scene: 'general',
        groupChat: true,
        groupMode: 'fanout',
        subSessions: sids,
        participants: [0, 1, 2],
        focusedSub: sids[0],
        createdAt: now, updatedAt: now, lastMessageTime: now,
      };
      if (typeof meetings === 'undefined') throw new Error('renderer meetings store unavailable');
      if (!window.__hubE2E || typeof window.__hubE2E.selectMeeting !== 'function') throw new Error('selectMeeting hook unavailable');
      meetings[meeting.id] = meeting;
      await window.__hubE2E.selectMeeting(meeting.id);
      await new Promise(r => setTimeout(r, 650));

      const state = {
        currentMode: 'group',
        currentTurn: 7,
        messages: [
          { id: 'u5', turnNum: 5, role: 'user', speaker: '你', content: '新改动打包更新到 GitHub 了吗？', createdAt: now - 60000, anchor: 'raw://group/e2e-gc-states/msg/u5' },
          { id: 'a5-m3', turnNum: 5, role: 'assistant', sid: sids[2], speaker: 'Codex 2', content: '', status: 'errored', statusReason: 'auth_required', createdAt: now - 55000, anchor: 'raw://group/e2e-gc-states/msg/a5-m3' },
          { id: 'u6', turnNum: 6, role: 'user', speaker: '你', content: '还等什么，执行', createdAt: now - 30000, anchor: 'raw://group/e2e-gc-states/msg/u6' },
          { id: 'a6-m1', turnNum: 6, role: 'assistant', sid: sids[0], speaker: 'Claude E2E', content: '已完成推送，release v1.6.2 已发布。', status: 'completed', createdAt: now - 25000, anchor: 'raw://group/e2e-gc-states/msg/a6-m1' },
          { id: 'a6-m2', turnNum: 6, role: 'assistant', sid: sids[1], speaker: 'Gemini E2E', content: '', status: 'superseded', createdAt: now - 24000, anchor: 'raw://group/e2e-gc-states/msg/a6-m2' },
          { id: 'a6-m3', turnNum: 6, role: 'assistant', sid: sids[2], speaker: 'Codex 2', content: '', status: 'completed', createdAt: now - 23000, anchor: 'raw://group/e2e-gc-states/msg/a6-m3' },
          { id: 'u7', turnNum: 7, role: 'user', speaker: '你', content: '当前轮请继续排查', createdAt: now - 10000, anchor: 'raw://group/e2e-gc-states/msg/u7' },
          { id: 'a7-m2', turnNum: 7, role: 'assistant', sid: sids[1], speaker: 'Gemini E2E', content: '这是整轮结束前已持久化的可用答案。', status: 'manual_extracted', createdAt: now - 5000, anchor: 'raw://group/e2e-gc-states/msg/a7-m2' },
        ],
        turns: [
          { n: 5, mode: 'group', userInput: '新改动打包更新到 GitHub 了吗？', by: {}, byStatus: { [sids[2]]: 'errored' }, timestamp: now - 55000 },
          { n: 6, mode: 'group', userInput: '还等什么，执行', by: { [sids[0]]: '已完成推送，release v1.6.2 已发布。' }, byStatus: { [sids[0]]: 'completed', [sids[1]]: 'superseded', [sids[2]]: 'completed' }, timestamp: now - 23000 },
        ],
        _partialBy: {
          [sids[0]]: { text: '', status: 'thinking', sendStatus: 'stuck' },
          [sids[1]]: { text: '不应重复显示的旧 streaming', status: 'streaming' },
          [sids[2]]: { text: '', status: 'errored', reason: 'pty exit code=1 signal=none' },
        },
      };
      const render = window.MeetingRoom.debugRenderGroupChatState(meeting.id, state);
      await new Promise(r => setTimeout(r, 150));

      const q = (sel) => document.querySelector(sel);
      const msgEl = (id) => q('.mr-gc-msg[data-gc-msg-id="' + id + '"]');
      const info = (id) => {
        const el = msgEl(id);
        if (!el) return null;
        return {
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
          hasPlaceholder: !!el.querySelector('.mr-gc-empty-placeholder'),
          hasSyncBtn: !!el.querySelector('.mr-gc-sync-btn'),
          hasCursor: !!el.querySelector('.mr-ft-cursor'),
          hasWordChip: !!el.querySelector('.mr-gc-wordcount'),
          hasSubmitAgain: !!el.querySelector('[data-gc-escape="resend-prompt"]'),
          pendingClass: el.classList.contains('pending'),
        };
      };
      return {
        renderOk: !!(render && render.ok),
        erroredTurn5: info('a5-m3'),
        completedWithText: info('a6-m1'),
        superseded: info('a6-m2'),
        completedEmpty: info('a6-m3'),
        pendingErrored: info('pending-' + sids[2]),
        pendingStuck: info('pending-' + sids[0]),
        persistedInflight: info('a7-m2'),
        duplicatePendingRecovered: info('pending-' + sids[1]),
      };
    })()`);

    assert.strictEqual(result.renderOk, true, 'debugRenderGroupChatState must succeed');

    // 1. 持久化 errored 空消息
    const e5 = result.erroredTurn5;
    assert.ok(e5, 'errored message must render');
    assert.ok(e5.text.includes('发送失败'), 'errored 消息必须显示「发送失败」');
    assert.ok(!e5.text.includes('正在发言'), 'errored 消息不得显示「正在发言」');
    assert.ok(e5.hasPlaceholder, 'errored 空消息必须渲染占位文案（不再是空气泡）');
    assert.ok(e5.text.includes('登录失效'), '占位文案必须解释失败原因（auth_required → 登录失效）');
    assert.ok(e5.hasSyncBtn, 'errored 消息必须保留「同步」逃生入口');

    // 2. superseded
    const sup = result.superseded;
    assert.ok(sup, 'superseded message must render');
    assert.ok(sup.text.includes('被新提问覆盖'), 'superseded 需要明确状态标签');
    assert.ok(sup.hasPlaceholder && sup.text.includes('被下一轮提问覆盖'), 'superseded 空消息需要占位解释');

    // 3. completed 但空内容
    const ce = result.completedEmpty;
    assert.ok(ce, 'completed-empty message must render');
    assert.ok(ce.hasPlaceholder && ce.text.includes('未提取到内容'), 'completed 空消息需要占位解释');
    assert.ok(ce.hasSyncBtn, 'completed 空消息必须保留「同步」按钮（内容为空说明没同步成功）');

    // 4. pending errored partial
    const pe = result.pendingErrored;
    assert.ok(pe, 'pending errored bubble must render');
    assert.ok(pe.text.includes('发送失败'), 'pending errored 必须显示「发送失败」');
    assert.ok(!pe.text.includes('正在发言'), 'pending errored 不得显示「正在发言」（旧矛盾态）');
    assert.ok(!pe.hasCursor, 'pending errored 不得渲染闪烁光标');
    assert.ok(pe.hasPlaceholder && pe.text.includes('CLI 进程退出'), 'pending errored 占位必须带失败原因标签');

    // 5. 正常 completed
    const ok6 = result.completedWithText;
    assert.ok(ok6, 'completed message must render');
    assert.ok(ok6.text.includes('release v1.6.2'), 'completed 消息正文正常渲染');
    assert.ok(!ok6.hasSyncBtn, 'completed 且有内容的消息不显示「同步」按钮');
    assert.ok(ok6.hasWordChip, 'completed 消息显示字数 chip');
    assert.ok(!ok6.hasPlaceholder, 'completed 有内容消息不渲染占位');

    // 6. default unified view must expose the stuck-input escape action
    const ps = result.pendingStuck;
    assert.ok(ps, 'send-stuck pending card must render');
    assert.ok(ps.text.includes('输入未提交'), 'send-stuck card must distinguish input delivery from model failure');
    assert.ok(ps.text.includes('尚未检测到 agent 开工'), 'send-stuck explanation must use semantic work-start truth');
    assert.ok(ps.hasSubmitAgain, 'send-stuck card must expose visible 再次发送 action');

    // 7. 当前轮已经持久化的恢复结果必须取代该 sid 的 pending 气泡
    const recovered = result.persistedInflight;
    assert.ok(recovered && recovered.text.includes('整轮结束前已持久化'), '进行中持久化答案必须作为正式消息渲染');
    assert.strictEqual(result.duplicatePendingRecovered, null, '同一 sid 不得同时显示正式答案和“思考中”重复气泡');

    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    const shotSize = fs.statSync(SCREENSHOT_PATH).size;
    assert.ok(shotSize > 10 * 1024, 'screenshot should be non-empty');

    console.log(JSON.stringify({ ok: true, port, screenshot: SCREENSHOT_PATH, screenshotBytes: shotSize }, null, 2));
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-60).join('\n'));
    }
    throw err;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    cleanupDataDir(dataDir);
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
