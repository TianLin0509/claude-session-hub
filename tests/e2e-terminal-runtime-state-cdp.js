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
      windowMode: 'hidden',
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
        {
          id: 'pty-codex-revive', kind: 'codex', title: 'Codex live-screen repair', status: 'idle',
          runtimeTruth: {
            state: 'completed', source: 'pty-codex-input-ready', confidence: 'strong',
            observedAt: now - 1000, completedAt: now - 1000, sequence: 1,
          },
          _ptyFallbackArmedUntil: 0, lastMessageTime: now - 1500,
        },
        {
          id: 'pty-codex-monitor-revive', kind: 'codex', title: 'Codex real monitor repair', status: 'idle',
          runtimeTruth: {
            state: 'completed', source: 'pty-codex-input-ready', confidence: 'strong',
            observedAt: now - 1000, completedAt: now - 1000, sequence: 1,
          },
          _ptyFallbackArmedUntil: 0, lastMessageTime: now - 1600,
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
      const repaired = window.__hubE2E.applyTerminalRuntimeFrame('pty-codex-revive', [
        '• Working (2m 01s • esc to interrupt)',
        '› Improve documentation in @filename',
        '  gpt-5.6-sol max fast · Context 69% left · C:\\\\Vibe\\\\repo',
      ], now);

      // Exercise the real renderer path instead of the direct classifier test
      // helper above: terminal-data -> xterm -> onTerminalOutput -> delayed
      // live-screen probe -> RuntimeTruth/sidebar. This is the exact gate that
      // missed the production AI插件移动端可行性分析 session.
      const monitoredId = 'pty-codex-monitor-revive';
      activeSessionId = monitoredId;
      activeMeetingId = null;
      currentView = 'pty';
      showTerminal(monitoredId, { focus: false });
      const hydrateDeadline = Date.now() + 3000;
      while (!terminalCache.get(monitoredId)?._hydrated && Date.now() < hydrateDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const monitoredCache = terminalCache.get(monitoredId);
      if (!monitoredCache || !monitoredCache._hydrated) throw new Error('monitor test terminal did not hydrate');
      monitoredCache._lastPtyResizeAt = 0;
      const monitoredFrame = '\\x1b[2J\\x1b[H' + [
        '• Running .\\gradlew.bat --no-daemon :app:testDebugUnitTest',
        '• Working (25s • esc to interrupt)',
        '› Use /skills to list available skills',
        '  gpt-5.6-sol max fast · Context 92% left · C:\\\\Vibe\\\\repo',
      ].join('\\r\\n');
      ipcRenderer.emit('terminal-data', {}, {
        sessionId: monitoredId,
        data: monitoredFrame,
        seq: Number(monitoredCache._hydratedSeq || 0) + 100,
      });
      await new Promise(resolve => setTimeout(resolve, 750));
      const monitoredSession = sessions.get(monitoredId);
      const monitored = {
        status: monitoredSession.status,
        runSource: monitoredSession._runSource || null,
        agentWorking: monitoredSession._agentWorking || null,
        runtime: getSessionRuntimeTruth(monitoredSession),
        liveScreen: terminalActivityMonitor.extractLiveScreenLines(monitoredId),
      };
      await new Promise(resolve => setTimeout(resolve, 220));
      escapeToHome();
      await new Promise(resolve => setTimeout(resolve, 180));
      return {
        codex,
        claude,
        repaired,
        monitored,
        activeCount: document.getElementById('home-metric-active').textContent,
        runningSidebarText: document.getElementById('session-list').textContent.replace(/\\s+/g, ' ').trim(),
        pipelineAbsent: !document.getElementById('home-flow-columns'),
      };
    })()`);

    assert.equal(running.codex.runtime.state, 'running');
    assert.equal(running.codex.status, 'running');
    assert.equal(running.codex.runSource, 'pty-semantic');
    assert.equal(running.claude.runtime.state, 'running');
    assert.equal(running.claude.status, 'running');
    assert.equal(running.repaired.status, 'running');
    assert.equal(running.repaired.runSource, 'pty-semantic');
    assert.equal(running.monitored.status, 'running');
    assert.equal(running.monitored.runSource, 'pty-semantic');
    assert.equal(running.monitored.agentWorking, 'pty');
    assert.equal(running.monitored.runtime.state, 'running');
    assert.match(running.monitored.runtime.evidence, /Working \(25s .*esc to interrupt\)/);
    assert.equal(running.activeCount, '4');
    assert.equal(running.pipelineAbsent, true);
    assert.match(running.runningSidebarText, /Codex PTY fallback/);
    assert.match(running.runningSidebarText, /Claude hook fallback/);
    assert.match(running.runningSidebarText, /Codex live-screen repair/);
    assert.match(running.runningSidebarText, /Codex real monitor repair/);
    await capture(client, SCREENSHOT);

    const settled = await client.eval(`(async () => {
      const now = Date.now();
      const codexFirst = window.__hubE2E.applyTerminalRuntimeFrame('pty-codex', [
        '• PTY_STATE_DONE',
        '› Improve documentation in @filename',
        '  gpt-5.6-sol max fast · Context 95% left · C:\\\\Vibe\\\\repo',
      ], now);
      const codex = window.__hubE2E.applyTerminalRuntimeFrame('pty-codex', [
        '• PTY_STATE_DONE',
        '› Improve documentation in @filename',
        '  gpt-5.6-sol max fast · Context 95% left · C:\\\\Vibe\\\\repo',
      ], now + 2100);
      const claude = window.__hubE2E.applyTerminalRuntimeFrame('pty-claude', [
        'What do you want to do?',
        '> 1. Stop and wait for limit to reset',
        '  2. Upgrade your plan',
        'Enter to confirm · Esc to cancel',
      ], now);

      // The same real monitor path must also settle once the structured work
      // row disappears and the input-ready frame remains stable.
      const monitoredCache = terminalCache.get('pty-codex-monitor-revive');
      if (!monitoredCache) throw new Error('monitor test terminal disappeared before settle');
      monitoredCache._lastPtyResizeAt = 0;
      const monitoredIdleFrame = '\\x1b[2J\\x1b[H' + [
        '• BUILD_AND_TEST_DONE',
        '› Use /skills to list available skills',
        '  gpt-5.6-sol max fast · Context 91% left · C:\\\\Vibe\\\\repo',
      ].join('\\r\\n');
      ipcRenderer.emit('terminal-data', {}, {
        sessionId: 'pty-codex-monitor-revive',
        data: monitoredIdleFrame,
        seq: Number(monitoredCache._hydratedSeq || 0) + 100,
      });
      await new Promise(resolve => setTimeout(resolve, 2700));
      const monitoredSettledSession = sessions.get('pty-codex-monitor-revive');
      const monitoredSettled = {
        status: monitoredSettledSession.status,
        runSource: monitoredSettledSession._runSource || null,
        agentWorking: monitoredSettledSession._agentWorking || null,
        runtime: getSessionRuntimeTruth(monitoredSettledSession),
      };
      sessions.delete('pty-codex-revive');
      sessions.delete('pty-codex-monitor-revive');
      if (monitoredCache) {
        try { monitoredCache.terminal.dispose(); } catch {}
        terminalCache.delete('pty-codex-monitor-revive');
      }
      renderSessionList();
      await new Promise(resolve => setTimeout(resolve, 220));
      return {
        codex,
        codexFirst,
        claude,
        monitoredSettled,
        runningSections: Array.from(document.querySelectorAll('#session-list .session-sec-header'))
          .filter(row => row.textContent.includes('运行中')).length,
        homeWaitingCount: document.getElementById('home-metric-waiting').textContent,
        homePipelineAbsent: !document.getElementById('home-flow-columns'),
        claudeAttention: sessions.get('pty-claude').attentionState,
        claudeWaiting: sessions.get('pty-claude').isWaiting,
        sidebarText: document.getElementById('session-list').textContent.replace(/\s+/g, ' ').trim(),
      };
    })()`);

    assert.equal(settled.codex.runtime.state, 'idle');
    assert.equal(settled.codexFirst.status, 'running', 'one transient input-ready frame must not close an active turn');
    assert.equal(settled.codex.status, 'idle');
    assert.equal(settled.claude.runtime.state, 'waiting');
    assert.equal(settled.claude.status, 'idle');
    assert.equal(settled.monitoredSettled.runtime.state, 'completed');
    assert.equal(settled.monitoredSettled.status, 'idle');
    assert.equal(settled.monitoredSettled.runSource, null);
    assert.equal(settled.monitoredSettled.agentWorking, null);
    assert.equal(settled.runningSections, 0);
    assert.equal(settled.homeWaitingCount, '1');
    assert.equal(settled.homePipelineAbsent, true);
    assert.equal(settled.claudeAttention, 'needs-input');
    assert.equal(settled.claudeWaiting, true);
    assert.match(settled.sidebarText, /Claude hook fallback/);

    const failureAck = await client.eval(`(async () => {
      const now = Date.now();
      const message = 'stream disconnected before completion: ECONNRESET';
      window.__hubE2E.clearSessions();
      window.__hubE2E.addFakeSession({
        id: 'failure-ack', kind: 'codex', title: 'Acknowledged disconnect',
        status: 'running', runStartedAt: now - 5000, lastMessageTime: now,
      });
      const first = window.__hubE2E.applyStreamFailure('failure-ack', message, { observedAt: now });
      await new Promise(resolve => setTimeout(resolve, 220));
      const firstSidebar = document.getElementById('session-list').textContent.replace(/\\s+/g, ' ').trim();

      const staleWorking = window.__hubE2E.applyTerminalRuntimeFrame('failure-ack', [
        '• Working (25s • esc to interrupt)',
        '› Improve documentation in @filename',
        '  gpt-5.6-sol max fast · Context 92% left · C:\\\\Vibe\\\\repo',
      ], now + 100);
      const afterStaleWorking = getSessionRuntimeTruth(sessions.get('failure-ack'));

      const acknowledged = window.__hubE2E.acknowledgeSessionFailure('failure-ack');
      await new Promise(resolve => setTimeout(resolve, 220));
      const acknowledgedSidebar = document.getElementById('session-list').textContent.replace(/\\s+/g, ' ').trim();

      sessions.get('failure-ack').runStartedAt = now + 1000;
      const redraw = window.__hubE2E.applyStreamFailure('failure-ack', message, { observedAt: now + 2000 });
      await new Promise(resolve => setTimeout(resolve, 220));
      const redrawSidebar = document.getElementById('session-list').textContent.replace(/\\s+/g, ' ').trim();

      const genuine = window.__hubE2E.applyStreamFailure('failure-ack', message, {
        observedAt: now + 3000,
        authoritative: true,
        turnId: 'turn-new-failure',
        occurrenceId: 'turn-new-failure:3000',
      });
      await new Promise(resolve => setTimeout(resolve, 220));
      const genuineSidebar = document.getElementById('session-list').textContent.replace(/\\s+/g, ' ').trim();
      window.__hubE2E.acknowledgeSessionFailure('failure-ack');
      return {
        first, staleWorking, afterStaleWorking, acknowledged, redraw, genuine,
        firstSidebar, acknowledgedSidebar, redrawSidebar, genuineSidebar,
      };
    })()`);

    assert.equal(failureAck.first.raised, true);
    assert.match(failureAck.firstSidebar, /运行异常/);
    assert.equal(failureAck.staleWorking.runtime.state, 'running', 'fixture must contain a recognizable live marker');
    assert.equal(failureAck.staleWorking.changed, false, 'a stale work row must not erase a failed turn');
    assert.equal(failureAck.staleWorking.status, 'error');
    assert.equal(failureAck.afterStaleWorking.state, 'failed');
    assert.equal(failureAck.acknowledged, true);
    assert.doesNotMatch(failureAck.acknowledgedSidebar, /运行异常/);
    assert.equal(failureAck.redraw.raised, false, 'a new turn repaint must not resurrect an acknowledged old failure');
    assert.doesNotMatch(failureAck.redrawSidebar, /运行异常/);
    assert.equal(failureAck.genuine.raised, true, 'a new authoritative failure occurrence must notify again');
    assert.match(failureAck.genuineSidebar, /运行异常/);

    console.log(JSON.stringify({
      ok: true,
      pid: hub.pid,
      port: CDP_PORT,
      screenshot: SCREENSHOT,
      running,
      settled,
      failureAck,
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
