'use strict';

// Credential-backed, no-prompt diagnostic for Claude Code's inline /model path.
// Only a disposable CLAUDE_CONFIG_DIR and isolated Hub PID are touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-real-claude-model-switch-${process.pid}-${Date.now()}`);
const SOURCE_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLAUDE_DIR = path.join(ROOT, 'claude-config');
const DATA_DIR = path.join(ROOT, 'hub-data');
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'output', 'playwright', 'model-switch');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const PICKER_SCREENSHOT = path.join(EVIDENCE_DIR, `20260903-ai-hub-claude-model-picker-${STAMP}.png`);
const SWITCH_SCREENSHOT = path.join(EVIDENCE_DIR, `20260903-ai-hub-claude-model-switched-${STAMP}.png`);
const RESULT_PATH = path.join(EVIDENCE_DIR, `20260903-ai-hub-claude-model-switch-${STAMP}.json`);

function prepareClaudeConfig() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const credentials = path.join(SOURCE_CLAUDE_DIR, '.credentials.json');
  if (!fs.existsSync(credentials)) throw new Error(`Claude credentials missing: ${credentials}`);
  fs.copyFileSync(credentials, path.join(CLAUDE_DIR, '.credentials.json'));
  const statePath = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(statePath)) {
    const source = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const state = {
      autoUpdates: false,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: source.lastOnboardingVersion || '2.1.259',
      installMethod: source.installMethod || 'native',
      projects: {},
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
    };
    for (const key of [
      'userID', 'anonymousId', 'machineID', 'oauthAccount', 'clientDataCacheSlots',
      'hasAvailableSubscription', 'modelAccessCache', 'orgModelDefaultCache',
      'additionalModelOptionsCache', 'additionalModelCostsCache',
      'skipDangerousModePermissionPrompt', 'unpinFable5LaunchEffort',
    ]) {
      if (source[key] !== undefined) state[key] = source[key];
    }
    fs.writeFileSync(path.join(CLAUDE_DIR, '.claude.json'), JSON.stringify(state, null, 2), 'utf8');
  }
  fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), JSON.stringify({
    hooks: {},
    permissions: { defaultMode: 'bypassPermissions' },
    skipDangerousModePermissionPrompt: true,
  }, null, 2), 'utf8');
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

function modelFields(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => /model/i.test(key)));
  } catch (_) {
    return {};
  }
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
  prepareClaudeConfig();
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
      label: 'real-claude-model-switch',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'fake-home'),
        CLAUDE_CONFIG_DIR: CLAUDE_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await waitFor('Hub E2E API', () => client.eval(`Boolean(window.__hubE2E && window.WorkspaceController && window.WorkspaceController.createSession)`));
    const created = await client.eval(`window.WorkspaceController.createSession('claude', {
      cwd:${JSON.stringify(path.resolve(__dirname, '..'))},
      opts:{ model:'claude-opus-5', effort:'low', mcpProfile:'none', fastMode:false }
    })`);
    result.sessionId = created.id;
    await waitFor('renderer session', () => client.eval(`sessions.has(${JSON.stringify(created.id)})`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(created.id)}, { forceScrollBottom:true })`);
    const startup = await waitFor('Claude startup surface', () => client.eval(`(() => {
      const screen = window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)}).toLowerCase();
      if (screen.includes('allow external claude.md file imports?')) return 'external-imports';
      if (screen.includes('shift+tab')) return 'ready';
      return '';
    })()`));
    if (startup === 'external-imports') {
      // Default is the safe "No" option in the disposable config.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await client.eval(`ipcRenderer.send('terminal-input', { sessionId:${JSON.stringify(created.id)}, data:'\\r' })`);
        await _waitMs(500);
        const dismissed = await client.eval(`!window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)}).toLowerCase().includes('allow external claude.md file imports?')`);
        if (dismissed) break;
      }
    }
    await waitFor('Claude prompt', () => client.eval(`(() => {
      const id = ${JSON.stringify(created.id)};
      const screen = window.__hubE2E.terminalLiveScreenText(id).toLowerCase();
      if (screen.includes('allow external claude.md file imports?')) {
        const now = Date.now();
        if (!window.__claudeModelDiagEnterAt || now - window.__claudeModelDiagEnterAt > 500) {
          window.__claudeModelDiagEnterAt = now;
          ipcRenderer.send('terminal-input', { sessionId:id, data:'\\r' });
        }
        return false;
      }
      return screen.includes('shift+tab');
    })()`));
    await client.eval(`document.querySelector('.terminal-model-badge').click()`);
    await waitFor('Fable 5.1 model option', () => client.eval(`document.querySelector('.model-picker-menu [data-model-id="claude-fable-5-1[1m]"]') !== null`));
    result.hubPicker = await client.eval(`(() => ({
      note:document.querySelector('.model-picker-note')?.textContent || '',
      fableLabel:document.querySelector('.model-picker-menu [data-model-id="claude-fable-5-1[1m]"] .model-picker-label')?.textContent || '',
      models:Array.from(document.querySelectorAll('.model-picker-item')).map(item => item.dataset.modelId),
      currentCount:document.querySelectorAll('.model-picker-item.current').length,
    }))()`);
    assert.equal(result.hubPicker.fableLabel, 'Fable 5.1 (1M context)');
    assert.equal(result.hubPicker.currentCount, 1);
    const pickerShot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(PICKER_SCREENSHOT, Buffer.from(pickerShot.data, 'base64'));
    await client.eval(`document.querySelector('.model-picker-menu [data-model-id="claude-fable-5-1[1m]"]').click()`);
    result.switched = await waitFor('Hub confirmed Claude Fable 5.1', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(created.id)});
      return session && session.currentModel && /fable-5-1/i.test(session.currentModel.id || '')
        && !session._modelSwitchPending;
    })()`));
    result.screen = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)})`);
    result.mainSession = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(items => {
      const session = items.find(item => item.id === ${JSON.stringify(created.id)});
      return session ? { currentModel:session.currentModel, effort:session.effort } : null;
    })`);
    result.persistedModelFields = {
      state: modelFields(path.join(CLAUDE_DIR, '.claude.json')),
      settings: modelFields(path.join(CLAUDE_DIR, 'settings.json')),
    };
    assert.match(result.screen, /Set model to Fable 5\.1/);
    assert.match(result.mainSession.currentModel.id, /fable-5-1/i);
    assert.equal(Object.prototype.hasOwnProperty.call(result.persistedModelFields.settings, 'model'), false,
      'Hub must restore Claude Code global default after an in-session switch');
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
          && path.basename(resolved).startsWith('hub-real-claude-model-switch-')) {
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
