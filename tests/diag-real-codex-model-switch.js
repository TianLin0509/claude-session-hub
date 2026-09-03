'use strict';

// Credential-backed, no-prompt diagnostic for Codex's in-session /model path.
// It copies only auth/config/catalog into a disposable CODEX_HOME, starts one
// isolated Hub/Codex PTY, sends the bare /model command (never a model prompt), and
// closes only the PID returned by launchIsolatedHub.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-real-codex-model-switch-${process.pid}-${Date.now()}`);
const SOURCE_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ISOLATED_CODEX_HOME = path.join(ROOT, 'codex-home');
const DATA_DIR = path.join(ROOT, 'hub-data');
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'output', 'playwright', 'model-switch');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const PICKER_SCREENSHOT = path.join(EVIDENCE_DIR, `20260903-ai-hub-codex-model-picker-${STAMP}.png`);
const SWITCH_SCREENSHOT = path.join(EVIDENCE_DIR, `20260903-ai-hub-codex-model-switched-${STAMP}.png`);
const RESULT_PATH = path.join(EVIDENCE_DIR, `20260903-ai-hub-codex-model-switch-${STAMP}.json`);

function prepareCodexHome() {
  fs.mkdirSync(ISOLATED_CODEX_HOME, { recursive: true });
  const auth = path.join(SOURCE_CODEX_HOME, 'auth.json');
  if (!fs.existsSync(auth)) throw new Error(`Codex auth missing: ${auth}`);
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    const source = path.join(SOURCE_CODEX_HOME, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(ISOLATED_CODEX_HOME, name));
  }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(150);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

async function main() {
  prepareCodexHome();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  let failure = null;
  const result = { port, pickerScreenshot: PICKER_SCREENSHOT, switchScreenshot: SWITCH_SCREENSHOT, resultPath: RESULT_PATH };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'real-codex-model-switch',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CODEX_HOME: ISOLATED_CODEX_HOME,
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await waitFor('Hub E2E API', () => client.eval(`Boolean(window.__hubE2E && window.WorkspaceController && window.WorkspaceController.createSession)`));
    const created = await client.eval(`window.WorkspaceController.createSession('codex', {
      cwd:${JSON.stringify(path.resolve(__dirname, '..'))},
      opts:{ model:'gpt-5.6-sol', effort:'low', mcpProfile:'none', codexSpeedTier:'standard' }
    })`);
    result.sessionId = created.id;
    await waitFor('renderer session', () => client.eval(`sessions.has(${JSON.stringify(created.id)})`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(created.id)}, { forceScrollBottom:true })`);
    await waitFor('Codex prompt', () => client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)}).includes('Context ')`));
    result.before = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)})`);
    await client.eval(`document.querySelector('.terminal-model-badge').click()`);
    await waitFor('Hub model menu', () => client.eval(`document.querySelector('.model-picker-menu [data-model-id="gpt-5.5"]') !== null`));
    result.hubPicker = await client.eval(`(() => ({
      note:document.querySelector('.model-picker-note')?.textContent || '',
      models:Array.from(document.querySelectorAll('.model-picker-item')).map(item => item.dataset.modelId),
      disabled:document.querySelector('.model-picker-menu [data-model-id="gpt-5.5"]').classList.contains('disabled'),
      currentCount:document.querySelectorAll('.model-picker-item.current').length,
    }))()`);
    assert.equal(result.hubPicker.disabled, false);
    assert.equal(result.hubPicker.currentCount, 1);
    assert.deepEqual(result.hubPicker.models, [
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark',
    ]);
    const pickerShot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(PICKER_SCREENSHOT, Buffer.from(pickerShot.data, 'base64'));
    await client.eval(`document.querySelector('.model-picker-menu [data-model-id="gpt-5.5"]').click()`);
    result.switched = await waitFor('Hub confirmed gpt-5.5', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(created.id)});
      return session && session.currentModel && session.currentModel.id === 'gpt-5.5' && session.effort === 'low';
    })()`));
    result.afterSwitch = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)})`);
    result.mainSession = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(items => {
      const session = items.find(item => item.id === ${JSON.stringify(created.id)});
      return session ? { currentModel:session.currentModel, effort:session.effort } : null;
    })`);
    assert.equal(result.mainSession.currentModel.id, 'gpt-5.5');
    assert.equal(result.mainSession.effort, 'low');
    assert.match(result.afterSwitch, /Model changed to gpt-5\.5 low/);
    const switchShot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(SWITCH_SCREENSHOT, Buffer.from(switchShot.data, 'base64'));
  } catch (error) {
    failure = error;
    if (client && result.sessionId) {
      try {
        result.failureState = await client.eval(`(() => {
          const id = ${JSON.stringify(result.sessionId)};
          const session = sessions.get(id);
          return {
            model:session && session.currentModel,
            effort:session && session.effort,
            pending:session && session._modelSwitchPending,
            menu:document.querySelector('.model-picker-menu')?.innerText || '',
            screen:window.__hubE2E.terminalLiveScreenText(id),
          };
        })()`);
        console.error('[model switch failure state]\n' + JSON.stringify(result.failureState, null, 2));
      } catch (_) {}
    }
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-80).join('\n'));
  } finally {
    try {
      if (client) await client.close().catch(() => {});
      if (hub) {
        try { result.teardown = await gracefulQuit(hub); }
        catch (error) { if (!failure) failure = error; }
      }
    } finally {
      const resolved = path.resolve(ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-real-codex-model-switch-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
  if (failure) throw failure;
  result.success = true;
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
