'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const CONFIG_SCREENSHOT = path.join(ARTIFACT_DIR, `feishu-settings-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `top-toggle-result-${RUN_ID}.json`);
const CDP_PORT = Number(process.env.HUB_COMPLETION_NOTIFICATION_E2E_PORT || (9780 + (process.pid % 180)));
const FEISHU_TARGET = 'oc_1234567890';
const FAKE_CLI_PATH = path.join(TEMP_ROOT, 'fake-lark-cli.js');
const CLI_CALL_PATH = path.join(TEMP_ROOT, 'fake-lark-cli-calls.jsonl');

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

async function captureElement(client, selector, filePath) {
  const clip = await client.eval(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {
      x: Math.max(0, rect.left - 12),
      y: Math.max(0, rect.top - 12),
      width: Math.ceil(rect.width + 24),
      height: Math.ceil(rect.height + 24),
      scale: 1.5,
    };
  })()`);
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

function writeFakeFeishuCli() {
  fs.writeFileSync(FAKE_CLI_PATH, [
    "'use strict';",
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.HUB_FEISHU_FAKE_CALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');",
    "process.stdout.write(JSON.stringify({ok:true,identity:'bot',data:{message_id:'om_e2e_mock',chat_id:'oc_1234567890'}}) + '\\n');",
  ].join('\n'), 'utf8');
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  writeFakeFeishuCli();
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
        HUB_NOTIFY_FEISHU_CLI_PATH: FAKE_CLI_PATH,
        HUB_NOTIFY_FEISHU_NODE_PATH: process.execPath,
        HUB_FEISHU_FAKE_CALL_LOG: CLI_CALL_PATH,
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
        keyFocused: document.activeElement === document.getElementById('cfg-feishu-target'),
      };
    })()`);
    assert.equal(result.setupGuidance.modalVisible, true);
    assert.match(result.setupGuidance.status, /先填写飞书接收对象/);
    assert.equal(result.setupGuidance.keyFocused, true);
    await captureElement(client, '#config-notification-card', CONFIG_SCREENSHOT);

    result.configure = await client.eval(`(async () => {
      const key = document.getElementById('cfg-feishu-target');
      key.value = ${JSON.stringify(FEISHU_TARGET)};
      document.getElementById('config-notification-test').click();
      const status = document.getElementById('config-notification-status');
      const testDeadline = Date.now() + 8000;
      while (!status.classList.contains('success') && !status.classList.contains('error') && Date.now() < testDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const testStatus = status.textContent;
      document.getElementById('config-save').click();
      await new Promise(resolve => setTimeout(resolve, 300));
      const saveMessage = document.getElementById('config-save-msg').textContent;
      document.getElementById('config-close').click();
      const toggle = document.getElementById('completion-notification-toggle');
      const stateDeadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'unavailable' && Date.now() < stateDeadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const saved = await ipcRenderer.invoke('get-hub-config-raw');
      return {
        testStatus,
        saveMessage,
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        legacyEnabled: saved.notificationEnabled,
        keyMatches: saved.feishuTarget === ${JSON.stringify(FEISHU_TARGET)},
        checkboxDisabled: document.getElementById('cfg-notification-enabled').disabled,
      };
    })()`);
    assert.match(result.configure.testStatus, /已发送，请查看飞书/);
    assert.match(result.configure.saveMessage, /打开需要关注的会话/);
    assert.equal(result.configure.state, 'unavailable');
    assert.equal(result.configure.label, '会话通知');
    assert.equal(result.configure.legacyEnabled, false);
    assert.equal(result.configure.keyMatches, true);
    assert.equal(result.configure.checkboxDisabled, true);

    result.sessionPlacement = await client.eval(`(async () => {
      await ipcRenderer.invoke('create-session', {
        kind: 'powershell',
        opts: {
          id: 'notification-layout-session',
          title: '通知布局验证',
        },
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      const button = document.getElementById('completion-notification-toggle');
      const stateDeadline = Date.now() + 3000;
      while (button.dataset.state !== 'disabled' && Date.now() < stateDeadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const viewEl = document.querySelector('.view-toggle');
      const view = viewEl.getBoundingClientRect();
      const toggle = button.getBoundingClientRect();
      return {
        parentId: button.parentElement && button.parentElement.id,
        viewDisplay: getComputedStyle(viewEl).display,
        gapToViewToggle: Math.round(view.left - toggle.right),
        topDelta: Math.round(Math.abs(view.top - toggle.top)),
        state: button.dataset.state,
        enabled: (await ipcRenderer.invoke('get-sessions'))
          .find(session => session.id === 'notification-layout-session')?.completionNotificationEnabled,
      };
    })()`);
    assert.equal(result.sessionPlacement.parentId, 'terminal-panel');
    assert.notEqual(result.sessionPlacement.viewDisplay, 'none');
    assert.ok(result.sessionPlacement.gapToViewToggle >= 6 && result.sessionPlacement.gapToViewToggle <= 14,
      `notification toggle should sit directly left of view toggle in a Session, gap=${result.sessionPlacement.gapToViewToggle}`);
    assert.ok(result.sessionPlacement.topDelta <= 2);
    assert.equal(result.sessionPlacement.state, 'disabled');
    assert.equal(result.sessionPlacement.enabled, false, 'a newly-created session must default to notifications off');
    await captureTopControls(client, OFF_SCREENSHOT);

    result.on = await client.eval(`(async () => {
      document.getElementById('completion-notification-toggle').click();
      const toggle = document.getElementById('completion-notification-toggle');
      const deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'enabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const saved = (await ipcRenderer.invoke('get-sessions'))
        .find(session => session.id === 'notification-layout-session');
      return {
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        ariaPressed: toggle.getAttribute('aria-pressed'),
        enabled: saved && saved.completionNotificationEnabled,
      };
    })()`);
    assert.deepStrictEqual(result.on, {
      state: 'enabled',
      label: '通知开',
      ariaPressed: 'true',
      enabled: true,
    });
    await captureTopControls(client, ON_SCREENSHOT);

    result.independent = await client.eval(`(async () => {
      await ipcRenderer.invoke('create-session', {
        kind: 'powershell',
        opts: { id: 'notification-layout-session-2', title: '第二个会话' },
      });
      const toggle = document.getElementById('completion-notification-toggle');
      let deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'disabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const secondState = toggle.dataset.state;
      const sessions = await ipcRenderer.invoke('get-sessions');
      const firstEnabled = sessions.find(session => session.id === 'notification-layout-session')?.completionNotificationEnabled;
      const secondEnabled = sessions.find(session => session.id === 'notification-layout-session-2')?.completionNotificationEnabled;
      document.querySelector('[data-session-id="notification-layout-session"]')?.click();
      deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'enabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return { secondState, firstEnabled, secondEnabled, firstStateAfterReturn: toggle.dataset.state };
    })()`);
    assert.deepStrictEqual(result.independent, {
      secondState: 'disabled',
      firstEnabled: true,
      secondEnabled: false,
      firstStateAfterReturn: 'enabled',
    });

    result.off = await client.eval(`(async () => {
      document.getElementById('completion-notification-toggle').click();
      const toggle = document.getElementById('completion-notification-toggle');
      const deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'disabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const saved = (await ipcRenderer.invoke('get-sessions'))
        .find(session => session.id === 'notification-layout-session');
      return {
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
        ariaPressed: toggle.getAttribute('aria-pressed'),
        enabled: saved && saved.completionNotificationEnabled,
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
      await new Promise(resolve => setTimeout(resolve, 650));
      return { state: toggle.dataset.state };
    })()`);
    assert.deepStrictEqual(result.onAgain, { state: 'enabled' });

    await client.eval('location.reload()');
    await _waitMs(1200);
    result.afterReload = await client.eval(`(async () => {
      const toggle = document.getElementById('completion-notification-toggle');
      const listDeadline = Date.now() + 3000;
      while (!document.querySelector('[data-session-id="notification-layout-session"]') && Date.now() < listDeadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const homeState = toggle.dataset.state;
      document.querySelector('[data-session-id="notification-layout-session"]')?.click();
      const deadline = Date.now() + 3000;
      while (toggle.dataset.state !== 'enabled' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return {
        homeState,
        state: toggle.dataset.state,
        label: document.getElementById('completion-notification-toggle-label').textContent,
      };
    })()`);
    assert.deepStrictEqual(result.afterReload, {
      homeState: 'unavailable',
      state: 'enabled',
      label: '通知开',
    });

    const cliCalls = fs.readFileSync(CLI_CALL_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(cliCalls.length, 1, 'only the explicit test button should invoke Feishu CLI');
    assert.deepEqual(cliCalls[0].slice(0, 4), ['im', '+messages-send', '--chat-id', FEISHU_TARGET]);
    assert.ok(cliCalls[0].includes('--idempotency-key'));
    assert.ok(cliCalls[0].includes('bot'));

    const storedConfig = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    assert.equal(storedConfig.notifications.enabled, false,
      'legacy global switch must stay off; per-session state is stored on the session');
    assert.equal(storedConfig.notifications.provider, 'feishu-cli');
    assert.equal(storedConfig.notifications.feishu.target, FEISHU_TARGET);
    assert.ok(!Object.prototype.hasOwnProperty.call(storedConfig.notifications, 'serverchan'));
    for (const legacyField of ['mode', 'idle_seconds', 'min_duration_seconds']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(storedConfig.notifications, legacyField));
    }
    const audit = fs.readFileSync(path.join(DATA_DIR, 'notification-delivery.jsonl'), 'utf8');
    assert.ok(audit.includes('"status":"sent"'));
    assert.ok(!audit.includes(FEISHU_TARGET), 'delivery audit must not contain the Feishu recipient');

    result.mockRequestCount = cliCalls.length;
    result.auditSecretFree = true;
    result.onScreenshot = ON_SCREENSHOT;
    result.offScreenshot = OFF_SCREENSHOT;
    result.configScreenshot = CONFIG_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
