'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'groupchat-unified');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `20260831-ai-hub-groupchat-unified-smoke-codex1-${STAMP}.png`);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
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
    } catch (err) {
      lastErr = err;
    }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function cleanupDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmpRoot + path.sep)) return;
  if (!path.basename(resolved).startsWith('claude-session-hub-meeting-room-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const preferredPort = Number(process.env.MEETING_ROOM_E2E_PORT || 19349);
  const port = await availablePort(preferredPort);
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-meeting-room-e2e-${process.pid}-${STAMP}`);

  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'meeting-room-renderer-smoke',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });

    client = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1365,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await waitForEval(client, 'window.MeetingRoom && window.MeetingRoom.debugRenderGroupChatState && document.getElementById("meeting-room-panel")', 'MeetingRoom E2E API');

    const setup = await client.eval(`(async () => {
      const sids = ['e2e-claude', 'e2e-deepseek', 'e2e-codex'];
      const now = Date.now();
      const fakeSessions = [
        { id: sids[0], kind: 'claude', title: 'Claude E2E', status: 'active', model: 'sonnet', contextPercent: 12, createdAt: now, lastMessageTime: now },
        { id: sids[1], kind: 'deepseek', title: 'DeepSeek E2E', status: 'active', model: 'pro', contextPercent: 18, createdAt: now, lastMessageTime: now },
        { id: sids[2], kind: 'codex', title: 'Codex E2E', status: 'active', model: 'gpt-5', contextPercent: 9, createdAt: now, lastMessageTime: now },
      ];
      if (typeof sessions === 'undefined' || !(sessions instanceof Map)) {
        throw new Error('renderer sessions Map is unavailable');
      }
      fakeSessions.forEach((session) => sessions.set(session.id, session));

      const meeting = {
        id: 'e2e-meeting-room-smoke',
        title: 'E2E Meeting Room Smoke',
        scene: 'general',
        groupChat: true,
        groupMode: 'fanout',
        subSessions: sids,
        participants: [0, 1, 2],
        focusedSub: sids[0],
        createdAt: now,
        updatedAt: now,
        lastMessageTime: now,
      };
      if (typeof meetings === 'undefined') throw new Error('renderer meetings store is unavailable');
      if (!window.__hubE2E || typeof window.__hubE2E.selectMeeting !== 'function') {
        throw new Error('renderer real selectMeeting E2E hook is unavailable');
      }
      meetings[meeting.id] = meeting;
      await window.__hubE2E.selectMeeting(meeting.id);
      await new Promise((resolve) => setTimeout(resolve, 650));
      const state = {
        currentMode: 'idle',
        turnNum: 1,
        turns: [{
          n: 1,
          mode: 'fanout',
          userInput: 'E2E delegated renderer smoke question',
          by: {
            [sids[0]]: 'Claude card rendered from injected E2E state.',
            [sids[1]]: 'Gemini card rendered from injected E2E state.',
            [sids[2]]: 'Codex card rendered from injected E2E state.',
          },
          startedAt: Date.now() - 1200,
          endedAt: Date.now(),
        }],
        messages: [
          { id: 'u1', turnNum: 1, role: 'user', content: 'E2E delegated renderer smoke question', createdAt: now },
          { id: 'a1-m1', turnNum: 1, role: 'assistant', sid: sids[0], speaker: 'Claude E2E', content: 'Claude card rendered from injected E2E state.', status: 'completed', createdAt: now + 1 },
          { id: 'a1-m2', turnNum: 1, role: 'assistant', sid: sids[1], speaker: 'DeepSeek E2E', content: 'DeepSeek card rendered from injected E2E state.', status: 'completed', createdAt: now + 2 },
          { id: 'a1-m3', turnNum: 1, role: 'assistant', sid: sids[2], speaker: 'Codex E2E', content: 'Codex card rendered from injected E2E state.', status: 'completed', createdAt: now + 3 },
        ],
        aiStats: {},
      };
      window.__meetingRoomSmokeState = state;
      const ipc = require('electron').ipcRenderer;
      if (!window.__meetingRoomSmokeRealInvoke) {
        window.__meetingRoomSmokeRealInvoke = ipc.invoke.bind(ipc);
        ipc.invoke = (channel, args) => channel === 'groupchat:get-state' && args?.meetingId === meeting.id
          ? Promise.resolve(window.__meetingRoomSmokeState)
          : window.__meetingRoomSmokeRealInvoke(channel, args);
      }
      const result = window.MeetingRoom.debugRenderGroupChatState(meeting.id, state);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        debugOk: !!(result && result.ok),
        panelVisible: getComputedStyle(document.getElementById('meeting-room-panel')).display !== 'none',
        messages: Array.from(document.querySelectorAll('.mr-gc-msg')).map((el) => ({
          id: el.getAttribute('data-gc-msg-id'),
          text: (el.innerText || '').slice(0, 220),
        })),
        legacyCards: document.querySelectorAll('.mr-ft[data-ft-sid]').length,
        legacyViewButtons: document.querySelectorAll('#mr-btn-group-' + 'card-view,#mr-btn-group-' + 'chat-view').length,
        retryActions: document.querySelectorAll('[data-gc-retry-answer]').length,
        userResendActions: document.querySelectorAll('[data-gc-resend-turn]').length,
        panelText: (document.getElementById('mr-gc-panel')?.innerText || '').slice(0, 500),
        newUi: {
          turnLane: !!document.querySelector('.mr-turn-lane'),
          nextActions: Array.from(document.querySelectorAll('[data-gc-next-action]')).map(btn => btn.getAttribute('data-gc-next-action')),
          nextActionsBar: (document.querySelector('.mr-next-actions')?.innerText || '').replace(/\s+/g, ' ').trim(),
          memberRows: document.querySelectorAll('.mr-gc-member-row').length,
          mobileWorkbench: !!document.querySelector('.mr-mobile-workbench'),
          battlePanel: (document.getElementById('mr-input-preflight')?.innerText || ''),
          headerSecondary: !!document.querySelector('.mr-header-secondary-actions'),
        },
      };
    })()`);

    assert.strictEqual(setup.debugOk, true, 'debugRenderGroupChatState must succeed');
    assert.strictEqual(setup.panelVisible, true, 'meeting room panel must be visible');
    assert.strictEqual(setup.legacyCards, 0, 'legacy parallel AI cards must stay removed from group rooms');
    assert.strictEqual(setup.legacyViewButtons, 0, 'group header must expose one unified view');
    assert.strictEqual(setup.messages.length, 4, 'unified view must render one user card plus three AI cards');
    assert.ok(setup.messages.some((message) => /Codex card rendered/.test(message.text)), 'Codex card text must render');
    assert.strictEqual(setup.retryActions, 3, 'each settled AI card must expose retry/re-answer');
    assert.strictEqual(setup.userResendActions, 1, 'user card must expose resend/edit recovery');
    assert.strictEqual(setup.newUi.turnLane, true, 'turn progress lane must render in real renderer');
    // 2026-07-20 产品决策：五个低频 next-action 按钮已从 bar 摘除，仅保留轮次结束 label；
    // handler 分支保留备用，由 unit-meeting-input-composer-contract.test.js 锁定。
    assert.deepStrictEqual(setup.newUi.nextActions, [], 'low-frequency next-action buttons stay removed');
    assert.ok(/已结束/.test(setup.newUi.nextActionsBar), 'next action bar must still render the round-finished label');
    assert.strictEqual(setup.newUi.memberRows, 3, 'unified member rail must render all members');
    assert.strictEqual(setup.newUi.mobileWorkbench, true, 'mobile workbench must be present for responsive view');
    assert.ok(/发送给|目标/.test(setup.newUi.battlePanel), 'input battle panel must render target context');
    assert.strictEqual(setup.newUi.headerSecondary, true, 'header secondary action group must render');

    const actionFlow = await client.eval(`(async () => {
      const edit = document.querySelector('[data-gc-edit-turn="u1"]');
      if (!edit) throw new Error('user edit-resend action missing');
      edit.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const input = document.getElementById('mr-input-box');
      const membersBefore = document.querySelectorAll('.mr-gc-member-row').length;
      const retryLabels = [...document.querySelectorAll('[data-gc-retry-answer]')].map(button => button.textContent.trim());
      document.getElementById('mr-btn-group-members')?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        inputText: input?.innerText || '',
        membersBefore,
        sideCollapsed: !!document.querySelector('.mr-gc-shell.side-collapsed'),
        retryLabels,
      };
    })()`);
    assert.ok(actionFlow.inputText.includes('E2E delegated renderer smoke question'), 'edit-resend must restore the user question to the composer');
    assert.strictEqual(actionFlow.membersBefore, 3, 'member rail starts with all members');
    assert.strictEqual(actionFlow.sideCollapsed, false, 'header member control must expand the default-collapsed unified member rail');
    assert.deepStrictEqual(actionFlow.retryLabels, ['重答', '重答', '重答'], 'settled AI cards expose re-answer actions');

    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    const shotSize = fs.statSync(SCREENSHOT_PATH).size;
    assert.ok(shotSize > 10 * 1024, 'screenshot should be non-empty');

    console.log(JSON.stringify({
      ok: true,
      port,
      screenshot: SCREENSHOT_PATH,
      screenshotBytes: shotSize,
      messages: setup.messages.map((message) => message.id),
      retryLabels: actionFlow.retryLabels,
    }, null, 2));
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-80).join('\n'));
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
