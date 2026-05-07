// tests/e2e-roundtable-sidebar-bump.js
//
// Verifies the sidebar behavior for a background roundtable:
// when a roundtable turn completes, the meeting gets the "waiting" unread badge
// and moves above newer regular sessions using the same millisecond timestamp
// unit as the rest of the sidebar sort.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const TEMP_ROOT = path.join(os.tmpdir(), `hub-sidebar-bump-${Date.now()}`);
const DATA_DIR = path.join(TEMP_ROOT, 'data');
const SCREENSHOT_DIR = path.join(HUB_ROOT, 'tests', 'screenshots', 'roundtable-sidebar-bump');
const CDP_PORT = 9295;

function screenshotPath(name) {
  return path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
}

async function screenshot(client, outPath) {
  await client.send('Page.enable');
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'));
}

async function createPowerShellSession(client, title) {
  return await client.eval(`(async () => {
    return await ipcRenderer.invoke('create-session', {
      kind: 'powershell',
      opts: { title: ${JSON.stringify(title)} }
    });
  })()`);
}

async function connectHubPage(hub) {
  const deadline = Date.now() + 20000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    lastTargets = await listCdpTargets(hub);
    const hasMain = lastTargets.some(t => t.type === 'page' && /index\.html/i.test(t.url || ''));
    if (hasMain) {
      return await connectFirstPage(hub, t => t.type === 'page' && /index\.html/i.test(t.url || ''));
    }
    await _waitMs(300);
  }
  throw new Error('No Hub index.html CDP target. Targets: ' + JSON.stringify(lastTargets));
}

async function createMeeting(client, title) {
  return await client.eval(`(async () => {
    return await ipcRenderer.invoke('create-meeting', {
      mode: 'general',
      title: ${JSON.stringify(title)},
      slots: [{ index: 0, kind: 'powershell', model: null }]
    });
  })()`);
}

async function sidebarState(client) {
  return await client.eval(`(() => {
    return [...document.querySelectorAll('#session-list > .session-item')]
      .map((el, index) => ({
        index,
        meetingId: el.dataset.meetingId || null,
        sessionId: el.dataset.sessionId || null,
        title: (el.querySelector('.session-title')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        hasUnread: el.classList.contains('has-unread')
      }));
  })()`);
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let hub;
  let client;
  const shots = [];

  try {
    console.log('[setup] launching isolated Hub');
    console.log('dataDir:', DATA_DIR);
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: CDP_PORT, label: 'sidebar-bump' });
    await _waitMs(2500);
    client = await connectHubPage(hub);
    await client.send('Runtime.enable');

    console.log('[setup] creating regular session + roundtable via production IPC');
    const meeting = await createMeeting(client, 'E2E-old-roundtable');
    assert.ok(meeting && meeting.id, 'meeting creation failed');
    const regular = await createPowerShellSession(client, 'E2E-new-regular');
    assert.ok(regular && regular.id, 'regular session creation failed');

    await _waitMs(1000);
    await client.eval(`(() => {
      const now = Date.now();
      meetings[${JSON.stringify(meeting.id)}].lastMessageTime = now - 120000;
      const s = sessions.get(${JSON.stringify(regular.id)});
      s.lastMessageTime = now - 1000;
      renderSessionList();
      selectSession(${JSON.stringify(regular.id)});
      return true;
    })()`);
    await _waitMs(500);

    const before = await sidebarState(client);
    console.log('[before]', JSON.stringify(before.slice(0, 4), null, 2));
    assert.strictEqual(before[0].meetingId, null, 'precondition failed: first item should be a regular session before new roundtable message');
    assert.ok(before[0].title.includes('E2E-new-regular'), 'precondition failed: regular session should be first before new roundtable message');

    const beforeShot = screenshotPath('before');
    await screenshot(client, beforeShot);
    shots.push(beforeShot);

    console.log('[action] emitting roundtable-turn-complete into renderer event path');
    const afterEvent = await client.eval(`(() => {
      ipcRenderer.emit('roundtable-turn-complete', {}, { meetingId: ${JSON.stringify(meeting.id)}, turnNum: 1 });
      const m = meetings[${JSON.stringify(meeting.id)}];
      return { unreadCount: m.unreadCount, lastMessageTime: m.lastMessageTime, now: Date.now() };
    })()`);
    console.log('[event]', JSON.stringify(afterEvent, null, 2));
    assert.strictEqual(afterEvent.unreadCount, 1, 'roundtable unread count should increment');
    assert.ok(afterEvent.lastMessageTime > Date.now() - 5000, 'roundtable lastMessageTime should be fresh milliseconds');

    await _waitMs(500);
    const after = await sidebarState(client);
    console.log('[after]', JSON.stringify(after.slice(0, 4), null, 2));
    assert.strictEqual(after[0].meetingId, meeting.id, 'roundtable should move to top after new message');
    assert.ok(after[0].hasUnread, 'roundtable should have unread visual state');
    assert.ok(/等你/.test(after[0].text), 'roundtable should show waiting badge text');

    const afterShot = screenshotPath('after');
    await screenshot(client, afterShot);
    shots.push(afterShot);

    console.log('\nPASS roundtable sidebar unread bump');
    console.log('screenshots:');
    for (const s of shots) console.log(' - ' + s);
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(e => console.warn('gracefulQuit failed:', e.message));
  }
}

main().catch((e) => {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
});
