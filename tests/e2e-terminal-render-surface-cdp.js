'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

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

async function waitForEval(client, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${expression}`);
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-terminal-surface-${stamp}`);
  const port = await availablePort(Number(process.env.HUB_TERMINAL_E2E_PORT || 19541));
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'terminal-render-surface',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1365, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitForEval(client, 'window.__hubE2E && window.__hubE2E.selectSession');

    const result = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const api = window.__hubE2E;
      const electronIpc = require('electron').ipcRenderer;
      const now = Date.now();
      api.addFakeSession({ id: 'surface-a', kind: 'claude', title: 'Surface A', status: 'idle', createdAt: now, lastMessageTime: now });
      api.addFakeSession({ id: 'surface-b', kind: 'claude', title: 'Surface B', status: 'idle', createdAt: now + 1, lastMessageTime: now + 1 });

      await api.selectSession('surface-a');
      await wait(350);
      const first = terminalCache.get('surface-a');
      const lines = Array.from({ length: Math.max(12, Math.min(30, first.terminal.rows - 2)) }, (_, i) =>
        '\\x1b[3' + (i % 7 + 1) + 'mPTY_RENDER_ROW_' + String(i).padStart(2, '0') + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ\\x1b[0m'
      ).join('\\r\\n');
      electronIpc.emit('terminal-data', {}, { sessionId: 'surface-a', data: '\\x1b[2J\\x1b[H' + lines, seq: 1 });
      await wait(300);

      function canvasInk(cached) {
        let visibleSamples = 0;
        let sampledPixels = 0;
        let readableLayers = 0;
        const canvases = [...cached.container.querySelectorAll('.xterm-screen canvas')];
        for (const canvas of canvases) {
          const ctx = canvas.getContext('2d');
          if (!ctx || !canvas.width || !canvas.height) continue;
          readableLayers += 1;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const stride = Math.max(1, Math.floor((canvas.width * canvas.height) / 20000));
          for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += stride) {
            sampledPixels += 1;
            const offset = pixel * 4;
            if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 120) visibleSamples += 1;
          }
        }
        return { visibleSamples, sampledPixels, readableLayers, canvasCount: canvases.length };
      }

      const before = canvasInk(first);
      const refreshBefore = first._surfaceRefreshCount || 0;
      for (const canvas of first.container.querySelectorAll('.xterm-screen canvas')) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
      const cleared = canvasInk(first);

      showTerminal('surface-b', { focus: false });
      await wait(180);
      showTerminal('surface-a', { focus: false });
      await wait(350);

      const restored = terminalCache.get('surface-a');
      const after = canvasInk(restored);
      const screenRect = restored.container.querySelector('.xterm-screen').getBoundingClientRect();
      const containerRect = restored.container.getBoundingClientRect();
      return {
        before,
        cleared,
        after,
        refreshBefore,
        refreshAfter: restored._surfaceRefreshCount || 0,
        rows: restored.terminal.rows,
        cols: restored.terminal.cols,
        screenRect: { width: screenRect.width, height: screenRect.height },
        containerRect: { width: containerRect.width, height: containerRect.height },
        cache: api.terminalCacheStats(),
      };
    })()`);

    assert.ok(result.before.readableLayers >= 1, JSON.stringify(result));
    assert.ok(result.before.visibleSamples > 100, JSON.stringify(result));
    assert.strictEqual(result.cleared.visibleSamples, 0, JSON.stringify(result));
    assert.ok(result.refreshAfter > result.refreshBefore, JSON.stringify(result));
    assert.ok(result.after.visibleSamples > 100, JSON.stringify(result));
    assert.ok(result.after.visibleSamples >= result.before.visibleSamples * 0.5, JSON.stringify(result));
    assert.ok(result.screenRect.width > 500 && result.screenRect.height > 300, JSON.stringify(result));
    assert.ok(result.screenRect.width <= result.containerRect.width + 1, JSON.stringify(result));
    assert.ok(result.screenRect.height <= result.containerRect.height + 1, JSON.stringify(result));
    assert.ok(result.cache.size <= result.cache.max, JSON.stringify(result));

    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, result }, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    if (hub) console.error(hub.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-terminal-surface-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
