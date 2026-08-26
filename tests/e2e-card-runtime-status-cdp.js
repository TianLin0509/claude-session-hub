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
        status: 'running',
        createdAt: startedAt,
        lastMessageTime: startedAt,
        lastOutputPreview: '正在执行隔离状态验证',
        unreadCount: 0,
        cwd: ${JSON.stringify(ROOT)},
        currentModel: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-SOL' },
        runStartedAt: startedAt,
        cardWorkingSince: startedAt,
        cardWorkingSource: 'rollout_task_started',
        _agentWorking: 'card',
        _runSource: 'semantic',
        _ptyRuntimeState: 'running',
        _ptyRuntimeReason: 'codex-interrupt-footer',
        _ptyRuntimeEvidence: '• Working (12m 01s • esc to interrupt)',
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
      updateFloatingBarState();
      _updateStreamingIndicator(session.id);
    })()`);
    await _waitMs(1700);
    result.waiting = await readStatus(client);
    assert.equal(result.waiting.state, 'waiting');
    assert.equal(result.waiting.label, '等待输入');
    assert.equal(result.waiting.inlineVisible, false);
    assert.match(result.waiting.title, /Allow command execution/);
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
      updateFloatingBarState();
    })()`);
    result.complete = await readStatus(client);
    assert.equal(result.complete.state, 'complete');
    assert.equal(result.complete.label, '已完成');
    assert.equal(result.complete.meta, '刚刚');
    assert.match(result.complete.title, /本轮用时 12:04/);
    await screenshot(client, COMPLETE_SHOT);

    await setViewport(client, 760, 820);
    result.compact = await readStatus(client);
    assert.equal(result.compact.state, 'complete');
    assert.ok(result.compact.headerScrollWidth <= result.compact.headerClientWidth + 1, JSON.stringify(result.compact));
    assert.equal(result.compact.statusVisible, true);
    assert.equal(result.compact.statusInsidePanel, true);
    assert.equal(result.compact.statusTopmost, true, JSON.stringify(result.compact.rects));
    await screenshot(client, COMPACT_SHOT);

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
