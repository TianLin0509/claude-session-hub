'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitFor(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.eval(expression)) return;
    await _waitMs(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-floating-running-${stamp}`);
  const port = await availablePort(Number(process.env.HUB_FLOATING_RUNNING_E2E_PORT || 19781));
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'floating-input-running-state',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || '')
    );

    await waitFor(
      client,
      "typeof showTerminal === 'function' && typeof updateFloatingBarState === 'function'",
      'renderer ready'
    );

    await client.eval(`(() => {
      const id = 'e2e-floating-input-running-state';
      const originalSend = ipcRenderer.send.bind(ipcRenderer);
      window.__floatingRunningE2E = { id, originalSend, sends: [] };
      ipcRenderer.send = (channel, payload) => {
        if (channel === 'terminal-resize' || channel === 'terminal-input') {
          window.__floatingRunningE2E.sends.push({
            channel,
            payload: payload && typeof payload === 'object' ? { ...payload } : payload,
            at: Date.now(),
          });
        }
        return originalSend(channel, payload);
      };
      sessions.set(id, {
        id,
        kind: 'codex',
        title: '未发送草稿状态回归',
        status: 'idle',
        createdAt: Date.now(),
        lastMessageTime: Date.now(),
        lastOutputPreview: '',
        unreadCount: 0,
        cwd: 'C:\\\\Vibe\\\\_scratch\\\\floating-running-e2e',
      });
      activeMeetingId = null;
      activeSessionId = id;
      currentView = 'pty';
      showTerminal(id, { focus: false });
      renderSessionList();
      return true;
    })()`);

    await waitFor(
      client,
      `(() => {
        const state = window.__floatingRunningE2E;
        const cached = state && terminalCache.get(state.id);
        return !!(cached && cached._hydrated && document.querySelector('.floating-input-box'));
      })()`,
      'hydrated fake terminal'
    );

    // Let the initial mount/final hydration resize suppression expire so this
    // test observes only the resize caused by the multiline unsent draft.
    await _waitMs(1350);
    const before = await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      state.sends.length = 0;
      const cached = terminalCache.get(state.id);
      const input = document.querySelector('.floating-input-box');
      const bar = document.querySelector('.floating-input-bar');
      return {
        inputHeight: input.getBoundingClientRect().height,
        barHeight: bar.getBoundingClientRect().height,
        rows: cached.terminal.rows,
        resizeAt: Number(cached._lastPtyResizeAt) || 0,
      };
    })()`);

    await client.eval(`(() => {
      const input = document.querySelector('.floating-input-box');
      input.textContent = Array.from({ length: 10 }, (_, index) => '尚未发送的草稿第 ' + (index + 1) + ' 行').join('\\n');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    await waitFor(
      client,
      `(() => {
        const state = window.__floatingRunningE2E;
        const cached = terminalCache.get(state.id);
        const input = document.querySelector('.floating-input-box');
        const bar = document.querySelector('.floating-input-bar');
        return input.getBoundingClientRect().height > ${before.inputHeight}
          && bar.getBoundingClientRect().height === ${before.barHeight}
          && cached.terminal.rows === ${before.rows}
          && Number(cached._lastPtyResizeAt) === ${before.resizeAt}
          && !state.sends.some(item => item.channel === 'terminal-resize');
      })()`,
      'multiline composer growth without PTY resize'
    );

    await _waitMs(180);

    const suppressed = await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      const session = sessions.get(state.id);
      const cached = terminalCache.get(state.id);
      const input = document.querySelector('.floating-input-box');
      const bar = document.querySelector('.floating-input-bar');
      const stop = document.querySelector('.floating-input-stop');
      const header = document.querySelector('.terminal-header .terminal-status');
      return {
        inputHeight: input.getBoundingClientRect().height,
        barHeight: bar.getBoundingClientRect().height,
        rows: cached.terminal.rows,
        resizeCount: state.sends.filter(item => item.channel === 'terminal-resize').length,
        inputSendCount: state.sends.filter(item => item.channel === 'terminal-input').length,
        draft: input.textContent,
        status: session.status,
        source: session._runSource || null,
        stopVisible: stop.classList.contains('visible'),
        headerState: header.dataset.runtimeState,
        headerLabel: header.querySelector('.terminal-status-label')?.textContent || '',
      };
    })()`);

    assert.ok(suppressed.inputHeight > before.inputHeight, 'multiline draft should grow the composer');
    assert.equal(suppressed.barHeight, before.barHeight, 'multiline draft must keep the bar flex footprint stable');
    assert.equal(suppressed.rows, before.rows, 'multiline draft must not resize terminal rows');
    assert.equal(suppressed.resizeCount, 0, 'draft layout change must not send terminal-resize');
    assert.equal(suppressed.inputSendCount, 0, 'unsent draft must not send terminal input');
    assert.match(suppressed.draft, /第 10 行/);
    assert.deepEqual(
      {
        status: suppressed.status,
        source: suppressed.source,
        stopVisible: suppressed.stopVisible,
        headerState: suppressed.headerState,
        headerLabel: suppressed.headerLabel,
      },
      { status: 'idle', source: null, stopVisible: false, headerState: 'idle', headerLabel: '已就绪' }
    );

    // Outside the narrow resize window, retain the existing PTY fallback. It
    // may update status, but a low-confidence byte burst must not expose Ctrl+C.
    await _waitMs(1250);
    await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      const cached = terminalCache.get(state.id);
      armPtyBurstFallback(state.id);
      ipcRenderer.emit('terminal-data', {}, {
        sessionId: state.id,
        data: 'W'.repeat(260),
        seq: cached._hydratedSeq + 1,
      });
      return true;
    })()`);
    await waitFor(
      client,
      `(() => {
        const state = window.__floatingRunningE2E;
        const session = sessions.get(state.id);
        const header = document.querySelector('.terminal-header .terminal-status');
        return session.status === 'running'
          && session._runSource === 'burst'
          && header?.dataset.runtimeState === 'running'
          && header.querySelector('.terminal-status-label')?.textContent === '工作中';
      })()`,
      'burst state and header render'
    );

    const fallback = await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      const session = sessions.get(state.id);
      return {
        status: session.status,
        source: session._runSource || null,
        stopVisible: document.querySelector('.floating-input-stop').classList.contains('visible'),
        headerState: document.querySelector('.terminal-header .terminal-status').dataset.runtimeState,
        headerLabel: document.querySelector('.terminal-header .terminal-status-label').textContent,
      };
    })()`);
    assert.deepEqual(fallback, {
      status: 'running',
      source: 'burst',
      stopVisible: false,
      headerState: 'running',
      headerLabel: '工作中',
    });

    // Burst fallback is one-shot: after its normal quiet transition it enters
    // cooldown and an idle TUI repaint cannot move the row back to 运行中.
    await waitFor(
      client,
      `(() => {
        const state = window.__floatingRunningE2E;
        const session = sessions.get(state.id);
        const header = document.querySelector('.terminal-header .terminal-status');
        return session.status === 'idle'
          && !session._runSource
          && Number(session._ptyFallbackArmedUntil || 0) === 0
          && Number(session._ptyBurstCooldownUntil || 0) > Date.now()
          && header?.dataset.runtimeState === 'idle'
          && header.querySelector('.terminal-status-label')?.textContent === '已就绪';
      })()`,
      'burst quiet transition and cooldown'
    );
    await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      const cached = terminalCache.get(state.id);
      ipcRenderer.emit('terminal-data', {}, {
        sessionId: state.id,
        data: 'I'.repeat(300),
        seq: cached._hydratedSeq + 1,
      });
      return true;
    })()`);
    await waitFor(
      client,
      `(() => {
        const state = window.__floatingRunningE2E;
        const session = sessions.get(state.id);
        const header = document.querySelector('.terminal-header .terminal-status');
        return session.status === 'idle'
          && !session._runSource
          && Number(session._ptyFallbackArmedUntil || 0) === 0
          && Number(session._ptyBurstCooldownUntil || 0) > Date.now()
          && header?.dataset.runtimeState === 'idle'
          && header.querySelector('.terminal-status-label')?.textContent === '已就绪';
      })()`,
      'idle repaint suppressed during cooldown'
    );
    const cooled = await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      const session = sessions.get(state.id);
      return {
        status: session.status,
        source: session._runSource || null,
        armedUntil: Number(session._ptyFallbackArmedUntil) || 0,
        cooldownActive: Number(session._ptyBurstCooldownUntil) > Date.now(),
        stopVisible: document.querySelector('.floating-input-stop').classList.contains('visible'),
        headerState: document.querySelector('.terminal-header .terminal-status').dataset.runtimeState,
        headerLabel: document.querySelector('.terminal-header .terminal-status-label').textContent,
      };
    })()`);
    assert.deepEqual(cooled, {
      status: 'idle',
      source: null,
      armedUntil: 0,
      cooldownActive: true,
      stopVisible: false,
      headerState: 'idle',
      headerLabel: '已就绪',
    });

    // A semantic Codex/card signal is high-confidence work and should still
    // expose the interrupt control.
    const semantic = await client.eval(`(() => {
      const state = window.__floatingRunningE2E;
      markCodexCardWorking(state.id, 'task_started');
      updateFloatingBarState();
      return {
        stopVisible: document.querySelector('.floating-input-stop').classList.contains('visible'),
        headerState: document.querySelector('.terminal-header .terminal-status').dataset.runtimeState,
        headerLabel: document.querySelector('.terminal-header .terminal-status-label').textContent,
      };
    })()`);
    assert.deepEqual(semantic, { stopVisible: true, headerState: 'running', headerLabel: '工作中' });

    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, before, suppressed, fallback, cooled, semantic }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-80).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { client.ws.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-floating-running-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
