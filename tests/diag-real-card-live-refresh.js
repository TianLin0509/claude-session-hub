'use strict';

// Credential-backed diagnostic for the real Codex card-view refresh path.
// It launches an isolated Hub and never attaches to or stops a production Hub.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const APP_ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-real-card-live-${RUN_ID}`);
const ARTIFACT_DIR = path.join(APP_ROOT, 'output', 'playwright', 'real-card-live-refresh');
const STAGE_SCREENSHOT = path.join(ARTIFACT_DIR, `codex-stage-${RUN_ID}.png`);
const FINAL_SCREENSHOT = path.join(ARTIFACT_DIR, `codex-final-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);
const STAGE_MARKER = 'CARD_STAGE_VISIBLE_73A9';
const FINAL_MARKER = 'CARD_FINAL_VISIBLE_61C4';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 120000) {
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
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function capture(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function readCardState(client, sessionId) {
  return client.eval(`(() => {
    const id = ${JSON.stringify(sessionId)};
    const session = sessions.get(id);
    const assistantCards = Array.from(document.querySelectorAll('#msg-overlay > .turn-card:not(.user)'));
    const text = assistantCards.map(card => card.querySelector('.turn-body')?.textContent || '').join('\\n');
    const reload = window._cardReloadState && window._cardReloadState.get(id);
    return {
      activeSessionId,
      currentView,
      sessionStatus:session?.status || null,
      transcriptPath:session?.transcriptPath || null,
      codexSid:session?.codexSid || null,
      assistantCount:assistantCards.length,
      assistantText:text,
      stageVisible:text.includes(${JSON.stringify(STAGE_MARKER)}),
      finalVisible:text.includes(${JSON.stringify(FINAL_MARKER)}),
      reload:reload ? {
        lastReloadAt:reload.lastReloadAt || 0,
        pending:!!reload.pendingTimer,
        inProgress:!!reload.inProgress,
      } : null,
      overlayDisplay:getComputedStyle(document.getElementById('msg-overlay')).display,
    };
  })()`);
}

async function main() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = {
    runId: RUN_ID,
    port,
    stageScreenshot: STAGE_SCREENSHOT,
    finalScreenshot: FINAL_SCREENSHOT,
    resultPath: RESULT_PATH,
  };

  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'data'),
      port,
      label: 'real-card-live-refresh',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'home'),
        AI_HUB_WORKSPACE_ROOT: path.join(TEMP_ROOT, 'workspaces'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''),
    );
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor('workspace controller', () => client.eval('!!(window.WorkspaceController && window.__hubE2E)'));

    const created = await client.eval(`window.WorkspaceController.createSession('codex', {
      cwd: ${JSON.stringify(APP_ROOT)},
      opts: {
        model: ${JSON.stringify(process.env.HUB_DIAG_CODEX_MODEL || 'gpt-5.6-sol')},
        effort: 'low', mcpProfile: 'lean', codexSpeedTier: 'inherit'
      },
    }).then(session => ({ id:session.id, kind:session.kind }))`);
    result.sessionId = created.id;
    await waitFor('renderer session', () => client.eval(`sessions.has(${JSON.stringify(created.id)})`), 20000);
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(created.id)}, { forceScrollBottom:true })`);
    await waitFor('Codex ready', () => client.eval(
      `window.__hubE2E.terminalLiveScreenText(${JSON.stringify(created.id)}).includes('Context ')`,
    ), 45000);

    await client.eval(`window.__hubE2E.cardQuestionNavigator.setViewMode('card')`);
    await waitFor('card composer', () => client.eval(`(() => {
      const input = document.querySelector('.floating-input-box');
      return !!input && getComputedStyle(document.getElementById('msg-overlay')).display !== 'none';
    })()`), 10000);
    result.before = await readCardState(client, created.id);

    const prompt = [
      `Before running the command, send one commentary update containing exactly ${STAGE_MARKER}.`,
      'Then run PowerShell Start-Sleep -Seconds 6.',
      `After it finishes, make the final answer exactly ${FINAL_MARKER}.`,
    ].join(' ');
    await client.eval(`(() => {
      const input = document.querySelector('.floating-input-box');
      input.textContent = ${JSON.stringify(prompt)};
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key:'Enter', code:'Enter', bubbles:true, cancelable:true,
      }));
      return input.textContent;
    })()`);

    result.running = await waitFor('Codex running in card view', async () => {
      const state = await readCardState(client, created.id);
      return state.sessionStatus === 'running' && state.currentView === 'card' ? state : null;
    }, 45000);

    result.stage = await waitFor('assistant stage marker without reselecting session', async () => {
      const state = await readCardState(client, created.id);
      return state.stageVisible ? { ...state, observedAt: Date.now() } : null;
    }, 60000);
    await capture(client, STAGE_SCREENSHOT);

    result.final = await waitFor('assistant final marker without reselecting session', async () => {
      const state = await readCardState(client, created.id);
      return state.finalVisible ? { ...state, observedAt: Date.now() } : null;
    }, 120000);
    await capture(client, FINAL_SCREENSHOT);

    assert.equal(result.stage.activeSessionId, created.id);
    assert.equal(result.stage.currentView, 'card');
    assert.equal(result.stage.stageVisible, true);
    assert.equal(result.final.finalVisible, true);
    assert.equal(result.stage.assistantCount, 1, 'streaming stage must not duplicate assistant cards');
    assert.equal(result.final.assistantCount, 1, 'final replacement must keep one assistant card');
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-real-card-live-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
