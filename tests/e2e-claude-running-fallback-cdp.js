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

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-running-fallback-${stamp}`);
  const port = await availablePort(Number(process.env.HUB_RUNNING_FALLBACK_E2E_PORT || 19731));
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({ dataDir, port, label: 'claude-running-fallback' });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));

    const readyDeadline = Date.now() + 20000;
    while (Date.now() < readyDeadline) {
      if (await client.eval("typeof onTerminalOutput === 'function' && typeof renderSessionList === 'function'")) break;
      await _waitMs(200);
    }

    const result = await client.eval(`(() => {
      const id = 'e2e-claude-running-fallback';
      const session = {
        id,
        kind: 'claude',
        title: 'Claude 状态兜底 E2E',
        status: 'idle',
        createdAt: Date.now(),
        lastMessageTime: Date.now(),
        lastOutputPreview: '',
        unreadCount: 0,
        cwd: 'C:\\\\Vibe\\\\_scratch\\\\running-fallback',
      };
      sessions.set(id, session);
      armPtyBurstFallback(id);
      onTerminalOutput(id, 201);
      renderSessionList();
      const row = Array.from(document.querySelectorAll('.session-item.slim'))
        .find(el => (el.querySelector('.sl-title')?.textContent || '').includes('Claude 状态兜底 E2E'));
      const fallback = {
        status: session.status,
        source: session._runSource,
        runDot: !!(row && row.querySelector('.sl-ring-dot.run')),
      };

      session.status = 'running';
      session._agentWorking = 'hook';
      session._runSource = 'semantic';
      onTerminalOutput(id, 1000);
      const semantic = { status: session.status, source: session._runSource };
      clearTerminalActivitySession(id);
      sessions.delete(id);
      renderSessionList();
      return { fallback, semantic };
    })()`);

    assert.deepEqual(result.fallback, { status: 'running', source: 'burst', runDot: true });
    assert.deepEqual(result.semantic, { status: 'running', source: 'semantic' });
    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, result }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-80).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { client.ws.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-running-fallback-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
