'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${process.pid}-${Date.now()}`;
const DATA_DIR = path.join(os.tmpdir(), `hub-session-click-${RUN_ID}`, 'data');
const SCREENSHOT = path.join(ROOT, 'output', 'playwright', 'session-click-reliability', `result-${RUN_ID}.png`);
const CDP_PORT = Number(process.env.HUB_SESSION_CLICK_E2E_PORT || (19820 + (process.pid % 100)));

async function physicalClickWithSidebarRebuild(client, sessionId) {
  const point = await client.eval(`(() => {
    const row = document.querySelector('[data-session-id="${sessionId}"]');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `missing sidebar row ${sessionId}`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  // Reproduce the production race: a status update replaces every row between
  // pointer-down and pointer-up. Per-row click listeners lose this click.
  await client.eval('renderSessionList()');
  const releasedAt = Date.now();
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
  return releasedAt;
}

(async () => {
  fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true });
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'session-click-reliability',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(path.dirname(DATA_DIR), 'home'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1365, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const setup = await client.eval(`(() => {
      const now = Date.now();
      window.__hubE2E.clearSessions();
      const items = [
        { id:'click-a', title:'Click A', kind:'codex', status:'idle', lastMessageTime:now + 2 },
        { id:'click-b', title:'Click B', kind:'codex', status:'idle', lastMessageTime:now + 1 },
      ];
      for (let i = 0; i < 700; i += 1) items.push({
        id:'bulk-' + i, title:'Bulk ' + i, kind:i % 2 ? 'claude' : 'codex',
        status:'dormant', lastMessageTime:now - 1000 - i, createdAt:now - 1000 - i,
      });
      const rendered = window.__hubE2E.addFakeSessions(items);
      return window.__hubE2E.selectSession('click-a').then(() => ({
        rendered, activeSessionId, rows:document.querySelectorAll('#session-list .session-item').length,
      }));
    })()`);
    assert.equal(setup.activeSessionId, 'click-a');
    assert.ok(setup.rows >= 700);

    const releasedAt = await physicalClickWithSidebarRebuild(client, 'click-b');
    const clicked = await client.eval(`(async () => {
      const deadline = Date.now() + 1200;
      while (activeSessionId !== 'click-b' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        activeSessionId,
        activationDelayMs:Date.now() - ${releasedAt},
        selected:document.querySelector('#session-list .session-item.selected')?.dataset.sessionId || null,
        renderStats:window.__hubE2E.sidebarRenderStats(),
      };
    })()`);
    assert.equal(clicked.activeSessionId, 'click-b', 'one physical click must survive a sidebar rebuild');
    assert.equal(clicked.selected, 'click-b');
    assert.ok(clicked.activationDelayMs < 500, `navigation feedback took ${clicked.activationDelayMs}ms`);

    const dormantSetup = await client.eval(`(() => {
      const originalInvoke = ipcRenderer.invoke;
      window.__sessionClickOriginalInvoke = originalInvoke;
      window.__sessionClickResumeResolve = null;
      const delayedInvoke = function(channel, ...args) {
        if (channel === 'resume-session') {
          return new Promise(resolve => { window.__sessionClickResumeResolve = resolve; });
        }
        return originalInvoke.call(ipcRenderer, channel, ...args);
      };
      ipcRenderer.invoke = delayedInvoke;
      window.__hubE2E.addFakeSession({
        id:'dormant-click', title:'Dormant click target', kind:'codex', status:'dormant',
        codexSid:'019faaaa-0000-7000-8000-000000000123', lastMessageTime:Date.now() + 100,
      });
      return { patched:ipcRenderer.invoke === delayedInvoke };
    })()`);
    assert.equal(dormantSetup.patched, true, 'test must delay resume IPC');
    await physicalClickWithSidebarRebuild(client, 'dormant-click');
    const dormantPending = await client.eval(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      const row = document.querySelector('[data-session-id="dormant-click"]');
      const panel = document.querySelector('.session-resume-pending');
      return {
        activeSessionId,
        selected:row?.classList.contains('selected') || false,
        resuming:row?.classList.contains('resuming') || false,
        rowText:row?.innerText || '',
        panelText:panel?.innerText || '',
        pendingCount:_pendingDormantResumes.size,
      };
    })()`);
    assert.equal(dormantPending.activeSessionId, 'dormant-click');
    assert.equal(dormantPending.selected, true);
    assert.equal(dormantPending.resuming, true);
    assert.match(dormantPending.rowText, /唤醒中/);
    assert.match(dormantPending.panelText, /正在唤醒会话/);
    assert.equal(dormantPending.pendingCount, 1);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({
      ok: true, releasedAt, setup, clicked, dormantPending, screenshot: SCREENSHOT, pid: hub.pid,
    }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const testRoot = path.dirname(DATA_DIR);
    if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(testRoot).startsWith('hub-session-click-')) {
      fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
