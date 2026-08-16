'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const BRANDED_HUB_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'AIGroupChatHub.exe');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-groupchat-create-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'groupchat-create');
const MODAL_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `groupchat-modal-${RUN_ID}.png`);
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `groupchat-create-${RUN_ID}.png`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function pointFor(client, selector) {
  return client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false, selector: ${JSON.stringify(selector)} };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      found: true, selector: ${JSON.stringify(selector)}, x, y,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
      hit: hit && (hit.tagName + '.' + hit.className),
    };
  })()`);
}

async function clickPoint(client, point) {
  assert.equal(point.found, true, `${point.selector} should exist`);
  assert.equal(point.visible, true, `${point.selector} should be visible`);
  assert.equal(point.topmost, true, `${point.selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fake = path.join(FAKE_BIN, 'fake-cli.js');
  fs.writeFileSync(fake, `'use strict';
const fs = require('node:fs');
const provider = process.argv[2];
fs.appendFileSync(process.env.HUB_GROUPCHAT_E2E_LOG, JSON.stringify({ provider, cwd: process.cwd(), args: process.argv.slice(3) }) + '\\n');
process.stdout.write('FAKE_CLI_READY ' + provider + '\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`, 'utf8');
  }
  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), 'approval_policy = "never"\n', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: {
        backend: 'subscription',
        subscription_profile: 'e2e',
        subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }],
      },
    },
  }, null, 2), 'utf8');
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'groupchat-create-click',
      executablePath: BRANDED_HUB_EXE,
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        CODEX_HOME,
        HUB_CODEX_PROFILE: 'e2e',
        HUB_GROUPCHAT_E2E_LOG: INVOCATION_LOG,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Runtime.enable');
    await waitFor('standalone group-chat launcher', () => client.eval(
      `!!(document.querySelector('#btn-group-chat') && window.WorkspaceController && window.openMeetingCreateModal)`
    ));
    assert.equal(await client.eval(`require('node:path').basename(process.execPath)`), 'AIGroupChatHub.exe');
    await client.eval(`(() => {
      window.__groupCreateErrors = [];
      window.addEventListener('error', event => window.__groupCreateErrors.push(String(event.error || event.message || 'renderer error')));
      window.addEventListener('unhandledrejection', event => window.__groupCreateErrors.push(String(event.reason || 'unhandled rejection')));
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__groupCreateInvokes = [];
      ipcRenderer.invoke = async (...args) => {
        const startedAt = Date.now();
        try {
          const value = await originalInvoke(...args);
          window.__groupCreateInvokes.push({ channel: args[0], ok: true, elapsedMs: Date.now() - startedAt });
          return value;
        } catch (error) {
          window.__groupCreateInvokes.push({ channel: args[0], ok: false, elapsedMs: Date.now() - startedAt, error: String(error && error.message || error) });
          throw error;
        }
      };
      return true;
    })()`);

    await clickPoint(client, await pointFor(client, '#btn-group-chat'));
    try {
      await waitFor('meeting modal', () => client.eval(`document.querySelector('#meeting-create-modal')?.style.display === 'flex'`), 8000);
    } catch (error) {
      const diagnostics = await client.eval(`(async () => {
        const modal = document.querySelector('#meeting-create-modal');
        let meetings = [];
        try { meetings = await require('electron').ipcRenderer.invoke('get-meetings'); } catch {}
        return {
          readyState: document.readyState,
          modalExists: !!modal,
          modalDisplay: modal && modal.style.display,
          meetingCreateApi: typeof window.openMeetingCreateModal,
          workspaceApi: typeof window.WorkspaceController,
          rendererErrors: window.__groupCreateErrors || [],
          invokes: window.__groupCreateInvokes || [],
          sessionItems: document.querySelectorAll('.session-item').length,
          meetingItems: document.querySelectorAll('.meeting-item').length,
          meetings: meetings.length,
          bodyBusy: document.body.getAttribute('aria-busy'),
        };
      })()`);
      console.error(JSON.stringify({ diagnostics, logs: hub.log().slice(-80) }, null, 2));
      throw error;
    }

    const modalShot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(MODAL_SCREENSHOT_PATH, Buffer.from(modalShot.data, 'base64'));

    // Regression: any synchronous DOM problem used to throw before _onCreate's try/catch,
    // leaving the user with a button that appeared to do absolutely nothing.
    await client.eval(`document.querySelector('#meeting-create-modal .mcm-slot .mcm-ai-select').remove()`);
    await clickPoint(client, await pointFor(client, '.mcm-create'));
    const recoveredError = await waitFor('visible synchronous create error', () => client.eval(`(() => {
      const modal = document.querySelector('#meeting-create-modal');
      const error = modal && modal.querySelector('.mcm-error');
      const button = modal && modal.querySelector('.mcm-create');
      if (!error || !button || button.disabled) return null;
      return {
        error: error.textContent,
        buttonText: button.textContent,
        ariaBusy: button.getAttribute('aria-busy'),
        createInvokes: (window.__groupCreateInvokes || []).filter(item => item.channel === 'create-meeting').length,
      };
    })()`));
    assert.match(recoveredError.error, /成员 1 未选择 AI/);
    assert.equal(recoveredError.buttonText, '创建群聊');
    assert.equal(recoveredError.ariaBusy, null);
    assert.equal(recoveredError.createInvokes, 0);

    await client.eval(`window.openMeetingCreateModal('group')`);
    const createPoint = await pointFor(client, '.mcm-create');
    await clickPoint(client, createPoint);

    const result = await waitFor('meeting creation or visible error', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const meetings = await ipcRenderer.invoke('get-meetings');
      const modal = document.querySelector('#meeting-create-modal');
      const error = modal && modal.querySelector('.mcm-error');
      if (!meetings.length && !error) return null;
      return {
        meetingCount: meetings.length,
        meeting: meetings[meetings.length - 1] || null,
        modalDisplay: modal && modal.style.display,
        createDisabled: !!modal?.querySelector('.mcm-create')?.disabled,
        createText: modal?.querySelector('.mcm-create')?.textContent || '',
        error: error?.textContent || '',
        invokes: window.__groupCreateInvokes || [],
        rendererErrors: window.__groupCreateErrors || [],
      };
    })()`), 30000);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    const logs = hub.log().slice(-40);
    assert.ok(!logs.some(line => /installed into Gemini settings\.json/.test(line)),
      'isolated Hub must not rewrite the real user Gemini settings');
    console.log(JSON.stringify({ ok: result.meetingCount > 0 && result.modalDisplay === 'none', recoveredError, createPoint, result, screenshots: { modal: MODAL_SCREENSHOT_PATH, created: SCREENSHOT_PATH }, logs }, null, 2));
    assert.ok(result.meetingCount > 0, `group chat was not created: ${result.error || 'no visible error'}`);
    assert.equal(result.meeting.subSessions.length, 3);
    assert.equal(result.modalDisplay, 'none', 'modal should close after successful creation');
    assert.deepEqual(result.rendererErrors, []);
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
