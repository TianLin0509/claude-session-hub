'use strict';

// One real prompt, one real PTY agent, zero summarizer calls. The test proves
// that hooks/transcripts alone can build activity + deterministic delivery UI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const PROVIDER = String(process.env.HUB_REAL_PROVIDER || 'codex').toLowerCase();
if (!['claude', 'codex'].includes(PROVIDER)) throw new Error(`unsupported HUB_REAL_PROVIDER=${PROVIDER}`);
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-real-card-delivery-${PROVIDER}-${RUN_ID}`);
const WORKSPACE = path.join(TEMP_ROOT, 'workspace');
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const CLAUDE_DIR = path.join(TEMP_ROOT, 'claude-config');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'output', 'playwright', 'real-card-delivery');
const RESULT_PATH = path.join(ARTIFACT_DIR, `${PROVIDER}-result-${RUN_ID}.json`);
const RUNNING_SHOT = path.join(ARTIFACT_DIR, `${PROVIDER}-running-${RUN_ID}.png`);
const FINAL_SHOT = path.join(ARTIFACT_DIR, `${PROVIDER}-final-${RUN_ID}.png`);
const PROOF_PATH = path.join(WORKSPACE, 'artifacts', `20260903-${PROVIDER}-card-delivery-proof.txt`);
const TEST_PATH = path.join(WORKSPACE, 'tests', `20260903-${PROVIDER}-card-delivery-proof.test.js`);
const PROOF_MARKER = `CARD_DELIVERY_${PROVIDER.toUpperCase()}_PASS_73A9`;

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

function prepareWorkspace() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: WORKSPACE, windowsHide: true });
  fs.writeFileSync(path.join(WORKSPACE, 'AGENTS.md'), [
    '# Disposable card-delivery verification workspace',
    '',
    '- Only create the two files explicitly named by the user prompt.',
    '- Run the requested test and report its real result.',
  ].join('\n'), 'utf8');
}

function prepareClaudeConfig() {
  const sourceDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const credentials = path.join(sourceDir, '.credentials.json');
  if (!fs.existsSync(credentials)) throw new Error(`Claude credentials missing: ${credentials}`);
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(credentials, path.join(CLAUDE_DIR, '.credentials.json'));
  const sourceStatePath = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(sourceStatePath)) {
    const source = JSON.parse(fs.readFileSync(sourceStatePath, 'utf8'));
    const state = {
      autoUpdates: false,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: source.lastOnboardingVersion || '2.1.259',
      installMethod: source.installMethod || 'native',
      projects: {},
      remoteControlAtStartup: false,
      remoteDialogSeen: true,
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
    };
    for (const key of [
      'userID', 'anonymousId', 'machineID', 'oauthAccount', 'clientDataCacheSlots',
      'hasAvailableSubscription', 'modelAccessCache', 'orgModelDefaultCache',
      'additionalModelOptionsCache', 'additionalModelCostsCache',
      'hasSeenAutoModeEntryWarning', 'hasResetAutoModeOptInForDefaultOffer',
      'hasSeenAutoDefaultNudge', 'autoPermissionsNotificationCount',
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
  const deployed = ensureClaudeHookIntegration({
    claudeDir: CLAUDE_DIR,
    sourceScriptsDir: path.join(HUB_ROOT, 'scripts'),
    logger: { log() {}, warn() {} },
  });
  if (deployed.errors.length) throw new Error(`Claude hook deployment failed: ${deployed.errors.join('; ')}`);
}

async function waitFor(label, fn, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(150);
  }
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function capture(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function readUi(client, sessionId) {
  return client.eval(`(async () => {
    const sid = ${JSON.stringify(sessionId)};
    if (activeSessionId !== sid) {
      await window.__hubE2E.selectSession(sid, { forceScrollBottom:true });
      window.__hubE2E.cardQuestionNavigator.setViewMode('card');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const cards = Array.from(document.querySelectorAll('#msg-overlay > .turn-card:not(.user)'))
      .filter(card => card.dataset.sessionId === sid);
    const card = cards[cards.length - 1] || null;
    const delivery = card?.querySelector('.turn-delivery-summary') || null;
    return {
      activeSessionId,
      sessionStatus:sessions.get(sid)?.status || null,
      runtimeState:document.querySelector('.terminal-header .terminal-status')?.dataset.runtimeState || null,
      runtimeDetail:document.querySelector('.terminal-header .terminal-status-detail')?.textContent || '',
      cardCount:cards.length,
      text:card?.querySelector('.turn-body')?.innerText || '',
      activityCount:card?.querySelectorAll('.turn-activity-item').length || 0,
      activityStatuses:Array.from(card?.querySelectorAll('.turn-activity-status') || []).map(item => item.dataset.activityStatus),
      deliveryPresent:!!delivery,
      deliverySource:delivery?.dataset.summarySource || null,
      deliveryFiles:delivery?.querySelectorAll('.turn-delivery-file').length || 0,
      deliveryChecks:delivery?.querySelectorAll('.turn-delivery-check').length || 0,
      deliveryArtifacts:delivery?.querySelectorAll('.turn-delivery-artifact').length || 0,
      deliveryText:delivery?.innerText || '',
      patchCount:Number(card?.dataset.patchCount || 0),
    };
  })()`);
}

async function dismissClaudeStartupIfNeeded(client, sessionId) {
  const startup = await waitFor('Claude startup surface', () => client.eval(`(() => {
    const screen = window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sessionId)}).toLowerCase();
    if (screen.includes('allow external claude.md file imports?')) return 'external-imports';
    if (screen.includes('shift+tab')) return 'ready';
    return '';
  })()`), 60000);
  if (startup === 'external-imports') {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.eval(`ipcRenderer.send('terminal-input', { sessionId:${JSON.stringify(sessionId)}, data:'\\r' })`);
      await _waitMs(500);
      const dismissed = await client.eval(`!window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sessionId)}).toLowerCase().includes('allow external claude.md file imports?')`);
      if (dismissed) break;
    }
  }
  await waitFor('Claude prompt', () => client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sessionId)}).toLowerCase().includes('shift+tab')`), 60000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const screen = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sessionId)}).toLowerCase()`);
    if (screen.includes('bypass permissions on')) break;
    await client.eval(`ipcRenderer.send('terminal-input', { sessionId:${JSON.stringify(sessionId)}, data:'\u001b[Z' })`);
    await _waitMs(450);
  }
  const permissionModeReady = await client.eval(
    `window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sessionId)}).toLowerCase().includes('bypass permissions on')`,
  );
  if (!permissionModeReady) throw new Error('Claude isolated test could not enter bypass permissions mode');
  // The footer can paint a fraction before Ink has attached the input handler.
  // A short stability window keeps the E2E from racing startup, while real
  // users naturally spend longer than this before submitting a first prompt.
  await _waitMs(1500);
}

async function main() {
  prepareWorkspace();
  if (PROVIDER === 'claude') prepareClaudeConfig();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  let failure = null;
  const result = {
    provider: PROVIDER,
    runId: RUN_ID,
    port,
    workspace: WORKSPACE,
    proofPath: PROOF_PATH,
    testPath: TEST_PATH,
    resultPath: RESULT_PATH,
    runningScreenshot: RUNNING_SHOT,
    finalScreenshot: FINAL_SHOT,
    aiPromptCount: 1,
    summarizerCalls: 0,
  };
  try {
    const extraEnv = {
      CLAUDE_HUB_E2E: '1',
      CLAUDE_HUB_DISABLE_LEAGUE_BACKGROUND: '1',
      HUB_SESSION_SEARCH_PREWARM: '0',
      CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'fake-home'),
      AI_HUB_WORKSPACE_ROOT: path.join(TEMP_ROOT, 'workspaces'),
      DEEPSEEK_API_KEY: '',
      ...(PROVIDER === 'claude' ? { CLAUDE_CONFIG_DIR: CLAUDE_DIR } : {}),
    };
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: `real-card-delivery-${PROVIDER}`,
      windowMode: 'hidden',
      extraEnv,
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 920, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor('Hub APIs', () => client.eval('!!(window.__hubE2E && window.WorkspaceController && window.WorkspaceController.createSession)'));
    const opts = PROVIDER === 'claude'
      ? {
        model: process.env.HUB_DIAG_CLAUDE_MODEL || 'claude-sonnet-4-6',
        effort: 'low', mcpProfile: 'none', fastMode: false,
      }
      : {
        model: process.env.HUB_DIAG_CODEX_MODEL || 'gpt-5.6-sol',
        effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit',
      };
    const created = await client.eval(`window.WorkspaceController.createSession(${JSON.stringify(PROVIDER)}, {
      cwd:${JSON.stringify(WORKSPACE)}, opts:${JSON.stringify(opts)}
    }).then(session => ({ id:session.id, kind:session.kind }))`);
    result.sessionId = created.id;
    await waitFor('renderer session', () => client.eval(`sessions.has(${JSON.stringify(created.id)})`), 20000);
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(created.id)}, { forceScrollBottom:true })`);
    if (PROVIDER === 'claude') {
      await dismissClaudeStartupIfNeeded(client, created.id);
    } else {
      await waitFor('Codex prompt', () => client.eval(
        `window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)}).includes('Context ')`,
      ), 60000);
    }
    // Background session restoration/automation can emit session-created while
    // the target CLI is warming up. Reassert the exact isolated target before
    // querying the global card composer, otherwise the prompt can be sent to a
    // different active session even though this Claude PTY is ready.
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(created.id)}, { forceScrollBottom:true })`);
    await waitFor('target session focused', () => client.eval(
      `activeSessionId === ${JSON.stringify(created.id)}`,
    ), 10000);
    await client.eval(`window.__hubE2E.cardQuestionNavigator.setViewMode('card')`);
    const proofRelative = path.relative(WORKSPACE, PROOF_PATH);
    const testRelative = path.relative(WORKSPACE, TEST_PATH);
    const prompt = [
      'Disposable verification task.',
      'Run PowerShell Start-Sleep -Seconds 4.',
      `Using the file editing tool, not shell redirection, create ${proofRelative} containing exactly ${PROOF_MARKER}.`,
      `Also create ${testRelative} with node:test; read that proof file and assert the exact marker.`,
      `Run node --test "${testRelative}". Touch no other file.`,
      `End with ${PROOF_MARKER} and exactly: 绝对路径：${PROOF_PATH}`,
    ].join(' ');
    if (PROVIDER === 'claude') {
      // This diagnostic owns card/hook/transcript acceptance, not the separate
      // closed-loop prompt-submit feature. Drive the exact same PTY directly so
      // an unrelated composer `stuck` result cannot mask presentation evidence.
      await client.eval(`ipcRenderer.send('terminal-input', {
        sessionId:${JSON.stringify(created.id)}, data:${JSON.stringify(prompt)}
      })`);
      await _waitMs(900);
      await client.eval(`ipcRenderer.send('terminal-input', {
        sessionId:${JSON.stringify(created.id)}, data:'\\r'
      })`);
      result.promptSubmit = {
        ok: true, kind: PROVIDER, sendStatus: 'direct-test-driver',
        mode: 'single-pty-write-plus-enter', enterAttempts: 1,
      };
    } else {
      result.promptSubmit = await client.eval(`ipcRenderer.invoke('session:send-prompt', {
        sessionId:${JSON.stringify(created.id)}, text:${JSON.stringify(prompt)}
      })`);
      assert.equal(result.promptSubmit?.ok, true, JSON.stringify(result.promptSubmit));
      assert.notEqual(result.promptSubmit?.sendStatus, 'stuck', JSON.stringify(result.promptSubmit));
    }

    result.running = await waitFor('real running activity', async () => {
      const state = await readUi(client, created.id);
      return state.activeSessionId === created.id
        && state.runtimeState === 'running'
        && (state.activityStatuses.includes('running') || /Start-Sleep/i.test(state.runtimeDetail))
        ? state : null;
    }, 90000);
    await capture(client, RUNNING_SHOT);

    result.final = await waitFor('deterministic delivery card', async () => {
      const state = await readUi(client, created.id);
      return state.activeSessionId === created.id
        && state.text.includes(PROOF_MARKER)
        && state.deliveryPresent
        && state.deliveryFiles >= 1
        && state.deliveryChecks >= 1
        && state.deliveryArtifacts >= 1
        && state.runtimeState === 'completed'
        ? state : null;
    }, 180000);
    await capture(client, FINAL_SHOT);

    assert.equal(result.final.deliverySource, 'deterministic');
    assert.equal(result.final.deliveryArtifacts >= 1, true);
    assert.equal(result.final.deliveryFiles >= 1, true);
    assert.equal(result.final.deliveryChecks >= 1, true);
    assert.equal(result.final.activityCount >= 2, true);
    result.preview = await client.eval(`(async () => {
      const link = document.querySelector('.turn-delivery-artifact a.rt-file-link');
      if (!link) return null;
      link.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const panel = document.getElementById('preview-panel');
        const title = document.getElementById('preview-title');
        if (panel?.style.display === 'flex' && title?.title) {
          return { display:panel.style.display, path:title.title, title:title.textContent };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return null;
    })()`);
    assert.equal(result.preview?.display, 'flex');
    assert.equal(result.preview?.path, PROOF_PATH);
    await client.eval(`document.getElementById('preview-close')?.click()`);
    assert.equal(fs.readFileSync(PROOF_PATH, 'utf8').trim(), PROOF_MARKER);
    assert.equal(fs.existsSync(TEST_PATH), true);
    const testRun = execFileSync(process.execPath, ['--test', TEST_PATH], {
      cwd: WORKSPACE, encoding: 'utf8', windowsHide: true,
    });
    assert.match(testRun, /pass 1/i);
    result.externalVerification = { passed: true, output: testRun.slice(-1000) };
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    failure = error;
    if (client && result.sessionId) {
      try {
        result.failureUi = await readUi(client, result.sessionId);
        result.failureScreen = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(result.sessionId)})`);
        await capture(client, FINAL_SHOT);
      } catch {}
    }
    if (PROVIDER === 'claude') {
      try {
        const projectRoot = path.join(CLAUDE_DIR, 'projects');
        const stack = [projectRoot];
        const files = [];
        while (stack.length && files.length < 80) {
          const dir = stack.pop();
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else files.push({ path: full, size: fs.statSync(full).size });
          }
        }
        result.failureTranscriptFiles = files;
      } catch {}
    }
    try { fs.writeFileSync(RESULT_PATH, JSON.stringify({ ...result, success: false, error: error.message }, null, 2), 'utf8'); } catch {}
    if (hub) console.error('[isolated hub tail]\n' + hub.log().slice(-100).join('\n'));
  } finally {
    if (client) { try { client.ws.close(); } catch {} }
    if (hub) {
      try { result.teardown = await gracefulQuit(hub); }
      catch (error) { if (!failure) failure = error; }
    }
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-real-card-delivery-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  if (failure) throw failure;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
