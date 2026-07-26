'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'claude-backend-switch');
const SUBSCRIPTION_SHOT = path.join(ARTIFACT_DIR, 'claude-backend-subscription.png');
const FABLE_SHOT = path.join(ARTIFACT_DIR, 'claude-backend-fable.png');
const TEST_KEY = 'sk-e2e-fable-placeholder';
const FABLE_URL = 'http://3.142.133.116:8080';
const FABLE_MODEL = 'claude-fable-5';

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

async function waitFor(client, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.eval(expression)) return;
    await _waitMs(200);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

function seedConfig(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    proxy: { http: 'http://127.0.0.1:7890' },
    providers: {
      claude: {
        backend: 'subscription',
        api_key: TEST_KEY,
        base_url: FABLE_URL,
        model: FABLE_MODEL,
      },
      codex: {
        backend: 'subscription',
        subscription_profile: 'default',
        subscription_profiles: [{ id: 'default', label: 'E2E account', home: '' }],
      },
      deepseek: {},
      gpt: { api_key: 'keep-unrelated-provider-data' },
    },
  }, null, 2), 'utf8');
}

async function readUiState(cdp) {
  return cdp.eval(`(() => {
    const byId = id => document.getElementById(id);
    return {
      modalVisible: !byId('config-modal').classList.contains('hidden'),
      detailTitle: byId('cfg-detail-title').textContent,
      backend: byId('cfg-claude-backend').value,
      keySet: Boolean(byId('cfg-claude-key').value),
      keyDisabled: byId('cfg-claude-key').disabled,
      url: byId('cfg-claude-url').value,
      urlDisabled: byId('cfg-claude-url').disabled,
      model: byId('cfg-claude-model').value,
      modelDisabled: byId('cfg-claude-model').disabled,
      summary: byId('cfg-summary-claude').textContent,
      listStatus: byId('cfg-status-claude').textContent,
      detailStatus: byId('cfg-detail-status').textContent,
      note: byId('cfg-claude-route-note').textContent,
      noteClass: byId('cfg-claude-route-note').className,
      subscriptionSelected: byId('cfg-claude-subscription-card').classList.contains('selected'),
      apiSelected: byId('cfg-claude-api-card').classList.contains('selected'),
      optionLabels: [...byId('cfg-claude-backend').options].map(option => option.textContent),
    };
  })()`);
}

async function captureModal(cdp, targetPath) {
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.eval(`(() => {
    window.scrollTo(0, 0);
    const modal = document.querySelector('#config-modal .config-modal-content');
    if (modal) modal.scrollTop = 0;
  })()`);
  await _waitMs(250);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(shot.data, 'base64'));
}

async function run() {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-backend-e2e-${process.pid}-${Date.now()}`);
  const configPath = path.join(dataDir, 'config.json');
  const port = await getFreePort();
  let hub = null;
  let cdp = null;
  seedConfig(dataDir);

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'claude-backend-switch-e2e',
    });
    cdp = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url),
    );
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(cdp, `document.readyState === 'complete' && !!document.getElementById('btn-options')`);

    const opened = await cdp.eval(`(async () => {
      document.getElementById('btn-options').click();
      document.getElementById('options-settings').click();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (!document.getElementById('config-modal').classList.contains('hidden')) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    assert.strictEqual(opened, true, 'settings modal should open through the real options menu');

    const claudeOpened = await cdp.eval(`(() => {
      const row = document.querySelector('.config-ai-row[data-ai="claude"]');
      if (!row) return false;
      row.click();
      return !document.getElementById('config-detail-view').classList.contains('hidden');
    })()`);
    assert.strictEqual(claudeOpened, true, 'Claude detail should open through the real settings row');

    const subscription = await readUiState(cdp);
    assert.strictEqual(subscription.backend, 'subscription');
    assert.strictEqual(subscription.detailTitle, 'Claude 设置');
    assert.strictEqual(subscription.keySet, true, 'stored switch-ready key should be loaded');
    assert.strictEqual(subscription.keyDisabled, true);
    assert.strictEqual(subscription.urlDisabled, true);
    assert.strictEqual(subscription.modelDisabled, true);
    assert.strictEqual(subscription.url, FABLE_URL);
    assert.strictEqual(subscription.model, FABLE_MODEL);
    assert.strictEqual(subscription.summary, '订阅模式 · claude-opus-5[1m]');
    assert.strictEqual(subscription.listStatus, '订阅');
    assert.strictEqual(subscription.detailStatus, '订阅');
    assert.strictEqual(subscription.subscriptionSelected, true);
    assert.strictEqual(subscription.apiSelected, false);
    assert.ok(subscription.note.includes('不会读取或发送中转 Key'));
    assert.deepStrictEqual(subscription.optionLabels, [
      '当前订阅 / Claude Code 登录（默认）',
      '同事中转 / Fable 5 · 1M',
    ]);
    await captureModal(cdp, SUBSCRIPTION_SHOT);

    await cdp.eval(`(() => {
      const select = document.getElementById('cfg-claude-backend');
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const fable = await readUiState(cdp);
    assert.strictEqual(fable.backend, 'api');
    assert.strictEqual(fable.keyDisabled, false);
    assert.strictEqual(fable.urlDisabled, false);
    assert.strictEqual(fable.modelDisabled, false);
    assert.strictEqual(fable.summary, '同事中转 · Fable 5 · 1M');
    assert.strictEqual(fable.listStatus, '中转');
    assert.strictEqual(fable.detailStatus, '中转');
    assert.strictEqual(fable.subscriptionSelected, false);
    assert.strictEqual(fable.apiSelected, true);
    assert.ok(fable.note.includes('HTTP 明文连接'));
    assert.ok(fable.noteClass.includes('warning'));
    await captureModal(cdp, FABLE_SHOT);

    await cdp.eval(`document.getElementById('config-save').click()`);
    await waitFor(cdp, `document.getElementById('config-save-msg').classList.contains('success')`);
    const savedApi = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(savedApi.providers.claude.backend, 'api');
    assert.strictEqual(savedApi.providers.claude.api_key, TEST_KEY);
    assert.strictEqual(savedApi.providers.claude.base_url, FABLE_URL);
    assert.strictEqual(savedApi.providers.claude.model, FABLE_MODEL);
    assert.strictEqual(savedApi.providers.gpt.api_key, 'keep-unrelated-provider-data');

    await cdp.eval(`(() => {
      const select = document.getElementById('cfg-claude-backend');
      select.value = 'subscription';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('config-save').click();
    })()`);
    await waitFor(cdp, `document.getElementById('cfg-claude-key').disabled === true`);
    await _waitMs(300);
    const savedSubscription = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(savedSubscription.providers.claude.backend, 'subscription');
    assert.strictEqual(savedSubscription.providers.claude.api_key, TEST_KEY,
      'switching back to subscription must preserve the ready-to-switch key');
    assert.strictEqual(savedSubscription.providers.claude.base_url, FABLE_URL);
    assert.strictEqual(savedSubscription.providers.claude.model, FABLE_MODEL);
    assert.strictEqual(savedSubscription.providers.gpt.api_key, 'keep-unrelated-provider-data');

    console.log(JSON.stringify({
      ok: true,
      cdpPort: port,
      isolatedDataDir: dataDir,
      defaultBackend: subscription.backend,
      fableBackend: fable.backend,
      restoredBackend: savedSubscription.providers.claude.backend,
      fableUrl: savedSubscription.providers.claude.base_url,
      fableModel: savedSubscription.providers.claude.model,
      keyStored: Boolean(savedSubscription.providers.claude.api_key),
      subscriptionScreenshot: SUBSCRIPTION_SHOT,
      fableScreenshot: FABLE_SHOT,
      hubLogTail: hub.log().slice(-12),
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

run().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
