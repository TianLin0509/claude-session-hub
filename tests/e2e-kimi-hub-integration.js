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
const MENU_SHOT = path.join(ARTIFACT_DIR, 'kimi-hub-new-session.png');
const MODAL_SHOT = path.join(ARTIFACT_DIR, 'kimi-hub-room-create.png');
const ROOM_SHOT = path.join(ARTIFACT_DIR, 'kimi-hub-room-created.png');

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

async function waitFor(client, expression, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.eval(expression)) return;
    await _waitMs(200);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(client, targetPath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64'));
}

async function run() {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-kimi-e2e-${process.pid}-${Date.now()}`);
  const kimiHome = path.join(dataDir, 'kimi-home');
  const port = await getFreePort();
  let hub = null;
  let cdp = null;

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'kimi-hub-integration-e2e',
      extraEnv: { KIMI_CODE_HOME: kimiHome },
    });
    cdp = await connectFirstPage(
      hub,
      (target) => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url),
    );
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(cdp, `document.readyState === 'complete' && !!document.querySelector('[data-kind="kimi"]')`);

    const menuState = await cdp.eval(`(() => {
      document.getElementById('btn-new').click();
      const option = document.querySelector('.new-session-option[data-kind="kimi"]');
      const resume = document.querySelector('[data-resume-kind="kimi-resume"]');
      return {
        menuVisible: document.getElementById('new-session-menu').style.display === 'flex',
        optionText: option && option.textContent.trim(),
        resumeText: resume && resume.textContent.trim(),
      };
    })()`);
    assert.strictEqual(menuState.menuVisible, true);
    assert.ok(menuState.optionText.includes('Kimi Code · K3'));
    assert.ok(menuState.resumeText.includes('Kimi'));
    await screenshot(cdp, MENU_SHOT);

    await cdp.eval(`document.querySelector('.new-session-option[data-kind="kimi"]').click()`);
    await waitFor(cdp, `(async () => {
      const sessions = await require('electron').ipcRenderer.invoke('get-sessions');
      return sessions.some(s => s.kind === 'kimi' && s.currentModel && s.currentModel.id === 'kimi-code/k3');
    })()`);
    await waitFor(cdp, `(async () => {
      const sessions = await require('electron').ipcRenderer.invoke('get-sessions');
      return sessions.some(s => s.kind === 'kimi' && s.kimiSid && s.transcriptPath);
    })()`);

    await cdp.eval(`(() => {
      window.LaunchCenter.open('group');
      document.getElementById('launch-center-configure-group').click();
    })()`);
    await waitFor(cdp, `document.getElementById('meeting-create-modal') && document.getElementById('meeting-create-modal').style.display === 'flex'`);
    const modalState = await cdp.eval(`(() => {
      let slots = [...document.querySelectorAll('#meeting-create-modal .mcm-slot')];
      for (const slot of slots.slice(0, 2)) {
        const select = slot.querySelector('.mcm-ai-select');
        select.value = 'kimi';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('[data-remove-member="2"]').click();
      document.getElementById('mcm-title-input').value = 'Kimi K3 双成员验证';
      slots = [...document.querySelectorAll('#meeting-create-modal .mcm-slot')];
      return {
        count: slots.length,
        kinds: slots.map(slot => slot.querySelector('.mcm-ai-select').value),
        models: slots.map(slot => slot.querySelector('.mcm-model-select').value),
        avatars: slots.map(slot => slot.querySelector('.mcm-avatar').getAttribute('src')),
      };
    })()`);
    assert.strictEqual(modalState.count, 2);
    assert.deepStrictEqual(modalState.kinds, ['kimi', 'kimi']);
    assert.deepStrictEqual(modalState.models, ['kimi-code/k3', 'kimi-code/k3']);
    assert.ok(modalState.avatars.every((src) => src.endsWith('/kimi.svg') || src.endsWith('kimi.svg')));
    await screenshot(cdp, MODAL_SHOT);

    await cdp.eval(`document.querySelector('#meeting-create-modal .mcm-create').click()`);
    await waitFor(cdp, `document.getElementById('meeting-create-modal').style.display === 'none'`, 30000);
    await waitFor(cdp, `(async () => {
      const meetings = await require('electron').ipcRenderer.invoke('get-meetings');
      const meeting = meetings.find(m => m.title === 'Kimi K3 双成员验证');
      if (!meeting || meeting.subSessions.length !== 2) return false;
      const sessions = await require('electron').ipcRenderer.invoke('get-sessions');
      const members = sessions.filter(s => meeting.subSessions.includes(s.id));
      return members.length === 2 && members.every(s => s.kind === 'kimi' && s.kimiSid && s.transcriptPath);
    })()`, 30000);
    await waitFor(cdp, `(async () => {
      const ipc = require('electron').ipcRenderer;
      const meetings = await ipc.invoke('get-meetings');
      const meeting = meetings.find(m => m.title === 'Kimi K3 双成员验证');
      const sessions = await ipc.invoke('get-sessions');
      const members = sessions.filter(s => meeting.subSessions.includes(s.id));
      const buffers = await Promise.all(members.map(s => ipc.invoke('debug:get-session-buffer', s.id)));
      return buffers.length === 2 && buffers.every(buf => buf.length > 800);
    })()`, 20000);

    const result = await cdp.eval(`(async () => {
      const ipc = require('electron').ipcRenderer;
      const meetings = await ipc.invoke('get-meetings');
      const meeting = meetings.find(m => m.title === 'Kimi K3 双成员验证');
      const sessions = await ipc.invoke('get-sessions');
      const members = sessions.filter(s => meeting.subSessions.includes(s.id));
      const single = sessions.find(s => s.kind === 'kimi' && !s.meetingId);
      const buffers = await Promise.all(members.map(s => ipc.invoke('debug:get-session-buffer', s.id)));
      return {
        meetingId: meeting.id,
        subSessions: meeting.subSessions,
        memberKinds: members.map(s => s.kind),
        memberModels: members.map(s => s.currentModel && s.currentModel.id),
        memberNativeSids: members.map(s => s.kimiSid),
        memberTranscriptPaths: members.map(s => s.transcriptPath),
        singleNativeSid: single && single.kimiSid,
        bufferLengths: buffers.map(buf => buf.length),
        loginPromptsVisible: buffers.every(buf => buf.includes('/login') || buf.includes('not set')),
        roomVisible: document.getElementById('meeting-room-panel').style.display !== 'none',
        roomMentionsKimi: document.getElementById('meeting-room-panel').innerText.includes('Kimi'),
      };
    })()`);
    assert.deepStrictEqual(result.memberKinds, ['kimi', 'kimi']);
    assert.deepStrictEqual(result.memberModels, ['kimi-code/k3', 'kimi-code/k3']);
    assert.ok(result.memberNativeSids.every(Boolean));
    assert.ok(result.memberTranscriptPaths.every(Boolean));
    assert.ok(result.singleNativeSid);
    assert.strictEqual(result.loginPromptsVisible, true);
    assert.strictEqual(result.roomVisible, true);
    assert.strictEqual(result.roomMentionsKimi, true);
    await screenshot(cdp, ROOM_SHOT);

    console.log(JSON.stringify({
      ok: true,
      cdpPort: port,
      isolatedDataDir: dataDir,
      menuState,
      modalState,
      result,
      screenshots: [MENU_SHOT, MODAL_SHOT, ROOM_SHOT],
      hubLogTail: hub.log().slice(-20),
    }, null, 2));
  } finally {
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir());
    if (resolved.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase())) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
