'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `meeting-room-renderer-smoke-${STAMP}.png`);

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
      localStorage.setItem('mr-group-chat-view-mode', 'card');
      localStorage.setItem('mr-card-view-mode', 'tab');
      document.body.classList.add('mr-card-tab-mode');

      const sids = ['e2e-claude', 'e2e-gemini', 'e2e-codex'];
      const now = Date.now();
      const fakeSessions = [
        { id: sids[0], kind: 'claude', title: 'Claude E2E', status: 'active', model: 'sonnet', contextPercent: 12, createdAt: now, lastMessageTime: now },
        { id: sids[1], kind: 'gemini', title: 'Gemini E2E', status: 'active', model: 'pro', contextPercent: 18, createdAt: now, lastMessageTime: now },
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
      };
      const result = window.MeetingRoom.debugRenderGroupChatState(meeting.id, state);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        debugOk: !!(result && result.ok),
        panelVisible: getComputedStyle(document.getElementById('meeting-room-panel')).display !== 'none',
        cards: Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]')).map((el) => ({
          sid: el.getAttribute('data-ft-sid'),
          active: el.classList.contains('active'),
          preview: el.querySelector('.mr-ft-preview')?.innerText || '',
          text: (el.innerText || '').slice(0, 180),
        })),
        tabs: Array.from(document.querySelectorAll('[data-gc-card-tab-sid]')).map((el) => ({
          sid: el.getAttribute('data-gc-card-tab-sid'),
          active: el.classList.contains('active'),
        })),
        userQuestionText: document.querySelector('.mr-gc-userq-text')?.textContent || '',
        panelText: (document.getElementById('mr-gc-panel')?.innerText || '').slice(0, 500),
        newUi: {
          turnLane: !!document.querySelector('.mr-turn-lane'),
          nextActions: Array.from(document.querySelectorAll('[data-gc-next-action]')).map(btn => btn.getAttribute('data-gc-next-action')),
          nextActionsBar: (document.querySelector('.mr-next-actions')?.innerText || '').replace(/\s+/g, ' ').trim(),
          cardRoster: document.querySelectorAll('.mr-card-roster-member').length,
          latestRound: (document.querySelector('.mr-latest-round-head')?.innerText || ''),
          mobileWorkbench: !!document.querySelector('.mr-mobile-workbench'),
          battlePanel: (document.getElementById('mr-input-preflight')?.innerText || ''),
          headerSecondary: !!document.querySelector('.mr-header-secondary-actions'),
        },
      };
    })()`);

    assert.strictEqual(setup.debugOk, true, 'debugRenderGroupChatState must succeed');
    assert.strictEqual(setup.panelVisible, true, 'meeting room panel must be visible');
    assert.strictEqual(setup.cards.length, 3, 'card view must render three AI cards');
    assert.strictEqual(setup.tabs.length, 3, 'tab mode must render three card tabs');
    assert.ok(setup.userQuestionText.includes('E2E delegated renderer smoke question'), 'user question banner must render injected turn');
    assert.ok(setup.cards.some((card) => card.sid === 'e2e-codex' && /Codex card rendered/.test(card.preview)), 'Codex card text must render');
    assert.strictEqual(setup.newUi.turnLane, true, 'turn progress lane must render in real renderer');
    // 2026-07-20 产品决策：五个低频 next-action 按钮已从 bar 摘除，仅保留轮次结束 label；
    // handler 分支保留备用，由 unit-meeting-input-composer-contract.test.js 锁定。
    assert.deepStrictEqual(setup.newUi.nextActions, [], 'low-frequency next-action buttons stay removed');
    assert.ok(/已结束/.test(setup.newUi.nextActionsBar), 'next action bar must still render the round-finished label');
    assert.strictEqual(setup.newUi.cardRoster, 3, 'card roster must render all members');
    assert.ok(/最新轮回答/.test(setup.newUi.latestRound), 'latest-round priority region must render');
    assert.strictEqual(setup.newUi.mobileWorkbench, true, 'mobile workbench must be present for responsive view');
    assert.ok(/作战面板/.test(setup.newUi.battlePanel), 'input battle panel must render');
    assert.strictEqual(setup.newUi.headerSecondary, true, 'header secondary action group must render');

    const actionFlow = await client.eval(`(async () => {
      const quote = document.querySelector('.mr-ft.active [data-gc-action="quote"]');
      if (!quote) throw new Error('active card quote button missing');
      quote.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        quoteChip: document.querySelector('.mr-gc-quote-chip')?.innerText || '',
        preflightText: document.getElementById('mr-input-preflight')?.innerText || '',
      };
    })()`);
    assert.ok(/Claude/.test(actionFlow.quoteChip), 'quote button must add focused card to quote chips');
    assert.ok(/引用\s*1/.test(actionFlow.preflightText.replace(/\n/g, ' ')), 'preflight panel must reflect quote count');

    const tabClick = await client.eval(`(async () => {
      const third = document.querySelector('[data-gc-card-tab-sid="e2e-codex"]');
      if (!third) throw new Error('codex tab missing');
      third.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const meeting = window.MeetingRoom.getMeetingData('e2e-meeting-room-smoke');
      return {
        focusedSub: meeting && meeting.focusedSub,
        activeTabSid: document.querySelector('.mr-card-view-tab.active')?.getAttribute('data-gc-card-tab-sid') || null,
        activeCardSid: document.querySelector('.mr-ft.active')?.getAttribute('data-ft-sid') || null,
      };
    })()`);

    assert.strictEqual(tabClick.focusedSub, 'e2e-codex', 'delegated tab click must update focusedSub');
    assert.strictEqual(tabClick.activeTabSid, 'e2e-codex', 'delegated tab click must update active tab');
    assert.strictEqual(tabClick.activeCardSid, 'e2e-codex', 'delegated tab click must update active card');

    const timeline = await client.eval(`(async () => {
      const expand = document.querySelector('.mr-ft.active .mr-ft-expand');
      if (!expand) throw new Error('active card expand button missing');
      expand.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const overlay = document.getElementById('mr-gc-timeline-overlay');
      const visible = !!overlay && getComputedStyle(overlay).display !== 'none';
      overlay?.querySelector('[data-gc-tl-close]')?.click();
      return { visible };
    })()`);
    assert.strictEqual(timeline.visible, true, 'delegated expand click must open the timeline overlay');

    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    const shotSize = fs.statSync(SCREENSHOT_PATH).size;
    assert.ok(shotSize > 10 * 1024, 'screenshot should be non-empty');

    console.log(JSON.stringify({
      ok: true,
      port,
      screenshot: SCREENSHOT_PATH,
      screenshotBytes: shotSize,
      focusedSub: tabClick.focusedSub,
      cards: setup.cards.map((card) => card.sid),
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
