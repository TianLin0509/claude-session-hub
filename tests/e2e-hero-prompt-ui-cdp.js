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
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `hero-prompt-b-${STAMP}`);
const DOCK_SCREENSHOT = path.join(OUTPUT, '01-hero-dock.png');
const PREVIEW_SCREENSHOT = path.join(OUTPUT, '02-prompt-preview.png');

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
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
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

function cleanupDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmpRoot + path.sep)) return;
  if (!path.basename(resolved).startsWith('claude-session-hub-hero-prompt-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const port = await availablePort(Number(process.env.HERO_PROMPT_E2E_PORT || 19531));
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-hero-prompt-e2e-${process.pid}-${STAMP}`);
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'hero-prompt-b',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForEval(client, 'window.MeetingRoom && window.MeetingRoom.debugRenderGroupChatState && window.__hubE2E', 'real Hub meeting renderer');

    const setup = await client.eval(`(async () => {
      window.__heroPromptErrors = [];
      window.addEventListener('error', event => window.__heroPromptErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', event => window.__heroPromptErrors.push(String(event.reason)));
      const now = Date.now();
      const sids = ['hero-e2e-claude', 'hero-e2e-codex', 'hero-e2e-kimi'];
      const kinds = ['claude', 'codex', 'kimi'];
      const titles = ['Claude 1', 'Codex 2', 'Kimi 3'];
      sids.forEach((sid, index) => sessions.set(sid, {
        id: sid, kind: kinds[index], title: titles[index], status: 'active', createdAt: now, lastMessageTime: now,
      }));
      const meeting = {
        id: 'hero-prompt-b-e2e', title: '英雄 Prompt · 投研群聊', scene: 'research', groupChat: true,
        groupMode: 'fanout', subSessions: sids, participants: [0, 1, 2], focusedSub: sids[0],
        createdAt: now, updatedAt: now, lastMessageTime: now,
      };
      meetings[meeting.id] = meeting;
      await window.__hubE2E.selectMeeting(meeting.id);
      await new Promise(resolve => setTimeout(resolve, 700));
      window.MeetingRoom.debugRenderGroupChatState(meeting.id, { currentMode: 'idle', turnNum: 0, turns: [], messages: [] });
      await new Promise(resolve => setTimeout(resolve, 180));

      const choose = (sid, heroId) => {
        const select = document.querySelector('[data-hero-sid="' + sid + '"]');
        if (!select) throw new Error('hero select missing for ' + sid);
        select.value = heroId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      choose(sids[0], 'buffett.mature.v1');
      choose(sids[1], 'livermore.trend.v1');
      await new Promise(resolve => setTimeout(resolve, 100));
      document.getElementById('mr-hero-dock').scrollIntoView({ block: 'center' });
      return {
        visible: getComputedStyle(document.getElementById('mr-hero-dock')).display !== 'none',
        order: Array.from(document.getElementById('mr-input-row').parentNode.children).map(el => el.id).filter(Boolean),
        values: Object.fromEntries(Array.from(document.querySelectorAll('[data-hero-sid]')).map(el => [el.getAttribute('data-hero-sid'), el.value])),
        meta: document.querySelector('.mr-hero-dock-meta')?.textContent || '',
      };
    })()`);

    assert.strictEqual(setup.visible, true, '方案 B dock must be visible in a research group chat');
    assert.ok(setup.order.indexOf('mr-input-preflight') < setup.order.indexOf('mr-hero-dock'), 'preflight must stay above the hero dock');
    assert.ok(setup.order.indexOf('mr-hero-dock') < setup.order.indexOf('mr-input-row'), 'hero dock must sit immediately above the composer');
    assert.strictEqual(setup.values['hero-e2e-claude'], 'buffett.mature.v1');
    assert.strictEqual(setup.values['hero-e2e-codex'], 'livermore.trend.v1');
    assert.ok(setup.meta.includes('2 位'), 'dock must summarize assigned AI count');
    await capture(client, DOCK_SCREENSHOT);

    const preview = await client.eval(`(async () => {
      document.querySelector('[data-hero-preview]').click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const modal = document.querySelector('.mr-hero-prompt-modal-overlay');
      return {
        visible: !!modal,
        text: modal?.innerText || '',
        errors: window.__heroPromptErrors.slice(),
      };
    })()`);
    assert.strictEqual(preview.visible, true, 'prompt preview modal must open');
    assert.ok(preview.text.includes('Claude 1 → 巴菲特'));
    assert.ok(preview.text.includes('Codex 2 → 利弗莫尔'));
    assert.ok(preview.text.includes('本轮问题附带的价值投资或右侧交易等方法倾向'));
    assert.deepStrictEqual(preview.errors, []);
    await capture(client, PREVIEW_SCREENSHOT);

    const sent = await client.eval(`(async () => {
      document.querySelector('.mr-hero-prompt-modal-overlay .mr-gc-prompt-modal-close').click();
      const ipc = require('electron').ipcRenderer;
      const originalInvoke = ipc.invoke;
      window.__heroCapturedTurn = null;
      ipc.invoke = async function(channel, args) {
        if (channel === 'meeting-append-user-turn') return { ok: true };
        if (channel === 'groupchat:turn') {
          window.__heroCapturedTurn = JSON.parse(JSON.stringify(args || {}));
          return { status: 'completed', turnNum: 1, results: [] };
        }
        return originalInvoke.call(ipc, channel, args);
      };
      try {
        const input = document.getElementById('mr-input-box');
        input.textContent = '比较下一阶段赔率。';
        document.getElementById('mr-send-btn').click();
        const deadline = Date.now() + 3000;
        while (!window.__heroCapturedTurn && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
        await new Promise(resolve => setTimeout(resolve, 80));
        return {
          payload: window.__heroCapturedTurn,
          valuesAfter: Array.from(document.querySelectorAll('[data-hero-sid]')).map(el => el.value),
          previewDisabled: document.querySelector('[data-hero-preview]')?.disabled,
          errors: window.__heroPromptErrors.slice(),
        };
      } finally {
        ipc.invoke = originalInvoke;
      }
    })()`);
    assert.deepStrictEqual(sent.payload.heroIdBySid, {
      'hero-e2e-claude': 'buffett.mature.v1',
      'hero-e2e-codex': 'livermore.trend.v1',
    }, 'renderer must submit only per-AI built-in hero ids');
    assert.ok(sent.valuesAfter.every(value => value === ''), 'all one-shot hero selections must clear after send');
    assert.strictEqual(sent.previewDisabled, true, 'preview must disable after one-shot selection is consumed');
    assert.deepStrictEqual(sent.errors, []);

    const scope = await client.eval(`(async () => {
      const meeting = meetings['hero-prompt-b-e2e'];
      meeting.scene = 'general';
      window.MeetingRoom.debugRenderGroupChatState(meeting.id, { currentMode: 'idle', turnNum: 1, turns: [], messages: [] });
      await new Promise(resolve => setTimeout(resolve, 100));
      return getComputedStyle(document.getElementById('mr-hero-dock')).display;
    })()`);
    assert.strictEqual(scope, 'none', 'hero dock must be hidden outside the research scene');

    console.log(JSON.stringify({
      ok: true,
      port,
      dockScreenshot: DOCK_SCREENSHOT,
      previewScreenshot: PREVIEW_SCREENSHOT,
      submittedHeroIdBySid: sent.payload.heroIdBySid,
      clearedAfterSend: sent.valuesAfter.every(value => value === ''),
      generalSceneDisplay: scope,
      runtimeErrors: sent.errors.length,
    }, null, 2));
  } catch (error) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-100).join('\n'));
    }
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    cleanupDataDir(dataDir);
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
