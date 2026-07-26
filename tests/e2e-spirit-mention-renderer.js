'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'output', 'playwright', `spirit-mention-${STAMP}`);
const MENU_SCREENSHOT = path.join(ARTIFACT_DIR, 'hub-research-spirit-mention-menu.png');
const INSERT_SCREENSHOT = path.join(ARTIFACT_DIR, 'hub-research-spirit-inserted.png');

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
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
      if (await client.eval(`Boolean(${expression})`)) return;
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
  if (!path.basename(resolved).startsWith('claude-session-hub-spirit-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function capture(client, targetPath) {
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(targetPath, Buffer.from(screenshot.data, 'base64'));
  assert.ok(fs.statSync(targetPath).size > 10 * 1024, `${path.basename(targetPath)} must be non-empty`);
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.SPIRIT_MENTION_E2E_PORT || 19441));
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-spirit-e2e-${process.pid}-${STAMP}`);

  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'spirit-mention-renderer',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        SPIRIT_REGISTRY_ROOT: path.resolve(HUB_ROOT, '..', 'spirit-lens-registry'),
      },
    });

    client = await connectFirstPage(hub, (target) => (
      target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || '')
    ));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForEval(
      client,
      'window.MeetingRoom && window.MeetingRoom.debugRenderGroupChatState && window.__hubE2E && document.getElementById("meeting-room-panel")',
      'real Hub meeting renderer',
    );

    const setup = await client.eval(`(async () => {
      window.__spiritE2EErrors = [];
      window.addEventListener('error', (event) => window.__spiritE2EErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', (event) => window.__spiritE2EErrors.push(String(event.reason)));

      const now = Date.now();
      const sids = ['spirit-e2e-claude', 'spirit-e2e-codex'];
      sessions.set(sids[0], { id: sids[0], kind: 'claude', title: 'Claude 研究席', status: 'active', model: 'sonnet', createdAt: now, lastMessageTime: now });
      sessions.set(sids[1], { id: sids[1], kind: 'codex', title: 'Codex 研究席', status: 'active', model: 'gpt-5', createdAt: now, lastMessageTime: now });

      const meeting = {
        id: 'spirit-mention-e2e',
        title: '英灵系统 · 隔离研究圆桌',
        scene: 'research',
        groupChat: true,
        groupMode: 'fanout',
        subSessions: sids,
        participants: [0, 1],
        focusedSub: sids[0],
        createdAt: now,
        updatedAt: now,
        lastMessageTime: now,
      };
      meetings[meeting.id] = meeting;
      await window.__hubE2E.selectMeeting(meeting.id);
      await new Promise((resolve) => setTimeout(resolve, 700));
      window.MeetingRoom.debugRenderGroupChatState(meeting.id, { currentMode: 'idle', turnNum: 0, turns: [] });
      await new Promise((resolve) => setTimeout(resolve, 120));

      const input = document.getElementById('mr-input-box');
      if (!input) throw new Error('meeting input missing');
      input.textContent = '@';
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '@' }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      input.scrollIntoView({ block: 'center' });

      const menu = document.getElementById('mr-gc-mention-menu');
      return {
        panelVisible: getComputedStyle(document.getElementById('meeting-room-panel')).display !== 'none',
        menuVisible: !!menu && getComputedStyle(menu).display !== 'none',
        items: Array.from(menu?.querySelectorAll('.mr-gc-mention-item') || []).map((el) => ({
          label: el.querySelector('.mr-gc-mention-label')?.textContent || '',
          value: el.querySelector('.mr-gc-mention-value')?.textContent || '',
          hint: el.querySelector('.mr-gc-mention-hint')?.textContent || '',
        })),
      };
    })()`);

    assert.strictEqual(setup.panelVisible, true, 'isolated real Hub meeting panel must be visible');
    assert.strictEqual(setup.menuVisible, true, 'typing @ must open the real mention picker');
    const values = setup.items.map((item) => item.value);
    assert.ok(values.includes('@英灵'), 'research room must expose generic spirit council mention');
    assert.ok(values.includes('@英灵 巴菲特'), 'research room must expose Buffett lens mention');
    assert.ok(values.includes('@英灵 利弗莫尔'), 'research room must expose Livermore lens mention');
    assert.ok(setup.items.some((item) => item.hint === '统一 Lens Packet'), 'generic mention must explain the unified packet contract');
    await capture(client, MENU_SCREENSHOT);

    const insertion = await client.eval(`(async () => {
      const menu = document.getElementById('mr-gc-mention-menu');
      const target = Array.from(menu.querySelectorAll('.mr-gc-mention-item')).find((el) => (
        el.querySelector('.mr-gc-mention-value')?.textContent === '@英灵 巴菲特'
      ));
      if (!target) throw new Error('Buffett mention item missing');
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        inputText: document.getElementById('mr-input-box')?.innerText || '',
        menuDisplay: getComputedStyle(menu).display,
        errors: window.__spiritE2EErrors.slice(),
      };
    })()`);
    assert.strictEqual(insertion.inputText.trim(), '@英灵 巴菲特', 'clicking the item must insert the exact portable command');
    assert.strictEqual(insertion.menuDisplay, 'none', 'mention menu must close after insertion');
    assert.deepStrictEqual(insertion.errors, [], 'renderer must not raise runtime errors during mention flow');
    await capture(client, INSERT_SCREENSHOT);

    const scopeCheck = await client.eval(`(async () => {
      const meeting = meetings['spirit-mention-e2e'];
      meeting.scene = 'general';
      const input = document.getElementById('mr-input-box');
      input.textContent = '@';
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '@' }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Array.from(document.querySelectorAll('#mr-gc-mention-menu .mr-gc-mention-value')).map((el) => el.textContent || '');
    })()`);
    assert.ok(!scopeCheck.some((value) => value.startsWith('@英灵')), 'spirit commands must stay scoped to research rooms');

    console.log(JSON.stringify({
      ok: true,
      port,
      menuScreenshot: MENU_SCREENSHOT,
      insertedScreenshot: INSERT_SCREENSHOT,
      spiritMentions: values.filter((value) => value.startsWith('@英灵')),
      insertedText: insertion.inputText,
      runtimeErrors: insertion.errors.length,
      generalRoomSpiritMentions: scopeCheck.filter((value) => value.startsWith('@英灵')).length,
    }, null, 2));
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-100).join('\n'));
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
