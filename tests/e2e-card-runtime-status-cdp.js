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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-runtime-status-${RUN_ID}`);
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-runtime-status');
const RUNNING_SHOT = path.join(ARTIFACT_DIR, `running-${RUN_ID}.png`);
const WAITING_SHOT = path.join(ARTIFACT_DIR, `waiting-${RUN_ID}.png`);
const COMPLETE_SHOT = path.join(ARTIFACT_DIR, `complete-${RUN_ID}.png`);
const COMPACT_SHOT = path.join(ARTIFACT_DIR, `compact-${RUN_ID}.png`);
const CLAUDE_RUNNING_SHOT = path.join(ARTIFACT_DIR, `claude-running-${RUN_ID}.png`);
const CLAUDE_WAITING_SHOT = path.join(ARTIFACT_DIR, `claude-waiting-${RUN_ID}.png`);
const CLAUDE_FAILED_SHOT = path.join(ARTIFACT_DIR, `claude-failed-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

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

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { lastError = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function setViewport(client, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await _waitMs(160);
}

async function screenshot(client, target) {
  const image = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(image.data, 'base64'));
}

async function readStatus(client) {
  return client.eval(`(() => {
    const rectOf = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const root = document.querySelector('.terminal-header .terminal-status');
    const inline = document.querySelector('#msg-overlay .streaming-indicator');
    const titleRow = document.querySelector('.terminal-title-row');
    const panel = document.getElementById('terminal-panel');
    const sidebarItem = activeSessionId
      ? document.querySelector('.session-item[data-session-id="' + CSS.escape(String(activeSessionId)) + '"]')
      : null;
    const statusRect = root?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    return {
      state: root?.dataset.runtimeState || null,
      label: root?.querySelector('.terminal-status-label')?.textContent || '',
      meta: root?.querySelector('.terminal-status-meta')?.textContent || '',
      title: root?.title || '',
      ariaLabel: root?.getAttribute('aria-label') || '',
      inlineLabel: inline?.dataset.label || '',
      inlineVisible: !!inline && inline.getBoundingClientRect().width > 0,
      cardMode: document.getElementById('terminal-panel')?.classList.contains('card-view-active') || false,
      headerClientWidth: titleRow?.clientWidth || 0,
      headerScrollWidth: titleRow?.scrollWidth || 0,
      statusVisible: !!statusRect && statusRect.width > 0 && statusRect.height > 0,
      statusInsidePanel: !!statusRect && !!panelRect
        && statusRect.left >= panelRect.left && statusRect.right <= panelRect.right,
      statusTopmost: (() => {
        if (!root || !statusRect) return false;
        const hit = document.elementFromPoint(
          statusRect.left + statusRect.width / 2,
          statusRect.top + statusRect.height / 2,
        );
        return hit === root || root.contains(hit);
      })(),
      sidebarState: sidebarItem?.dataset.runtimeState || null,
      sidebarSource: sidebarItem?.dataset.runtimeSource || null,
      sidebarConfidence: sidebarItem?.dataset.runtimeConfidence || null,
      sidebarTitle: sidebarItem?.title || '',
      rects: {
        status: rectOf(root),
        title: rectOf(document.querySelector('.terminal-title')),
        model: rectOf(document.querySelector('.terminal-model-badge')),
        recentCopy: rectOf(document.getElementById('recent-turn-copy')),
        notification: rectOf(document.getElementById('completion-notification-toggle')),
        viewToggle: rectOf(document.querySelector('.view-toggle')),
        titleRow: rectOf(titleRow),
      },
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
    screenshots: {
      running: RUNNING_SHOT,
      waiting: WAITING_SHOT,
      complete: COMPLETE_SHOT,
      compact: COMPACT_SHOT,
      claudeRunning: CLAUDE_RUNNING_SHOT,
      claudeWaiting: CLAUDE_WAITING_SHOT,
      claudeFailed: CLAUDE_FAILED_SHOT,
    },
  };

  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'data'),
      port,
      label: 'card-runtime-status',
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
    await client.send('Runtime.enable');
    await setViewport(client, 1440, 900);
    await waitFor('renderer shell', () => client.eval('!!(window.__hubE2E && window.LaunchCenter)'));
    await client.eval(`(() => {
      window.__cardRuntimeErrors = [];
      window.addEventListener('error', event => window.__cardRuntimeErrors.push(String(event.error || event.message || 'renderer error')));
      window.addEventListener('unhandledrejection', event => window.__cardRuntimeErrors.push(String(event.reason || 'unhandled rejection')));
    })()`);

    await client.eval(`(() => {
      const id = 'card-runtime-status-e2e';
      const startedAt = Date.now() - (12 * 60 * 1000 + 1000);
      sessions.set(id, {
        id,
        kind: 'codex',
        title: 'Codex 卡片运行状态验证',
        status: 'idle',
        createdAt: startedAt,
        lastMessageTime: startedAt,
        lastOutputPreview: '正在执行隔离状态验证',
        unreadCount: 0,
        cwd: ${JSON.stringify(ROOT)},
        currentModel: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-SOL' },
        runStartedAt: startedAt,
        _ptyRuntimeState: 'running',
        _ptyRuntimeReason: 'codex-interrupt-footer',
        _ptyRuntimeEvidence: '• Working (12m 01s • esc to interrupt)',
      });
      observeSessionRuntime(id, {
        state: 'running',
        source: 'pty-codex-interrupt-footer',
        confidence: 'strong',
        observedAt: Date.now(),
        startedAt,
        evidence: '• Working (12m 01s • esc to interrupt)',
      });
      activeMeetingId = null;
      activeSessionId = id;
      currentView = 'pty';
      showTerminal(id, { focus: false });
      _cardHistoryHydratedSid = id;
      applyViewMode('card');
      const overlay = document.getElementById('msg-overlay');
      overlay.replaceChildren();
      if (window._sessionTurns) window._sessionTurns.clear();
      mountSessionTurnCard(id, {
        id: 'assistant-runtime-anchor',
        role: 'assistant',
        text: '上一条回答已经生成；Codex 仍在继续执行后续工具任务。',
        ts: Date.now() - 13 * 60 * 1000,
        kind: 'codex',
      }, { kind: 'codex', autoScroll: true });
      _updateStreamingIndicator(id);
      updateFloatingBarState();
      renderSessionList();
      return true;
    })()`);

    result.running = await waitFor('visible running state', async () => {
      const state = await readStatus(client);
      return state.state === 'running' && state.label === '工作中'
        && /^12:0[1-9]$/.test(state.meta) && state.inlineLabel === '工作中'
        ? state : null;
    });
    assert.equal(result.running.cardMode, true);
    assert.equal(result.running.inlineVisible, true);
    assert.match(result.running.title, /esc to interrupt/);
    assert.equal(result.running.ariaLabel, 'Codex 工作中');
    assert.equal(result.running.sidebarState, 'running');
    assert.equal(result.running.sidebarSource, 'pty-codex-interrupt-footer');
    assert.equal(result.running.sidebarConfidence, 'strong');
    await screenshot(client, RUNNING_SHOT);

    const firstElapsed = result.running.meta;
    result.ticker = await waitFor('elapsed clock tick', async () => {
      const state = await readStatus(client);
      return state.state === 'running' && state.meta !== firstElapsed ? state.meta : null;
    }, 4000);

    await client.eval(`(() => {
      const session = sessions.get('card-runtime-status-e2e');
      session.status = 'idle';
      session.cardWorkingSince = null;
      session.cardWorkingSource = null;
      session._agentWorking = null;
      session._runSource = null;
      markSessionNeedsUserInput(session, {
        reason: 'pty-interactive-confirmation',
        text: 'Allow command execution? Enter to confirm · Esc to cancel',
      });
      observeSessionRuntime(session, {
        state: 'waiting',
        source: 'pty-interactive-confirmation',
        confidence: 'strong',
        observedAt: Date.now(),
        evidence: 'Allow command execution? Enter to confirm · Esc to cancel',
      });
      updateFloatingBarState();
      _updateStreamingIndicator(session.id);
      renderSessionList();
    })()`);
    await _waitMs(1700);
    result.waiting = await readStatus(client);
    assert.equal(result.waiting.state, 'waiting');
    assert.equal(result.waiting.label, '等待输入');
    assert.equal(result.waiting.inlineVisible, false);
    assert.match(result.waiting.title, /Allow command execution/);
    assert.equal(result.waiting.sidebarState, 'waiting');
    assert.equal(result.waiting.sidebarSource, 'pty-interactive-confirmation');
    await screenshot(client, WAITING_SHOT);

    await client.eval(`(() => {
      const session = sessions.get('card-runtime-status-e2e');
      const completedAt = Date.now();
      session.attentionState = 'reply-ready';
      session.needsUserInput = false;
      session.replyReady = true;
      session.isWaiting = false;
      session.lastCompletedAt = completedAt;
      session.lastRunDurationMs = 12 * 60 * 1000 + 4000;
      session.status = 'idle';
      observeSessionRuntime(session, {
        state: 'completed',
        source: 'codex-turn-complete',
        confidence: 'authoritative',
        observedAt: completedAt,
        completedAt,
        startedAt: completedAt - session.lastRunDurationMs,
      });
      updateFloatingBarState();
      renderSessionList();
    })()`);
    result.complete = await readStatus(client);
    assert.equal(result.complete.state, 'completed');
    assert.equal(result.complete.label, '已完成');
    assert.equal(result.complete.meta, '刚刚');
    assert.match(result.complete.title, /本轮用时 12:04/);
    assert.equal(result.complete.sidebarState, 'completed');
    assert.equal(result.complete.sidebarSource, 'codex-turn-complete');
    await screenshot(client, COMPLETE_SHOT);

    await setViewport(client, 760, 820);
    result.compact = await readStatus(client);
    assert.equal(result.compact.state, 'completed');
    assert.ok(result.compact.headerScrollWidth <= result.compact.headerClientWidth + 1, JSON.stringify(result.compact));
    assert.equal(result.compact.statusVisible, true);
    assert.equal(result.compact.statusInsidePanel, true);
    assert.equal(result.compact.statusTopmost, true, JSON.stringify(result.compact.rects));
    await screenshot(client, COMPACT_SHOT);

    await setViewport(client, 1440, 900);
    await client.eval(`(() => {
      const id = 'claude-runtime-truth-e2e';
      sessions.set(id, {
        id,
        kind: 'claude',
        title: 'Claude 统一运行态验证',
        status: 'idle',
        createdAt: Date.now(),
        lastMessageTime: Date.now(),
        lastOutputPreview: '',
        unreadCount: 0,
        cwd: ${JSON.stringify(ROOT)},
        currentModel: { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
      });
      activeSessionId = id;
      activeMeetingId = null;
      currentView = 'pty';
      showTerminal(id, { focus: false });
      _cardHistoryHydratedSid = id;
      applyViewMode('card');
      ipcRenderer.emit('hook-event', {}, {
        event: 'prompt', eventAt: Date.now(), sessionId: id,
        claudeSessionId: 'claude-native-runtime-e2e',
        latestUserMessage: '验证 Claude 统一运行态',
      });
      renderSessionList();
    })()`);
    result.claudeStarting = await waitFor('Claude starting truth', async () => {
      const state = await readStatus(client);
      return state.state === 'starting' && state.sidebarState === 'starting' ? state : null;
    });
    assert.equal(result.claudeStarting.sidebarSource, 'claude-user-prompt-submit');

    await client.eval(`(() => {
      const session = sessions.get('claude-runtime-truth-e2e');
      applyPtyRuntimeObservation(session, {
        state: 'running', reason: 'claude-active-status',
        evidence: '✻ Cultivating… (4s · ↓ 48 tokens)',
      }, Date.now());
      updateFloatingBarState();
      renderSessionList();
    })()`);
    result.claudeRunning = await waitFor('Claude PTY running truth', async () => {
      const state = await readStatus(client);
      return state.state === 'running' && state.sidebarState === 'running' ? state : null;
    });
    assert.equal(result.claudeRunning.sidebarSource, 'pty-claude-active-status');
    assert.equal(result.claudeRunning.sidebarConfidence, 'strong');
    await screenshot(client, CLAUDE_RUNNING_SHOT);

    await client.eval(`ipcRenderer.emit('hook-event', {}, {
      event: 'permission-request', eventAt: Date.now(),
      sessionId: 'claude-runtime-truth-e2e', toolName: 'PowerShell'
    })`);
    result.claudeWaiting = await waitFor('Claude permission waiting truth', async () => {
      const state = await readStatus(client);
      return state.state === 'waiting' && state.sidebarState === 'waiting' ? state : null;
    });
    assert.equal(result.claudeWaiting.sidebarSource, 'claude-permission-request');
    assert.equal(result.claudeWaiting.sidebarConfidence, 'authoritative');
    assert.equal(result.claudeWaiting.inlineVisible, false);
    await screenshot(client, CLAUDE_WAITING_SHOT);

    await client.eval(`(() => {
      const id = 'claude-runtime-truth-e2e';
      ipcRenderer.emit('hook-event', {}, {
        event: 'prompt', eventAt: Date.now(), sessionId: id,
        latestUserMessage: '继续后台任务验证'
      });
      ipcRenderer.emit('hook-event', {}, {
        event: 'stop', eventAt: Date.now() + 10, sessionId: id,
        lastAssistantMessage: '前台回答结束，后台任务继续',
        backgroundTasks: [{ id: 'bg-1', type: 'shell', status: 'running', description: 'tail logs' }],
        sessionCrons: []
      });
      renderSessionList();
    })()`);
    result.claudeBackground = await waitFor('Claude background task remains running', async () => {
      const state = await readStatus(client);
      return state.state === 'running' && state.sidebarSource === 'claude-background-tasks' ? state : null;
    });
    await _waitMs(650);
    await client.eval(`ipcRenderer.emit('hook-event', {}, {
      event: 'notification', eventAt: Date.now(), sessionId: 'claude-runtime-truth-e2e',
      notificationType: 'agent_completed', title: 'Background agent', message: 'Background task completed'
    })`);
    result.claudeCompleted = await waitFor('Claude background completion truth', async () => {
      const state = await readStatus(client);
      return state.state === 'completed' && state.sidebarState === 'completed' ? state : null;
    });
    assert.equal(result.claudeCompleted.sidebarSource, 'claude-stop');
    assert.equal(result.claudeCompleted.inlineVisible, false);

    await client.eval(`(() => {
      const id = 'claude-runtime-truth-e2e';
      ipcRenderer.emit('hook-event', {}, {
        event: 'prompt', eventAt: Date.now(), sessionId: id,
        latestUserMessage: '验证错误终态'
      });
      ipcRenderer.emit('hook-event', {}, {
        event: 'stop-failure', eventAt: Date.now() + 10, sessionId: id,
        error: 'rate_limit', errorDetails: '429 Too Many Requests',
        lastAssistantMessage: 'API Error: Rate limit reached'
      });
      renderSessionList();
    })()`);
    result.claudeFailed = await waitFor('Claude failure truth', async () => {
      const state = await readStatus(client);
      return state.state === 'failed' && state.sidebarState === 'failed' ? state : null;
    });
    assert.equal(result.claudeFailed.sidebarSource, 'claude-stop-failure');
    assert.match(result.claudeFailed.title, /429 Too Many Requests/);
    assert.equal(result.claudeFailed.inlineVisible, false);
    await screenshot(client, CLAUDE_FAILED_SHOT);

    await client.eval(`(() => {
      const session = sessions.get('claude-runtime-truth-e2e');
      session.lastError = null;
      const now = Date.now();
      observeSessionRuntime(session, {
        state: 'starting', source: 'e2e-expiring-start', confidence: 'semantic',
        observedAt: now, startedAt: now, expiresAt: now + 250,
      });
      window.__runtimeStaleResult = observeSessionRuntime(session, {
        state: 'completed', source: 'e2e-stale-complete', confidence: 'authoritative',
        observedAt: now - 1, completedAt: now - 1,
      });
      updateFloatingBarState();
      renderSessionList();
    })()`);
    result.expiredTruth = await waitFor('expired observation becomes unknown everywhere', async () => {
      const state = await readStatus(client);
      return state.state === 'unknown' && state.sidebarState === 'unknown' ? state : null;
    }, 3000);
    result.staleObservation = await client.eval('window.__runtimeStaleResult');
    assert.equal(result.staleObservation.applied, false);
    assert.equal(result.staleObservation.reason, 'stale-observation');
    assert.match(result.expiredTruth.sidebarSource, /^expired:e2e-expiring-start$/);

    await client.eval(`(() => {
      const id = 'gemini-runtime-truth-e2e';
      sessions.set(id, {
        id, kind: 'gemini', title: 'Gemini 统一运行态验证', status: 'idle',
        createdAt: Date.now(), lastMessageTime: Date.now(), lastOutputPreview: '',
        unreadCount: 0, cwd: ${JSON.stringify(ROOT)},
        currentModel: { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
      });
      activeSessionId = id;
      currentView = 'pty';
      showTerminal(id, { focus: false });
      _cardHistoryHydratedSid = id;
      applyViewMode('card');
      const cached = terminalCache.get(id);
      if (cached) cached._lastPtyResizeAt = 0;
      ipcRenderer.emit('prompt-submitted-event', {}, {
        hubSessionId: id, kind: 'gemini', text: 'Gemini runtime truth',
        submittedAt: Date.now(), turnId: 'gemini-turn-1', signalSource: 'user_message'
      });
      renderSessionList();
    })()`);
    result.geminiStarting = await waitFor('Gemini prompt enters starting', async () => {
      const state = await readStatus(client);
      return state.state === 'starting' && state.sidebarState === 'starting' ? state : null;
    });
    result.geminiBurstImmediate = await client.eval(`(() => {
      const cached = terminalCache.get('gemini-runtime-truth-e2e');
      if (cached) cached._lastPtyResizeAt = 0;
      onTerminalOutput('gemini-runtime-truth-e2e', 260);
      updateFloatingBarState();
      renderSessionList();
      const session = sessions.get('gemini-runtime-truth-e2e');
      return {
        status: session.status,
        source: session._runSource || null,
        fallbackArmedUntil: session._ptyFallbackArmedUntil || 0,
        truth: getSessionRuntimeTruth(session),
      };
    })()`);
    assert.equal(result.geminiBurstImmediate.truth.state, 'running', JSON.stringify(result.geminiBurstImmediate));
    result.geminiRunning = await waitFor('Gemini PTY output confirms running', async () => {
      const state = await readStatus(client);
      return state.state === 'running' && state.sidebarState === 'running' ? state : null;
    });
    assert.equal(result.geminiRunning.sidebarSource, 'gemini-pty-output-after-submit');
    await _waitMs(2300);
    result.geminiSilent = await readStatus(client);
    assert.equal(result.geminiSilent.state, 'running', 'Gemini silence alone must not mean completion');
    await client.eval(`ipcRenderer.emit('turn-complete-event', {}, {
      hubSessionId: 'gemini-runtime-truth-e2e', kind: 'gemini',
      text: 'Gemini completed', completedAt: Date.now(), turnId: 'gemini-turn-1'
    })`);
    result.geminiCompleted = await waitFor('Gemini authoritative completion', async () => {
      const state = await readStatus(client);
      return state.state === 'completed' && state.sidebarState === 'completed' ? state : null;
    });
    assert.equal(result.geminiCompleted.sidebarSource, 'gemini-turn-complete');

    result.rendererErrors = await client.eval('window.__cardRuntimeErrors || []');
    assert.deepEqual(result.rendererErrors, []);
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ...result, resultPath: RESULT_PATH }, null, 2));
  } finally {
    if (client) { try { client.ws.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
