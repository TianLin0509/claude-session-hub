'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-completion-notification-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'fake-home');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'completion-notifications');
const ON_SCREENSHOT = path.join(ARTIFACT_DIR, `top-toggle-on-${RUN_ID}.png`);
const OFF_SCREENSHOT = path.join(ARTIFACT_DIR, `top-toggle-off-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `top-toggle-result-${RUN_ID}.json`);
const CDP_PORT = Number(process.env.HUB_COMPLETION_NOTIFICATION_E2E_PORT || (9780 + (process.pid % 180)));
const SEND_KEY = 'SCT_E2E_PRIVATE_123456';

async function captureTopControls(client, filePath) {
  const clip = await client.eval(`(() => {
    const notification = document.getElementById('completion-notification-toggle').getBoundingClientRect();
    const view = document.querySelector('.view-toggle').getBoundingClientRect();
    const x = Math.max(0, notification.left - 12);
    return {
      x,
      y: Math.max(0, Math.min(notification.top, view.top) - 8),
      width: Math.ceil(view.right - x + 12),
      height: Math.ceil(Math.max(notification.bottom, view.bottom) - Math.max(0, Math.min(notification.top, view.top) - 8) + 8),
      scale: 2,
    };
  })()`);
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

async function startServerChanMock() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { pushid: 'e2e-local-mock' } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const mock = await startServerChanMock();
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, cdpPort: CDP_PORT };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'completion-notification-top-toggle',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
        HUB_NOTIFY_SERVERCHAN_API_BASE: mock.baseUrl,
      },
    });
    await _waitMs(1200);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    result.initial = await client.eval(`(async () => {
      const button = document.getElementById('completion-notification-toggle');
      const deadline = Date.now() + 3000;
      while (button.dataset.state !== 'unconfigured' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const view = document.querySelector('.view-toggle').getBoundingClientRect();
      const toggle = button.getBoundingClientRect();
      return {
        state: button.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        title: button.title,
        parentId: button.parentElement && button.parentElement.id,
        viewDisplay: getComputedStyle(document.querySelector('.view-toggle')).display,
        visible: toggle.width > 0 && toggle.height > 0,
      };
    })()`);
    assert.equal(result.initial.state, 'unconfigured');
    assert.equal(result.initial.label, '通知未配');
    assert.match(result.initial.title, /点击进入设置/);
    assert.equal(result.initial.parentId, 'home-notification-slot');
    assert.equal(result.initial.viewDisplay, 'none');
    assert.equal(result.initial.visible, true);

    result.setupGuidance = await client.eval(`(async () => {
      document.getElementById('completion-notification-toggle').click();
      const deadline = Date.now() + 3000;
      const modal = document.getElementById('config-modal');
      while (modal.classList.contains('hidden') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      return {
        modalVisible: !modal.classList.contains('hidden'),
        status: document.getElementById('config-notification-status').textContent,
        keyFocused: document.activeElement === document.getElementById('cfg-serverchan-sendkey'),
      };
    })()`);
    assert.equal(result.setupGuidance.modalVisible, true);
    assert.match(result.setupGuidance.status, /先填写 SendKey/);
    assert.equal(result.setupGuidance.keyFocused, true);

    result.configure = await client.eval(`(async () => {
      const key = document.getElementById('cfg-serverchan-sendkey');
      key.value = ${JSON.stringify(SEND_KEY)};
      document.getElementById('config-notification-test').click();
      const status = document.getElementById('config-notification-status');
      const testDeadline = Date.now() + 8000;
      while (!status.classList.contains('success') && !status.classList.contains('error') && Date.now() < testDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const testStatus = status.textContent;
      document.getElementById('cfg-notification-enabled').checked = true;
      document.getElementById('config-save').click();
      await new Promise(resolve => setTimeout(resolve, 300));
      const saveMessage = document.getElementById('config-save-msg').textContent;
      document.getElementById('config-close').click();
      const toggle = document.getElementById('completion-notification-toggle');
      const stateDeadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'enabled' && Date.now() < stateDeadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const saved = await ipcRenderer.invoke('get-hub-config-raw');
      return {
        testStatus,
        saveMessage,
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        enabled: saved.notificationEnabled,
        keyMatches: saved.serverchanSendKey === ${JSON.stringify(SEND_KEY)},
      };
    })()`);
    assert.match(result.configure.testStatus, /Server酱接收/);
    assert.match(result.configure.saveMessage, /每次回答完成都会推送/);
    assert.equal(result.configure.state, 'enabled');
    assert.equal(result.configure.label, '通知开');
    assert.equal(result.configure.enabled, true);
    assert.equal(result.configure.keyMatches, true);

    result.sessionPlacement = await client.eval(`(async () => {
      window.__hubE2E.addFakeSession({
        id: 'notification-layout-session',
        kind: 'claude',
        title: '通知布局验证',
        status: 'idle',
        lastMessageTime: Date.now(),
      });
      await new Promise(resolve => setTimeout(resolve, 80));
      document.querySelector('[data-session-id="notification-layout-session"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 160));
      const button = document.getElementById('completion-notification-toggle');
      const viewEl = document.querySelector('.view-toggle');
      const view = viewEl.getBoundingClientRect();
      const toggle = button.getBoundingClientRect();
      return {
        parentId: button.parentElement && button.parentElement.id,
        viewDisplay: getComputedStyle(viewEl).display,
        gapToViewToggle: Math.round(view.left - toggle.right),
        topDelta: Math.round(Math.abs(view.top - toggle.top)),
      };
    })()`);
    assert.equal(result.sessionPlacement.parentId, 'terminal-panel');
    assert.notEqual(result.sessionPlacement.viewDisplay, 'none');
    assert.ok(result.sessionPlacement.gapToViewToggle >= 6 && result.sessionPlacement.gapToViewToggle <= 14,
      `notification toggle should sit directly left of view toggle in a Session, gap=${result.sessionPlacement.gapToViewToggle}`);
    assert.ok(result.sessionPlacement.topDelta <= 2);
    await captureTopControls(client, ON_SCREENSHOT);

    result.off = await client.eval(`(async () => {
      document.getElementById('completion-notification-toggle').click();
      const toggle = document.getElementById('completion-notification-toggle');
      const deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'disabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const saved = await ipcRenderer.invoke('get-hub-config-raw');
      return {
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        ariaPressed: toggle.getAttribute('aria-pressed'),
        enabled: saved.notificationEnabled,
      };
    })()`);
    assert.deepStrictEqual(result.off, {
      state: 'disabled',
      label: '通知关',
      ariaPressed: 'false',
      enabled: false,
    });
    await captureTopControls(client, OFF_SCREENSHOT);

    result.onAgain = await client.eval(`(async () => {
      document.getElementById('completion-notification-toggle').click();
      const toggle = document.getElementById('completion-notification-toggle');
      const deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'enabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const saved = await ipcRenderer.invoke('get-hub-config-raw');
      return {
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        ariaPressed: toggle.getAttribute('aria-pressed'),
        enabled: saved.notificationEnabled,
      };
    })()`);
    assert.deepStrictEqual(result.onAgain, {
      state: 'enabled',
      label: '通知开',
      ariaPressed: 'true',
      enabled: true,
    });

    await client.eval('location.reload()');
    await _waitMs(1200);
    result.afterReload = await client.eval(`(async () => {
      const toggle = document.getElementById('completion-notification-toggle');
      const deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'enabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return {
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
      };
    })()`);
    assert.deepStrictEqual(result.afterReload, { state: 'enabled', label: '通知开' });

    assert.equal(mock.requests.length, 1, 'only the explicit test button should hit ServerChan');
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].url, `/${SEND_KEY}.send`);
    const posted = new URLSearchParams(mock.requests[0].body);
    assert.equal(posted.get('title'), 'AI Hub · 通知测试成功');

    const storedConfig = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    assert.equal(storedConfig.notifications.enabled, true);
    assert.equal(storedConfig.notifications.serverchan.send_key, SEND_KEY);
    for (const legacyField of ['mode', 'idle_seconds', 'min_duration_seconds']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(storedConfig.notifications, legacyField));
    }
    const audit = fs.readFileSync(path.join(DATA_DIR, 'notification-delivery.jsonl'), 'utf8');
    assert.ok(audit.includes('"status":"sent"'));
    assert.ok(!audit.includes(SEND_KEY), 'delivery audit must never contain SendKey');

    result.mockRequestCount = mock.requests.length;
    result.auditSecretFree = true;
    result.onScreenshot = ON_SCREENSHOT;
    result.offScreenshot = OFF_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    await new Promise(resolve => mock.server.close(resolve));
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
