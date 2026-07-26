'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-session-fork-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'cli-invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'session-fork-button');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `session-fork-button-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `session-fork-button-${RUN_ID}.json`);

const CLAUDE_SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_SOURCE_ID = '22222222-2222-4222-8222-222222222222';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(120);
  }
  const suffix = lastError ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function clickPoint(client, x, y) {
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

function readInvocations() {
  if (!fs.existsSync(INVOCATION_LOG)) return [];
  return fs.readFileSync(INVOCATION_LOG, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeFakeCliFixtures() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  fs.writeFileSync(fakeCliPath, `'use strict';
const fs = require('node:fs');
const provider = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(process.env.HUB_FORK_E2E_LOG, JSON.stringify({ provider, args, at: Date.now() }) + '\\n', 'utf8');
process.stdout.write('[fake-' + provider + '] ' + args.join(' ') + '\\r\\n');
setTimeout(() => process.exit(0), 120);
`, 'utf8');

  for (const provider of ['claude', 'codex']) {
    const wrapperPath = path.join(FAKE_BIN_DIR, `${provider}.cmd`);
    fs.writeFileSync(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`,
      'utf8',
    );
  }
}

function writeIsolatedConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const config = {
    providers: {
      claude: { backend: 'subscription' },
      codex: {
        backend: 'subscription',
        subscription_profile: 'e2e',
        subscription_profiles: [
          { id: 'e2e', label: 'E2E isolated', home: CODEX_HOME },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function main() {
  writeFakeCliFixtures();
  writeIsolatedConfig();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const port = Number(process.env.HUB_FORK_E2E_PORT) || await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const inheritedPath = process.env[pathKey] || '';
  const result = { runId: RUN_ID, port };
  let hub = null;
  let client = null;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'session-fork-button',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${inheritedPath}`,
        HUB_CLAUDE_BACKEND: 'subscription',
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'e2e',
        HUB_FORK_E2E_LOG: INVOCATION_LOG,
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /index\.html/i.test(target.url || ''),
    );

    console.log('[step] create Claude source');
    const claudeSource = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('create-session', {
        kind: 'claude',
        opts: {
          title: 'Claude E2E Source',
          cwd: ${JSON.stringify(WORK_DIR)},
          resumeCCSessionId: ${JSON.stringify(CLAUDE_SOURCE_ID)},
          model: 'opus'
        }
      });
    })()`);
    assert.ok(claudeSource && claudeSource.id, 'Claude source session should be created');
    console.log('[step] wait Claude source selection');
    await waitFor('Claude source selection', () => client.eval(
      `activeSessionId === ${JSON.stringify(claudeSource.id)} && sessions.has(${JSON.stringify(claudeSource.id)})`,
    ));

    console.log('[step] click Claude branch button');
    result.claudeButton = await client.eval(`(() => {
      const button = document.querySelector('.btn-fork-session');
      if (!button) return { found: false };
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        found: true,
        text: button.textContent.trim(),
        title: button.title,
        ariaLabel: button.getAttribute('aria-label'),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(button).display !== 'none',
        topmost: hit === button || button.contains(hit),
        x,
        y,
      };
    })()`);
    assert.equal(result.claudeButton.found, true);
    assert.equal(result.claudeButton.text, '分支');
    assert.equal(result.claudeButton.title, '创建继承当前上下文的独立会话 (Ctrl+Shift+B)');
    assert.equal(result.claudeButton.ariaLabel, '创建当前会话分支');
    assert.equal(result.claudeButton.visible, true);
    assert.equal(result.claudeButton.topmost, true, 'Claude branch button should not be covered');
    await clickPoint(client, result.claudeButton.x, result.claudeButton.y);

    console.log('[step] wait Claude branch');
    const claudeBranch = await waitFor('Claude branch session', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const all = await ipcRenderer.invoke('get-sessions');
      return all.find(session => session.id !== ${JSON.stringify(claudeSource.id)} && session.title === 'Claude E2E Source · 分支') || null;
    })()`));
    assert.notEqual(claudeBranch.id, claudeSource.id);
    assert.equal(claudeBranch.userRenamed, true, 'Claude branch title should stay stable');
    console.log('[step] wait Claude CLI invocation');
    await waitFor('Claude fork CLI invocation', () => {
      const invocation = readInvocations().find(entry => (
        entry.provider === 'claude'
        && entry.args.includes('--fork-session')
        && entry.args.includes(CLAUDE_SOURCE_ID)
      ));
      return invocation || null;
    });

    console.log('[step] create Codex source');
    const codexSource = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('create-session', {
        kind: 'codex',
        opts: {
          title: 'Codex E2E Source',
          cwd: ${JSON.stringify(WORK_DIR)},
          useResume: true,
          codexSid: ${JSON.stringify(CODEX_SOURCE_ID)},
          codexProfile: 'e2e',
          model: 'gpt-5.5'
        }
      });
    })()`);
    assert.ok(codexSource && codexSource.id, 'Codex source session should be created');
    console.log('[step] wait Codex source selection');
    await waitFor('Codex source selection', () => client.eval(
      `activeSessionId === ${JSON.stringify(codexSource.id)} && sessions.has(${JSON.stringify(codexSource.id)})`,
    ));

    console.log('[step] click Codex branch button');
    result.codexButton = await client.eval(`(() => {
      const button = document.querySelector('.btn-fork-session');
      if (!button) return { found: false };
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        found: true,
        text: button.textContent.trim(),
        title: button.title,
        ariaLabel: button.getAttribute('aria-label'),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(button).display !== 'none',
        topmost: hit === button || button.contains(hit),
        x,
        y,
      };
    })()`);
    assert.equal(result.codexButton.found, true);
    assert.equal(result.codexButton.text, '分支');
    assert.equal(result.codexButton.title, '创建继承当前上下文的独立会话 (Ctrl+Shift+B)');
    assert.equal(result.codexButton.ariaLabel, '创建当前会话分支');
    assert.equal(result.codexButton.visible, true);
    assert.equal(result.codexButton.topmost, true, 'Codex branch button should not be covered');
    await clickPoint(client, result.codexButton.x, result.codexButton.y);

    console.log('[step] wait Codex branch');
    const codexBranch = await waitFor('Codex branch session', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const all = await ipcRenderer.invoke('get-sessions');
      return all.find(session => session.id !== ${JSON.stringify(codexSource.id)} && session.title === 'Codex E2E Source · 分支') || null;
    })()`));
    assert.notEqual(codexBranch.id, codexSource.id);
    assert.equal(codexBranch.userRenamed, true, 'Codex branch title should stay stable');
    console.log('[step] wait Codex CLI invocation');
    await waitFor('Codex fork CLI invocation', () => {
      const invocation = readInvocations().find(entry => (
        entry.provider === 'codex'
        && entry.args[0] === 'fork'
        && entry.args[1] === CODEX_SOURCE_ID
      ));
      return invocation || null;
    });

    console.log('[step] confirm active Codex branch');
    result.ui = await waitFor('Codex branch selection', () => client.eval(`(() => {
      const branchId = ${JSON.stringify(codexBranch.id)};
      const session = sessions.get(branchId);
      if (!session || activeSessionId !== branchId) return null;
      return {
        activeSessionId,
        title: session.title,
        sidebarTitles: Array.from(document.querySelectorAll('.session-title')).map(el => el.textContent.trim())
      };
    })()`));
    assert.equal(result.ui.title, 'Codex E2E Source · 分支');

    const invocations = readInvocations();
    const claudeForkInvocation = invocations.find(entry => entry.provider === 'claude' && entry.args.includes('--fork-session'));
    const codexForkInvocation = invocations.find(entry => entry.provider === 'codex' && entry.args[0] === 'fork');
    assert.deepEqual(
      claudeForkInvocation.args.slice(0, 5),
      ['--resume', CLAUDE_SOURCE_ID, '--fork-session', '--model', 'opus'],
    );
    assert.equal(codexForkInvocation.args[1], CODEX_SOURCE_ID);
    assert.equal(codexForkInvocation.args[codexForkInvocation.args.indexOf('--model') + 1], 'gpt-5.5');

    result.sessions = {
      claudeSource: { id: claudeSource.id, title: claudeSource.title },
      claudeBranch: { id: claudeBranch.id, title: claudeBranch.title, userRenamed: claudeBranch.userRenamed },
      codexSource: { id: codexSource.id, title: codexSource.title },
      codexBranch: { id: codexBranch.id, title: codexBranch.title, userRenamed: codexBranch.userRenamed },
    };
    result.invocations = invocations;
    result.hubPid = hub.pid;

    console.log('[step] capture screenshot');
    await client.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await client.send('Page.bringToFront');
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    assert.ok(fs.statSync(SCREENSHOT_PATH).size > 1000, 'screenshot should be non-empty');
    result.screenshotPath = SCREENSHOT_PATH;
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    console.log('[PASS] session fork button E2E');
    console.log(JSON.stringify({ screenshotPath: SCREENSHOT_PATH, resultPath: RESULT_PATH }));
  } catch (error) {
    if (hub) {
      console.error('[hub log tail]');
      console.error(hub.log().slice(-40).join('\n'));
    }
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    const resolvedTempRoot = path.resolve(TEMP_ROOT);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (resolvedTempRoot.startsWith(`${resolvedOsTemp}${path.sep}`)) {
      await fs.promises.rm(resolvedTempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch(error => {
  console.error('[FAIL] session fork button E2E');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
