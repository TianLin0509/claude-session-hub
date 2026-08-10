'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-native-restart-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'session-native-restart');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `codex-restart-menu-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

const CLAUDE_SID = '11111111-1111-4111-8111-111111111111';
const CODEX_SID = '22222222-2222-4222-8222-222222222222';

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

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function readInvocations() {
  if (!fs.existsSync(INVOCATION_LOG)) return [];
  return fs.readFileSync(INVOCATION_LOG, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeFixtures() {
  for (const dir of [DATA_DIR, HOME_DIR, WORK_DIR, FAKE_BIN, CODEX_HOME, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const fake = path.join(FAKE_BIN, 'fake-cli.js');
  fs.writeFileSync(fake, `'use strict';
const fs = require('node:fs');
const provider = process.argv[2];
fs.appendFileSync(process.env.HUB_RESTART_E2E_LOG, JSON.stringify({
  provider,
  args: process.argv.slice(3),
  cwd: process.cwd(),
  at: Date.now(),
}) + '\\n', 'utf8');
process.stdout.write('[fake-' + provider + '-ready]\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(
      path.join(FAKE_BIN, `${provider}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`,
      'utf8',
    );
  }
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

async function dispatchMouse(client, selector, button) {
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y, width: rect.width, height: rect.height,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
    };
  })()`);
  assert.ok(point && point.visible && point.topmost, `${selector} should be visible and topmost`);
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1,
  });
}

async function restartFromSidebar(client, sessionId, captureScreenshot = false) {
  await dispatchMouse(client, `[data-session-id="${sessionId}"]`, 'right');
  const menu = await waitFor('restart context menu', () => client.eval(`(() => {
    const menu = document.querySelector('#context-menu');
    const restart = menu && menu.querySelector('[data-action="restart"]');
    if (!menu || !restart || getComputedStyle(menu).display === 'none') return null;
    return { label: restart.textContent.trim() };
  })()`));
  assert.equal(menu.label, '重启并继续当前会话');
  if (captureScreenshot) {
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
  }
  await dispatchMouse(client, '#context-menu [data-action="restart"]', 'left');
  return menu;
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'session-native-restart',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        HUB_CLAUDE_BACKEND: 'subscription',
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'e2e',
        HUB_RESTART_E2E_LOG: INVOCATION_LOG,
        DEEPSEEK_API_KEY: '',
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    await _waitMs(900);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1365, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const claude = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'claude-resume',
      opts: {
        title: 'Claude Exact Restart', cwd: ${JSON.stringify(WORK_DIR)},
        resumeCCSessionId: ${JSON.stringify(CLAUDE_SID)}, model: 'opus', effort: 'high',
        userRenamed: true, pinned: true, workspaceLabel: 'AI'
      }
    })`);
    assert.ok(claude && claude.id);
    await waitFor('initial Claude invocation', () => (
      readInvocations().filter(entry => entry.provider === 'claude').length === 1
    ));
    result.claudeMenu = await restartFromSidebar(client, claude.id);
    await waitFor('restarted Claude invocation', () => (
      readInvocations().filter(entry => entry.provider === 'claude').length === 2
    ));

    const codex = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'codex-resume',
      opts: {
        title: 'Codex Exact Restart', cwd: ${JSON.stringify(WORK_DIR)},
        useResume: true, codexSid: ${JSON.stringify(CODEX_SID)},
        codexProfile: 'e2e', mcpProfile: 'browser', model: 'gpt-5.5',
        userRenamed: true, pinned: true, workspaceLabel: 'AI'
      }
    })`);
    assert.ok(codex && codex.id);
    await waitFor('initial Codex invocation', () => (
      readInvocations().filter(entry => entry.provider === 'codex').length === 1
    ));
    result.codexMenu = await restartFromSidebar(client, codex.id, true);
    await waitFor('restarted Codex invocation', () => (
      readInvocations().filter(entry => entry.provider === 'codex').length === 2
    ));

    const invocations = readInvocations();
    const claudeInvocations = invocations.filter(entry => entry.provider === 'claude');
    const codexInvocations = invocations.filter(entry => entry.provider === 'codex');
    for (const invocation of claudeInvocations) {
      assert.ok(invocation.args.includes('--resume'));
      assert.ok(invocation.args.includes(CLAUDE_SID));
      assert.ok(invocation.args.includes('--effort'));
      assert.ok(invocation.args.includes('high'));
    }
    for (const invocation of codexInvocations) {
      assert.equal(invocation.args[0], 'resume');
      assert.equal(invocation.args[1], CODEX_SID,
        'codex-resume must keep the exact id instead of opening the picker or starting a fresh thread');
      assert.ok(invocation.args.includes('gpt-5.5'));
    }

    const sessions = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions')`);
    const claudeAfter = sessions.find(session => session.id === claude.id);
    const codexAfter = sessions.find(session => session.id === codex.id);
    assert.deepEqual({
      id: claudeAfter.id,
      ccSessionId: claudeAfter.ccSessionId,
      title: claudeAfter.title,
      pinned: claudeAfter.pinned,
      effort: claudeAfter.effort,
    }, {
      id: claude.id,
      ccSessionId: CLAUDE_SID,
      title: 'Claude Exact Restart',
      pinned: true,
      effort: 'high',
    });
    assert.deepEqual({
      id: codexAfter.id,
      codexSid: codexAfter.codexSid,
      title: codexAfter.title,
      pinned: codexAfter.pinned,
      model: codexAfter.currentModel && codexAfter.currentModel.id,
      codexProfile: codexAfter.codexProfile,
      mcpProfile: codexAfter.mcpProfile,
    }, {
      id: codex.id,
      codexSid: CODEX_SID,
      title: 'Codex Exact Restart',
      pinned: true,
      model: 'gpt-5.5',
      codexProfile: 'e2e',
      mcpProfile: 'browser',
    });

    result.ok = true;
    result.sessions = { claude: claudeAfter, codex: codexAfter };
    result.invocations = invocations;
    result.screenshot = SCREENSHOT_PATH;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      screenshot: SCREENSHOT_PATH,
      result: RESULT_PATH,
      claudeCommands: claudeInvocations.map(entry => entry.args),
      codexCommands: codexInvocations.map(entry => entry.args),
    }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-native-restart-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
