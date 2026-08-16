'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${process.pid}-${Date.now()}`;
const DATA_DIR = path.join(os.tmpdir(), `hub-terminal-runtime-e2e-${RUN_ID}`);
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'terminal-runtime-state');
const SCREENSHOT = path.join(ARTIFACT_DIR, 'pty-runtime-running.png');
const CDP_PORT = Number(process.env.HUB_TERMINAL_RUNTIME_E2E_PORT || (18620 + (process.pid % 120)));

async function capture(client, filePath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'terminal-runtime-state',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(DATA_DIR, 'fake-home'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''),
    );
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1360,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const running = await client.eval(`(async () => {
      const deadline = Date.now() + 6000;
      while ((!window.__hubE2E || !document.getElementById('empty-state').dataset.homeReady) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const now = Date.now();
      window.__hubE2E.clearSessions();
      window.__hubE2E.addFakeSessions([
        {
          id: 'pty-codex', kind: 'codex', title: 'Codex PTY fallback', status: 'idle',
          _ptyFallbackArmedUntil: now + 60_000, runStartedAt: null, lastMessageTime: now - 1000,
        },
        {
          id: 'pty-claude', kind: 'claude', title: 'Claude hook fallback', status: 'running',
          _runSource: 'semantic', _agentWorking: 'hook', runStartedAt: now - 8000, lastMessageTime: now - 2000,
        },
      ]);
      const codex = window.__hubE2E.applyTerminalRuntimeFrame('pty-codex', [
        '› Run PowerShell Start-Sleep -Seconds 4, then reply with exactly PTY_STATE_DONE.',
        '• Working (6s • esc to interrupt)',
        '› Improve documentation in @filename',
        '  gpt-5.6-sol max fast · Context 100% left · C:\\\\Vibe\\\\repo',
      ], now);
      const claude = window.__hubE2E.applyTerminalRuntimeFrame('pty-claude', [
        '> Read package.json, then reply with exactly PTY_STATE_DONE.',
        '✻ Cultivating… (4s · ↓ 48 tokens)',
        '>',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ], now);
      await new Promise(resolve => setTimeout(resolve, 220));
      escapeToHome();
      await new Promise(resolve => setTimeout(resolve, 180));
      return {
        codex,
        claude,
        runningCount: document.getElementById('home-running-count').textContent,
        runningText: document.getElementById('home-lane-running').textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()`);

    assert.equal(running.codex.runtime.state, 'running');
    assert.equal(running.codex.status, 'running');
    assert.equal(running.codex.runSource, 'pty-semantic');
    assert.equal(running.claude.runtime.state, 'running');
    assert.equal(running.claude.status, 'running');
    assert.equal(running.runningCount, '2');
    assert.match(running.runningText, /Codex PTY fallback/);
    assert.match(running.runningText, /Claude hook fallback/);
    await capture(client, SCREENSHOT);

    const settled = await client.eval(`(async () => {
      const now = Date.now();
      const codex = window.__hubE2E.applyTerminalRuntimeFrame('pty-codex', [
        '• PTY_STATE_DONE',
        '› Improve documentation in @filename',
        '  gpt-5.6-sol max fast · Context 95% left · C:\\\\Vibe\\\\repo',
      ], now);
      const claude = window.__hubE2E.applyTerminalRuntimeFrame('pty-claude', [
        'What do you want to do?',
        '> 1. Stop and wait for limit to reset',
        '  2. Upgrade your plan',
        'Enter to confirm · Esc to cancel',
      ], now);
      await new Promise(resolve => setTimeout(resolve, 220));
      return {
        codex,
        claude,
        runningSections: Array.from(document.querySelectorAll('#session-list .session-sec-header'))
          .filter(row => row.textContent.includes('运行中')).length,
        homeRunningCount: document.getElementById('home-running-count').textContent,
        claudeAttention: sessions.get('pty-claude').attentionState,
        claudeWaiting: sessions.get('pty-claude').isWaiting,
        waitingText: document.getElementById('home-lane-waiting').textContent.replace(/\s+/g, ' ').trim(),
      };
    })()`);

    assert.equal(settled.codex.runtime.state, 'idle');
    assert.equal(settled.codex.status, 'idle');
    assert.equal(settled.claude.runtime.state, 'waiting');
    assert.equal(settled.claude.status, 'idle');
    assert.equal(settled.runningSections, 0);
    assert.equal(settled.homeRunningCount, '0');
    assert.equal(settled.claudeAttention, 'needs-input');
    assert.equal(settled.claudeWaiting, true);
    assert.match(settled.waitingText, /Claude hook fallback/);

    console.log(JSON.stringify({
      ok: true,
      pid: hub.pid,
      port: CDP_PORT,
      screenshot: SCREENSHOT,
      running,
      settled,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-80).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(DATA_DIR);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-terminal-runtime-e2e-')) {
      await fs.promises.rm(resolved, { recursive: true, force: true });
    }
  }
})();
