'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(
  HUB_ROOT,
  'output',
  'playwright',
  'claude-warning-fix',
  'claude-fable-clean-startup.png',
);

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

function seedConfig(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    proxy: { http: 'http://127.0.0.1:7890' },
    providers: {
      claude: {
        backend: 'api',
        api_key: 'sk-e2e-warning-cleanup-placeholder',
        base_url: 'http://127.0.0.1:9',
        model: 'claude-fable-5',
      },
      codex: { backend: 'subscription' },
      deepseek: {},
    },
  }, null, 2), 'utf8');
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

async function readRingBuffer(cdp, sessionId) {
  return cdp.eval(`require('electron').ipcRenderer.invoke('get-ring-buffer', ${JSON.stringify(sessionId)})`);
}

async function waitForPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return;
    await _waitMs(200);
  }
  throw new Error(`Timed out waiting for page expression: ${expression}`);
}

async function waitForCleanStartup(cdp, sessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await readRingBuffer(cdp, sessionId);
    const plain = stripAnsi(last);
    const compact = plain.replace(/\s+/g, '');
    if (compact.includes('ClaudeCode') && compact.includes('Fable5')) return plain;
    await _waitMs(250);
  }
  const sessions = await cdp.eval(`require('electron').ipcRenderer.invoke('get-sessions')`);
  const lastWrite = await cdp.eval(`require('electron').ipcRenderer.invoke('debug:get-last-session-write')`);
  throw new Error(`Timed out waiting for Claude startup. sessions=${JSON.stringify(sessions)} lastWrite=${JSON.stringify(lastWrite)} tail=${stripAnsi(last).slice(-1200)}`);
}

async function run() {
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-warning-e2e-${process.pid}-${Date.now()}`);
  const port = await getFreePort();
  let hub = null;
  let cdp = null;
  let sessionId = null;
  seedConfig(dataDir);

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'claude-fable-warning-cleanup-e2e',
    });
    cdp = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url),
    );
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForPage(cdp, `document.readyState === 'complete' && !!document.querySelector('.new-session-option[data-kind="claude"]')`);
    await _waitMs(500);
    const clicked = await cdp.eval(`(() => {
      const option = document.querySelector('.new-session-option[data-kind="claude"]');
      if (!option) return false;
      option.click();
      return true;
    })()`);
    assert.strictEqual(clicked, true, 'real Claude new-session menu item should be clickable');
    await waitForPage(cdp, `(async () => (await require('electron').ipcRenderer.invoke('get-sessions')).length === 1)()`);
    const sessions = await cdp.eval(`require('electron').ipcRenderer.invoke('get-sessions')`);
    const session = sessions[0];
    assert.ok(session && session.id, 'real UI click should create a Claude session');
    sessionId = session.id;

    const startup = await waitForCleanStartup(cdp, sessionId);
    await _waitMs(1500);
    const settled = stripAnsi(await readRingBuffer(cdp, sessionId));
    const settledCompact = settled.replace(/\s+/g, '');

    for (const warning of [
      'Permission allow rule',
      'is not matched by file permission checks',
      'claude.ai connectors are disabled',
      'API-key auth precedence active',
    ]) {
      assert.ok(!settled.includes(warning), `startup must not contain warning: ${warning}`);
    }
    assert.ok(settledCompact.includes('ClaudeCode'), 'Claude TUI should be running');
    assert.ok(settledCompact.includes('Fable5'), 'Fable model banner should be visible');
    assert.ok(settledCompact.includes('APIUsageBilling'), 'API backend banner should be visible');

    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));

    console.log(JSON.stringify({
      ok: true,
      cdpPort: port,
      isolatedDataDir: dataDir,
      sessionId,
      startupMarkers: {
        claudeCode: startup.replace(/\s+/g, '').includes('ClaudeCode'),
        fable5: startup.replace(/\s+/g, '').includes('Fable5'),
        apiUsageBilling: settledCompact.includes('APIUsageBilling'),
      },
      warnings: {
        invalidPermissionRule: false,
        claudeAiConnectorsDisabled: false,
      },
      screenshot: SCREENSHOT_PATH,
      hubLogTail: hub.log().slice(-10),
    }, null, 2));
  } finally {
    if (cdp && sessionId) {
      try {
        await cdp.eval(`require('electron').ipcRenderer.invoke('close-session', ${JSON.stringify(sessionId)})`);
      } catch {}
    }
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
