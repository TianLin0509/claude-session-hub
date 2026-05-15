'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9347', 10);
const DATA_DIR = path.join(os.tmpdir(), `hub-e2e-escape-home-${Date.now()}`);
const SHOT_DIR = path.join(__dirname, 'screenshots', 'escape-home');

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: CDP_PORT, label: 'escape-home' });
  let client;
  try {
    client = await connectFirstPage(hub, t => t.type === 'page' && /index\.html/i.test(t.url || ''));
    await client.send('Page.enable');

    for (let i = 0; i < 80; i++) {
      const ready = await client.eval(`(() => document.readyState !== 'loading' && !!document.getElementById('hub-escape-home') && !!document.getElementById('preview-body'))()`);
      if (ready) break;
      await _waitMs(100);
      if (i === 79) throw new Error('Hub DOM did not become ready for escape-home E2E');
    }

    const before = await client.eval(`(() => {
      const app = document.getElementById('app-container');
      const terminal = document.getElementById('terminal-panel');
      const preview = document.getElementById('preview-panel');
      const previewBody = document.getElementById('preview-body');
      const meeting = document.getElementById('meeting-room-panel');
      const btn = document.getElementById('hub-escape-home');
      if (!app || !terminal || !preview || !previewBody || !meeting || !btn) {
        throw new Error('escape-home required DOM missing');
      }

      app.classList.add('sidebar-collapsed');
      terminal.style.display = 'none';
      meeting.style.display = 'flex';
      preview.style.display = 'flex';
      previewBody.innerHTML = '<div style="width:100%;height:100%;background:#000"></div>';

      const rect = btn.getBoundingClientRect();
      return {
        collapsed: app.classList.contains('sidebar-collapsed'),
        terminalDisplay: getComputedStyle(terminal).display,
        previewDisplay: getComputedStyle(preview).display,
        meetingDisplay: getComputedStyle(meeting).display,
        buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        buttonZIndex: getComputedStyle(btn).zIndex,
      };
    })()`);

    assert.strictEqual(before.collapsed, true, JSON.stringify(before));
    assert.strictEqual(before.terminalDisplay, 'none', JSON.stringify(before));
    assert.strictEqual(before.previewDisplay, 'flex', JSON.stringify(before));
    assert.ok(Number(before.buttonZIndex) > 10000, JSON.stringify(before));

    const x = before.buttonRect.x + before.buttonRect.width / 2;
    const y = before.buttonRect.y + before.buttonRect.height / 2;
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await _waitMs(400);

    const after = await client.eval(`(() => {
      const app = document.getElementById('app-container');
      const sidebar = document.getElementById('session-sidebar');
      const terminal = document.getElementById('terminal-panel');
      const empty = document.getElementById('empty-state');
      const preview = document.getElementById('preview-panel');
      const meeting = document.getElementById('meeting-room-panel');
      const overlay = document.getElementById('msg-overlay');
      const btn = document.getElementById('hub-escape-home');
      const btnRect = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(btnRect.x + btnRect.width / 2, btnRect.y + btnRect.height / 2);
      return {
        collapsed: app.classList.contains('sidebar-collapsed'),
        sidebarDisplay: getComputedStyle(sidebar).display,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        terminalDisplay: getComputedStyle(terminal).display,
        emptyConnected: empty && empty.isConnected,
        emptyDisplay: empty ? getComputedStyle(empty).display : null,
        previewDisplay: getComputedStyle(preview).display,
        meetingDisplay: getComputedStyle(meeting).display,
        overlayHidden: overlay.classList.contains('hidden'),
        activeSessionId: typeof activeSessionId === 'undefined' ? 'missing' : activeSessionId,
        activeMeetingId: typeof activeMeetingId === 'undefined' ? 'missing' : activeMeetingId,
        buttonHit: !!(hit && hit.closest && hit.closest('#hub-escape-home')),
      };
    })()`);

    const shot = path.join(SHOT_DIR, `${Date.now()}-escape-home.png`);
    const png = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));

    assert.strictEqual(after.collapsed, false, JSON.stringify(after, null, 2));
    assert.ok(after.sidebarWidth > 200, JSON.stringify(after, null, 2));
    assert.notStrictEqual(after.terminalDisplay, 'none', JSON.stringify(after, null, 2));
    assert.strictEqual(after.emptyConnected, true, JSON.stringify(after, null, 2));
    assert.notStrictEqual(after.emptyDisplay, 'none', JSON.stringify(after, null, 2));
    assert.strictEqual(after.previewDisplay, 'none', JSON.stringify(after, null, 2));
    assert.strictEqual(after.meetingDisplay, 'none', JSON.stringify(after, null, 2));
    assert.strictEqual(after.overlayHidden, true, JSON.stringify(after, null, 2));
    assert.strictEqual(after.activeSessionId, null, JSON.stringify(after, null, 2));
    assert.strictEqual(after.activeMeetingId, null, JSON.stringify(after, null, 2));
    assert.strictEqual(after.buttonHit, true, JSON.stringify(after, null, 2));

    console.log(JSON.stringify({ ok: true, dataDir: DATA_DIR, port: CDP_PORT, screenshot: shot, before, after }, null, 2));
  } finally {
    if (client) await client.close();
    await gracefulQuit(hub);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
