'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, 'groupchat-live-membership-and-pending-message.png');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return;
    await _waitMs(150);
  }
  throw new Error('Timed out waiting for: ' + expression);
}

async function addPowerShellMember(cdp, meetingId, triggerExpression, expectedCount) {
  await cdp.eval(triggerExpression);
  await waitFor(cdp, "!!document.getElementById('mr-add-sub-menu')");
  const clicked = await cdp.eval("(() => { const item = [...document.querySelectorAll('#mr-add-sub-menu .mr-quote-menu-item')].find(el => el.textContent.trim() === 'PowerShell'); if (!item) return false; item.click(); return true; })()");
  assert.strictEqual(clicked, true, 'PowerShell add-member menu item should be available');
  await waitFor(cdp, "window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + ").subSessions.length === " + expectedCount, 30000);
  await waitFor(cdp, "document.querySelectorAll('.mr-gc-member-row').length === " + expectedCount, 10000);
  const participants = await cdp.eval("window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + ").participants.slice()");
  assert.deepStrictEqual(
    participants,
    Array.from({ length: expectedCount }, (_value, index) => index),
    'participants must stay valid after each incremental add'
  );
}

async function run() {
  const dataDir = path.join(os.tmpdir(), 'hub-live-membership-' + process.pid + '-' + Date.now());
  const port = await getFreePort();
  let hub = null;
  let cdp = null;

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'groupchat-live-membership-e2e',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    cdp = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url),
    );
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom");

    const meeting = await cdp.eval("(async () => { const ipc = require('electron').ipcRenderer; return await ipc.invoke('create-meeting', { title: '动态成员 E2E', scene: 'general' }); })()");
    assert.ok(meeting && meeting.id, 'real create-meeting IPC should return a meeting');
    const meetingId = meeting.id;

    await cdp.eval("(async () => { localStorage.setItem('mr-group-chat-view-mode', 'chat'); localStorage.removeItem('mr-group-chat-side-state'); const ipc = require('electron').ipcRenderer; const all = await ipc.invoke('get-meetings'); const meeting = all.find(item => item.id === " + JSON.stringify(meetingId) + "); window.MeetingRoom.openMeeting(meeting.id, meeting); return true; })()");
    await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')");

    const defaultCollapsed = await cdp.eval("document.querySelector('.mr-gc-shell').classList.contains('side-collapsed')");
    assert.strictEqual(defaultCollapsed, true, 'member sidebar should default to collapsed');
    await cdp.eval("document.querySelector('[data-gc-side-toggle]').click()");
    await waitFor(cdp, "!document.querySelector('.mr-gc-shell').classList.contains('side-collapsed')");

    await addPowerShellMember(cdp, meetingId, "document.getElementById('mr-btn-add-sub').click()", 1);
    await addPowerShellMember(cdp, meetingId, "document.querySelector('[data-gc-add-member]').click()", 2);
    await addPowerShellMember(cdp, meetingId, "document.querySelector('[data-gc-add-member]').click()", 3);

    const afterAdd = await cdp.eval("(() => { const meeting = window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + "); return { subSessions: meeting.subSessions.slice(), participants: meeting.participants.slice(), rows: document.querySelectorAll('.mr-gc-member-row').length }; })()");
    assert.strictEqual(afterAdd.rows, 3);
    assert.deepStrictEqual(afterAdd.participants, [0, 1, 2], 'new member should be selected for the next turn');

    await cdp.eval("window.confirm = () => true; document.querySelectorAll('[data-gc-member-remove-sid]')[1].click()");
    await waitFor(cdp, "window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + ").subSessions.length === 2", 30000);
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-member-row').length === 2", 10000);
    const afterRemove = await cdp.eval("(() => { const meeting = window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + "); return { subSessions: meeting.subSessions.slice(), participants: meeting.participants.slice(), rows: document.querySelectorAll('.mr-gc-member-row').length }; })()");
    assert.strictEqual(afterRemove.rows, 2);
    assert.deepStrictEqual(afterRemove.participants, [0, 1], 'participant indexes should be reindexed after removal');

    const secondMeeting = await cdp.eval("(async () => { const ipc = require('electron').ipcRenderer; return await ipc.invoke('create-meeting', { title: '隔离群聊 B', scene: 'general' }); })()");
    assert.ok(secondMeeting && secondMeeting.id);
    const secondMeetingId = secondMeeting.id;
    await cdp.eval("window.MeetingRoom.openMeeting(" + JSON.stringify(secondMeetingId) + ", " + JSON.stringify(secondMeeting) + ")");
    await waitFor(cdp, "window.MeetingRoom.getActiveMeetingId() === " + JSON.stringify(secondMeetingId));
    await addPowerShellMember(cdp, secondMeetingId, "document.getElementById('mr-btn-add-sub').click()", 1);
    await addPowerShellMember(cdp, secondMeetingId, "document.querySelector('[data-gc-add-member]').click()", 2);
    await cdp.eval("document.querySelectorAll('.mr-gc-member')[0].click()");
    await waitFor(cdp, "window.MeetingRoom.getMeetingData(" + JSON.stringify(secondMeetingId) + ").participants.join(',') === '1'");

    const isolation = await cdp.eval("(() => ({ a: window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + ").participants.slice(), b: window.MeetingRoom.getMeetingData(" + JSON.stringify(secondMeetingId) + ").participants.slice(), bCacheValid: !!window.MeetingRoom.getMeetingData(" + JSON.stringify(secondMeetingId) + ").id }))()");
    assert.deepStrictEqual(isolation.a, [0, 1], 'changing B must not change A');
    assert.deepStrictEqual(isolation.b, [1], 'B should keep its own selection');
    assert.strictEqual(isolation.bCacheValid, true, 'participant ack must not overwrite the meeting cache');

    await cdp.eval("window.MeetingRoom.openMeeting(" + JSON.stringify(meetingId) + ", window.MeetingRoom.getMeetingData(" + JSON.stringify(meetingId) + "))");
    await waitFor(cdp, "window.MeetingRoom.getActiveMeetingId() === " + JSON.stringify(meetingId) + " && document.querySelectorAll('.mr-gc-member-row').length === 2");

    // Keep the renderer's groupchat:turn boundary unresolved so the screenshot and
    // assertions deterministically observe the real UI while dispatch is in flight.
    // Membership/create/remove/participant writes above continue to use real IPCs.
    const interceptInstalled = await cdp.eval("(() => { const ipc = require('electron').ipcRenderer; if (window.__liveMembershipOriginalInvoke) return false; window.__liveMembershipOriginalInvoke = ipc.invoke.bind(ipc); ipc.invoke = function(channel, ...args) { if (channel !== 'groupchat:turn') return window.__liveMembershipOriginalInvoke(channel, ...args); window.__liveMembershipTurnInFlight = true; return new Promise(resolve => { window.__liveMembershipReleaseTurn = () => { window.__liveMembershipTurnInFlight = false; resolve({ status: 'no_sent', turnNum: null }); }; }); }; return true; })()");
    assert.strictEqual(interceptInstalled, true, 'deterministic in-flight turn boundary should install');

    const question = '这条问题必须在 AI 思考时立即可见';
    const immediate = await cdp.eval("(() => { const box = document.getElementById('mr-input-box'); box.textContent = " + JSON.stringify(question) + "; box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('mr-send-btn').click(); return { inputCleared: !document.getElementById('mr-input-box').innerText.trim(), questionVisible: [...document.querySelectorAll('.mr-gc-msg.mine')].some(el => el.textContent.includes(" + JSON.stringify(question) + ")) }; })()");
    assert.strictEqual(immediate.inputCleared, true, 'send click should clear the composer synchronously');
    assert.strictEqual(immediate.questionVisible, true, 'user bubble must exist before the send click evaluate returns');

    await waitFor(cdp, "window.__liveMembershipTurnInFlight === true && document.querySelectorAll('.mr-gc-msg.pending').length > 0", 5000);
    const during = await cdp.eval("(() => ({ inputCleared: !document.getElementById('mr-input-box').innerText.trim(), questionVisible: [...document.querySelectorAll('.mr-gc-msg.mine')].some(el => el.textContent.includes(" + JSON.stringify(question) + ")), pendingAi: document.querySelectorAll('.mr-gc-msg.pending').length, dispatchInFlight: window.__liveMembershipTurnInFlight === true }))()");
    assert.strictEqual(during.inputCleared, true);
    assert.strictEqual(during.questionVisible, true);
    assert.ok(during.pendingAi > 0, 'question must remain visible while at least one AI is shown as thinking');
    assert.strictEqual(during.dispatchInFlight, true);

    await cdp.send('Page.bringToFront');
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));

    const nextDraft = '这是发送失败前已经输入的下一问草稿';
    await cdp.eval("(() => { const box = document.getElementById('mr-input-box'); box.textContent = " + JSON.stringify(nextDraft) + "; box.dispatchEvent(new Event('input', { bubbles: true })); const ipc = require('electron').ipcRenderer; if (window.__liveMembershipReleaseTurn) window.__liveMembershipReleaseTurn(); if (window.__liveMembershipOriginalInvoke) ipc.invoke = window.__liveMembershipOriginalInvoke; return true; })()");
    await waitFor(cdp, "document.getElementById('mr-input-box').innerText.includes(" + JSON.stringify(question) + ") && document.getElementById('mr-input-box').innerText.includes(" + JSON.stringify(nextDraft) + ")", 5000);
    const failureRecovery = await cdp.eval("(() => { const text = document.getElementById('mr-input-box').innerText; return { failedQuestionPreserved: text.includes(" + JSON.stringify(question) + "), nextDraftPreserved: text.includes(" + JSON.stringify(nextDraft) + ") }; })()");
    assert.deepStrictEqual(failureRecovery, { failedQuestionPreserved: true, nextDraftPreserved: true });

    console.log(JSON.stringify({
      ok: true,
      meetingId,
      port,
      afterAdd,
      afterRemove,
      isolation,
      during,
      failureRecovery,
      screenshot: SCREENSHOT_PATH,
      screenshotBytes: fs.statSync(SCREENSHOT_PATH).size,
    }, null, 2));
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
