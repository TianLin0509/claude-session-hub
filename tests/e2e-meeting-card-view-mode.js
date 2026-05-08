const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } = require('./helpers/hub-launcher');
const { connectCDP } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(HUB_ROOT, 'tests', 'screenshots', 'card-view-mode');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function capture(client, out) {
  await client.send('Page.enable');
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
}

(async () => {
  const stamp = Date.now();
  const dataDir = path.join(os.tmpdir(), `hub-card-view-mode-${stamp}`);
  const port = 9610 + Math.floor(Math.random() * 300);
  let hub;
  let client;
  try {
    hub = await launchIsolatedHub({ dataDir, port, label: 'card-view-mode' });
    const deadline = Date.now() + 15000;
    let page;
    while (Date.now() < deadline) {
      const targets = await listCdpTargets(hub);
      page = targets.find(t => t.type === 'page' && /index\.html/i.test(t.url || ''));
      if (page) break;
      await _waitMs(300);
    }
    assert.ok(page, 'hub page target ready');
    client = await connectCDP(page.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    const readyDeadline = Date.now() + 15000;
    while (Date.now() < readyDeadline) {
      const ready = await client.eval(`typeof MeetingRoom !== 'undefined' && !!document.getElementById('mr-header')`);
      if (ready) break;
      await _waitMs(250);
    }

    const result = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      localStorage.removeItem('mr-card-view-mode');
      localStorage.removeItem('mr-density-compact');
      const meeting = await ipcRenderer.invoke('create-meeting', {
        title: 'Card View Mode E2E',
        scene: 'general',
        slots: [
          { index: 0, kind: 'powershell' },
          { index: 1, kind: 'powershell' },
          { index: 2, kind: 'powershell' },
        ],
      });
      if (typeof MeetingRoom === 'undefined') throw new Error('MeetingRoom missing');
      MeetingRoom.openMeeting(meeting.id, meeting);
      await new Promise(r => setTimeout(r, 800));
      const parallel = {
        buttonText: [...document.querySelectorAll('.mr-view-btn')].map(b => b.textContent.trim()).join('/'),
        visibleCards: [...document.querySelectorAll('.mr-ft[data-ft-sid]')].filter(c => c.getBoundingClientRect().width > 0 && getComputedStyle(c).display !== 'none').length,
        hasDensity: !!document.getElementById('mr-btn-density'),
      };
      document.getElementById('mr-btn-view-tab').click();
      await new Promise(r => setTimeout(r, 1000));
      const panel = document.getElementById('mr-roundtable-panel');
      panel.insertAdjacentHTML('afterbegin', '<div class="mr-rt-timetravel-banner" data-e2e-tt>tt</div><div class="mr-rt-userq" data-e2e-userq>q</div>');
      const tabButtons = [...document.querySelectorAll('.mr-card-view-tab')];
      const before = {
        mode: localStorage.getItem('mr-card-view-mode'),
        visibleCards: [...document.querySelectorAll('.mr-ft[data-ft-sid]')].filter(c => c.getBoundingClientRect().width > 0 && getComputedStyle(c).display !== 'none').length,
        tabCount: tabButtons.length,
        activeTab: document.querySelector('.mr-card-view-tab.active')?.textContent.trim() || '',
        headHidden: getComputedStyle(document.querySelector('.mr-ft.active .mr-ft-head')).display === 'none',
        escapeHidden: getComputedStyle(document.querySelector('.mr-ft.active .mr-ft-escape-bar')).display === 'none',
        timeTravelHidden: getComputedStyle(document.querySelector('[data-e2e-tt]')).display === 'none',
        userQuestionHidden: getComputedStyle(document.querySelector('[data-e2e-userq]')).display === 'none',
      };
      document.querySelector('.mr-ft.active')?.click();
      await new Promise(r => setTimeout(r, 300));
      const clickInert = !document.body.classList.contains('mr-card-focus-on');
      tabButtons[1]?.click();
      await new Promise(r => setTimeout(r, 1000));
      const after = {
        visibleCards: [...document.querySelectorAll('.mr-ft[data-ft-sid]')].filter(c => c.getBoundingClientRect().width > 0 && getComputedStyle(c).display !== 'none').length,
        activeTab: document.querySelector('.mr-card-view-tab.active')?.textContent.trim() || '',
        focusedSub: MeetingRoom.getMeetingData(meeting.id).focusedSub,
        clickInert,
      };
      return { parallel, before, after, meetingId: meeting.id };
    })()`);

    assert.strictEqual(result.parallel.buttonText, '并列/Tab');
    assert.strictEqual(result.parallel.hasDensity, false);
    assert.strictEqual(result.parallel.visibleCards, 3);
    assert.strictEqual(result.before.mode, 'tab');
    assert.strictEqual(result.before.tabCount, 3);
    assert.strictEqual(result.before.visibleCards, 1);
    assert.strictEqual(result.before.headHidden, true);
    assert.strictEqual(result.before.escapeHidden, true);
    assert.strictEqual(result.before.timeTravelHidden, true);
    assert.strictEqual(result.before.userQuestionHidden, true);
    assert.strictEqual(result.after.visibleCards, 1);
    assert.strictEqual(result.after.clickInert, true);
    assert.ok(result.after.focusedSub, 'tab click updates focusedSub');

    const shot = path.join(OUT_DIR, `card-view-mode-tab-${stamp}.png`);
    await capture(client, shot);
    console.log(JSON.stringify({ ok: true, dataDir, port, screenshot: shot, result }, null, 2));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
  }
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
