'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-meeting-avatar-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'meeting-avatar-navigation');
const SCREENSHOT = path.join(ARTIFACT_DIR, `avatar-navigation-${RUN_ID}.png`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitFor(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.HUB_MEETING_AVATAR_E2E_PORT || 19680));
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'meeting-avatar-navigation',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 920, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client,
      'window.__hubE2E && window.MeetingRoom && window.openMeetingMemberSession',
      'Hub meeting APIs');

    const result = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const api = window.__hubE2E;
      const now = Date.now();
      const meetingId = 'avatar-jump-meeting';
      const sids = ['avatar-claude', 'avatar-kimi', 'avatar-codex'];
      const kinds = ['claude', 'kimi', 'codex'];
      api.addFakeSessions(sids.map((id, index) => ({
        id, kind: kinds[index], title: ['Claude', 'Kimi', 'Codex'][index],
        status: 'idle', meetingId, createdAt: now + index, lastMessageTime: now + index,
      })));
      const meeting = {
        id: meetingId, title: '头像跳转 E2E', scene: 'general', groupChat: true,
        groupMode: 'fanout', status: 'idle', subSessions: sids, participants: [0, 1, 2],
        focusedSub: sids[0], createdAt: now, updatedAt: now,
      };
      meetings[meeting.id] = meeting;
      renderSessionList();

      const states = {
        card: {
          currentMode: 'idle', currentTurn: 1,
          turns: [{ n: 1, mode: 'group', userInput: '测试', by: {
            [sids[0]]: 'Claude answer', [sids[1]]: 'Kimi answer', [sids[2]]: 'Codex answer',
          }, byStatus: Object.fromEntries(sids.map(sid => [sid, 'completed'])), timestamp: now }],
          messages: [], aiStats: {},
        },
        chat: {
          currentMode: 'idle', currentTurn: 1, turns: [], aiStats: {},
          messages: [
            { id: 'u1', turnNum: 1, role: 'user', speaker: '我', content: '测试', createdAt: now },
            { id: 'a1', turnNum: 1, role: 'assistant', sid: sids[0], speaker: 'Claude', content: 'answer', status: 'completed', createdAt: now + 1 },
          ],
        },
        empty: { currentMode: 'idle', currentTurn: 0, turns: [], messages: [], aiStats: {} },
      };
      window.__avatarState = states.card;
      const ipc = require('electron').ipcRenderer;
      const realInvoke = ipc.invoke.bind(ipc);
      ipc.invoke = (channel, args) => channel === 'groupchat:get-state'
        ? Promise.resolve(window.__avatarState)
        : realInvoke(channel, args);

      const realOpen = window.openMeetingMemberSession;
      window.__avatarJumpCalls = [];
      window.openMeetingMemberSession = sid => {
        window.__avatarJumpCalls.push(sid);
        return realOpen(sid);
      };

      async function openRoom(mode, state) {
        window.__avatarState = state;
        localStorage.setItem('mr-group-chat-view-mode', mode);
        await api.selectMeeting(meeting.id);
        window.MeetingRoom.debugRenderGroupChatState(meeting.id, state);
        await wait(180);
      }

      async function clickAndCheck(selector, expectedSid) {
        const el = document.querySelector(selector);
        if (!el) throw new Error('missing avatar: ' + selector);
        const semantics = {
          sid: el.getAttribute('data-gc-open-session'),
          role: el.getAttribute('role'),
          tabindex: el.getAttribute('tabindex'),
          title: el.getAttribute('title'),
          cursor: getComputedStyle(el).cursor,
        };
        el.click();
        await wait(220);
        return {
          expectedSid,
          actualSid: window.__avatarJumpCalls.at(-1),
          semantics,
          meetingClosed: window.MeetingRoom.getActiveMeetingId() === null,
          meetingPanelHidden: document.getElementById('meeting-room-panel').style.display === 'none',
          terminalPanelVisible: document.getElementById('terminal-panel').style.display !== 'none',
        };
      }

      await openRoom('card', states.card);
      const card = await clickAndCheck('.mr-ft[data-ft-sid="avatar-kimi"] .mr-ft-avatar[data-gc-open-session]', sids[1]);

      await openRoom('chat', states.chat);
      const chat = await clickAndCheck('.mr-gc-msg.ai .mr-gc-avatar[data-gc-open-session]', sids[0]);

      await openRoom('card', states.empty);
      const onboardingEl = document.querySelector('.mr-gc-ob-avatar[data-gc-open-session="avatar-codex"]');
      onboardingEl.focus();
      onboardingEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(220);
      const onboarding = {
        expectedSid: sids[2],
        actualSid: window.__avatarJumpCalls.at(-1),
        keyboardFocused: document.activeElement === onboardingEl,
        meetingClosed: window.MeetingRoom.getActiveMeetingId() === null,
        meetingPanelHidden: document.getElementById('meeting-room-panel').style.display === 'none',
      };

      return { card, chat, onboarding, calls: window.__avatarJumpCalls.slice() };
    })()`);

    for (const item of [result.card, result.chat]) {
      assert.equal(item.actualSid, item.expectedSid, JSON.stringify(item));
      assert.equal(item.semantics.sid, item.expectedSid, JSON.stringify(item));
      assert.equal(item.semantics.role, 'button', JSON.stringify(item));
      assert.equal(item.semantics.tabindex, '0', JSON.stringify(item));
      assert.match(item.semantics.title, /CLI/);
      assert.equal(item.semantics.cursor, 'pointer', JSON.stringify(item));
      assert.equal(item.meetingClosed, true, JSON.stringify(item));
      assert.equal(item.meetingPanelHidden, true, JSON.stringify(item));
      assert.equal(item.terminalPanelVisible, true, JSON.stringify(item));
    }
    assert.equal(result.onboarding.actualSid, result.onboarding.expectedSid, JSON.stringify(result.onboarding));
    assert.equal(result.onboarding.meetingClosed, true, JSON.stringify(result.onboarding));
    assert.equal(result.onboarding.meetingPanelHidden, true, JSON.stringify(result.onboarding));
    assert.deepEqual(result.calls, ['avatar-kimi', 'avatar-claude', 'avatar-codex']);

    await client.eval(`(async () => {
      const api = window.__hubE2E;
      await api.selectMeeting('avatar-jump-meeting');
      localStorage.setItem('mr-group-chat-view-mode', 'card');
      window.MeetingRoom.debugRenderGroupChatState('avatar-jump-meeting', window.__avatarState);
      await new Promise(resolve => setTimeout(resolve, 180));
    })()`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ ok: true, port, result, screenshot: SCREENSHOT }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-meeting-avatar-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
