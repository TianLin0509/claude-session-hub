'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${process.pid}-${Date.now()}`;
const DATA_DIR = path.join(os.tmpdir(), `hub-session-click-${RUN_ID}`, 'data');
const SCREENSHOT = path.join(ROOT, 'output', 'playwright', 'session-click-reliability', `result-${RUN_ID}.png`);
const CDP_PORT = Number(process.env.HUB_SESSION_CLICK_E2E_PORT || (19820 + (process.pid % 100)));

async function physicalClickWithSidebarRebuild(client, sessionId, attribute = 'data-session-id') {
  await client.send('Page.bringToFront');
  const point = await client.eval(`(() => {
    const row = document.querySelector('[${attribute}="${sessionId}"]');
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

async function waitForRenderer(client, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval('!!(window.__hubE2E && window.__hubE2E.clearSessions)')) return;
    } catch {}
    await _waitMs(100);
  }
  throw new Error('renderer E2E bridge did not become ready');
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
      // Navigation latency must be measured in a visible foreground renderer.
      // Chromium deliberately throttles hidden-window rAF/compositor work,
      // which turns xterm surface recovery into a background-policy benchmark.
      windowMode: 'visible',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(path.dirname(DATA_DIR), 'home'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await waitForRenderer(client);
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

    // Sustained real-pointer pressure: every activation rebuilds all 700+ rows
    // between down/up, matching the production race instead of calling
    // selectSession directly. Alternate two stable rows so this also catches a
    // delayed compatibility click stealing the next activation.
    const navigationStress = { iterations: 12, failures: [], delaysMs: [], maxActivationDelayMs: 0 };
    for (let index = 0; index < navigationStress.iterations; index += 1) {
      const targetId = index % 2 === 0 ? 'click-a' : 'click-b';
      const stressReleasedAt = await physicalClickWithSidebarRebuild(client, targetId);
      const observed = await client.eval(`(async () => {
        const deadline = Date.now() + 1200;
        while (activeSessionId !== ${JSON.stringify(targetId)} && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return {
          activeSessionId,
          selected:document.querySelector('#session-list .session-item.selected')?.dataset.sessionId || null,
          delayMs:Date.now() - ${stressReleasedAt},
        };
      })()`);
      navigationStress.delaysMs.push(observed.delayMs);
      navigationStress.maxActivationDelayMs = Math.max(navigationStress.maxActivationDelayMs, observed.delayMs);
      if (observed.activeSessionId !== targetId || observed.selected !== targetId) {
        navigationStress.failures.push({ index, targetId, observed });
      }
      // A fast human rhythm, while still leaving one paint opportunity between
      // clicks so this remains a UI stress test rather than an artificial CDP
      // command-queue benchmark.
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const sortedStressDelays = navigationStress.delaysMs.slice().sort((a, b) => a - b);
    navigationStress.p95ActivationDelayMs = sortedStressDelays[Math.floor((sortedStressDelays.length - 1) * 0.95)] || 0;
    assert.deepEqual(navigationStress.failures, []);
    assert.ok(navigationStress.p95ActivationDelayMs < 500,
      `stress navigation p95 took ${navigationStress.p95ActivationDelayMs}ms`);
    assert.ok(navigationStress.maxActivationDelayMs < 2500,
      `stress navigation max took ${navigationStress.maxActivationDelayMs}ms`);
    navigationStress.settleMs = 500;
    await new Promise(resolve => setTimeout(resolve, navigationStress.settleMs));

    const meetingSetup = await client.eval(`(() => {
      const now = Date.now();
      const meetingId = 'click-meeting';
      const subSessions = ['click-meeting-claude', 'click-meeting-codex'];
      window.__hubE2E.addFakeSessions([
        {
          id:subSessions[0], title:'Meeting Claude', kind:'claude', status:'error', meetingId, lastMessageTime:now,
          lastError:'stream disconnected before completion: ECONNRESET',
          connectionIssue:{
            type:'stream-disconnected', message:'stream disconnected before completion: ECONNRESET',
            signature:'stream disconnected before completion: econnreset', observedAt:now - 1000,
          },
        },
        { id:subSessions[1], title:'Meeting Codex', kind:'codex', status:'idle', meetingId, lastMessageTime:now },
      ]);
      meetings[meetingId] = {
        id:meetingId, title:'Meeting click target', scene:'general', mode:'free', groupChat:true,
        status:'idle', subSessions, participants:[0,1], focusedSub:subSessions[0],
        createdAt:now, updatedAt:now, lastMessageTime:now,
      };
      renderSessionList();
      return { meetingId, exists:!!document.querySelector('[data-meeting-id="' + meetingId + '"]') };
    })()`);
    assert.equal(meetingSetup.exists, true);
    const meetingReleasedAt = await physicalClickWithSidebarRebuild(client, meetingSetup.meetingId, 'data-meeting-id');
    const meetingClicked = await client.eval(`(async () => {
      const deadline = Date.now() + 1200;
      let activationDelayMs = null;
      while (Date.now() < deadline) {
        const row = document.querySelector('[data-meeting-id="click-meeting"]');
        if (activeMeetingId === 'click-meeting' && row?.classList.contains('selected')) {
          activationDelayMs = Date.now() - ${meetingReleasedAt};
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const panelDeadline = Date.now() + 3000;
      while (document.getElementById('meeting-room-panel')?.style.display === 'none'
          && Date.now() < panelDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const row = document.querySelector('[data-meeting-id="click-meeting"]');
      const failedChild = sessions.get('click-meeting-claude');
      return {
        activeMeetingId,
        activeSessionId,
        selected:row?.classList.contains('selected') || false,
        activationDelayMs,
        panelReadyDelayMs:Date.now() - ${meetingReleasedAt},
        panelVisible:document.getElementById('meeting-room-panel')?.style.display !== 'none',
        failedChildIssue:failedChild?.connectionIssue || null,
        failedChildAck:failedChild?._connectionIssueAck || null,
        failedChildRuntime:failedChild ? getSessionRuntimeTruth(failedChild).state : null,
      };
    })()`);
    assert.equal(meetingClicked.activeMeetingId, 'click-meeting');
    assert.equal(meetingClicked.activeSessionId, null);
    assert.equal(meetingClicked.selected, true);
    assert.equal(meetingClicked.panelVisible, true);
    assert.equal(meetingClicked.failedChildIssue, null);
    assert.equal(meetingClicked.failedChildAck?.signature, 'stream disconnected before completion: econnreset');
    assert.equal(meetingClicked.failedChildRuntime, 'idle');
    assert.ok(meetingClicked.activationDelayMs < 500, `meeting navigation feedback took ${meetingClicked.activationDelayMs}ms`);
    assert.ok(meetingClicked.panelReadyDelayMs < 3000, `meeting panel took ${meetingClicked.panelReadyDelayMs}ms`);

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
        connectionIssue:{
          type:'stream-disconnected', message:'stream disconnected before completion: ECONNRESET',
          signature:'stream disconnected before completion: econnreset', observedAt:Date.now() - 1000,
        },
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
        issue:sessions.get('dormant-click')?.connectionIssue || null,
        issueAck:sessions.get('dormant-click')?._connectionIssueAck || null,
      };
    })()`);
    assert.equal(dormantPending.activeSessionId, 'dormant-click');
    assert.equal(dormantPending.selected, true);
    assert.equal(dormantPending.resuming, true);
    assert.match(dormantPending.rowText, /唤醒中/);
    assert.match(dormantPending.panelText, /正在唤醒会话/);
    assert.equal(dormantPending.pendingCount, 1);
    assert.equal(dormantPending.issue, null);
    assert.equal(dormantPending.issueAck?.signature, 'stream disconnected before completion: econnreset');

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({
      ok: true, releasedAt, setup, clicked, navigationStress, meetingClicked, dormantPending, screenshot: SCREENSHOT, pid: hub.pid,
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
