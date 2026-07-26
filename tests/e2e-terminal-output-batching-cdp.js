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

async function waitForEval(client, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${expression}`);
}

async function waitForResult(client, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(expression)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for async result: ${expression}`);
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-terminal-batch-${stamp}`);
  const workDir = path.join(dataDir, 'work');
  const port = await availablePort(Number(process.env.HUB_TERMINAL_BATCH_E2E_PORT || 19591));
  let hub = null;
  let client = null;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'terminal-output-batching',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await waitForEval(client, 'window.__hubE2E && window.__hubE2E.terminalCacheStats');

    const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'powershell',
      opts: { title: 'PTY batching E2E', cwd: ${JSON.stringify(workDir)} }
    })`);
    assert.ok(session && session.id, JSON.stringify(session));
    await waitForEval(client, `activeSessionId === ${JSON.stringify(session.id)} && terminalCache.get(${JSON.stringify(session.id)})?._hydrated`);
    await waitForResult(client, `(async () => String(await require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(session.id)})).length > 40)()`);
    await _waitMs(500);
    await waitForResult(client, `(async () => (await require('electron').ipcRenderer.invoke('debug:get-terminal-output-batch-stats')).pendingSessions === 0)()`);

    const statsBefore = await client.eval("require('electron').ipcRenderer.invoke('debug:get-terminal-output-batch-stats')");
    const command = "1..300 | ForEach-Object { [Console]::WriteLine(('PTY_BATCH_{0:D4}' -f $_)) }; [Console]::WriteLine('PTY_BATCH_DONE')\r";
    await client.eval(`(() => {
      require('electron').ipcRenderer.send('terminal-input', {
        sessionId: ${JSON.stringify(session.id)},
        data: ${JSON.stringify(command)}
      });
      return true;
    })()`);

    await waitForResult(client, `(async () => {
      const text = String(await require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(session.id)}));
      return text.includes('PTY_BATCH_0300') && text.lastIndexOf('PTY_BATCH_DONE') > text.indexOf('PTY_BATCH_0300');
    })()`, 30000);
    await waitForEval(client, `(() => {
      const cached = terminalCache.get(${JSON.stringify(session.id)});
      if (!cached) return false;
      const buffer = cached.terminal.buffer.active;
      for (let i = Math.max(0, buffer.length - 40); i < buffer.length; i += 1) {
        if ((buffer.getLine(i)?.translateToString(true) || '').includes('PTY_BATCH_DONE')) return true;
      }
      return false;
    })()`, 30000);
    await _waitMs(500);

    const statsAfter = await client.eval("require('electron').ipcRenderer.invoke('debug:get-terminal-output-batch-stats')");
    const rendered = await client.eval(`(() => {
      const cached = terminalCache.get(${JSON.stringify(session.id)});
      const buffer = cached.terminal.buffer.active;
      const lines = [];
      for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) || '');
      return {
        text: lines.join('\\n'),
        cols: cached.terminal.cols,
        rows: cached.terminal.rows,
        cache: window.__hubE2E.terminalCacheStats(),
      };
    })()`);

    const delta = {
      pushedChunks: statsAfter.pushedChunks - statsBefore.pushedChunks,
      emittedBatches: statsAfter.emittedBatches - statsBefore.emittedBatches,
      inputBytes: statsAfter.inputBytes - statsBefore.inputBytes,
      outputBytes: statsAfter.outputBytes - statsBefore.outputBytes,
      maxBatchChunks: statsAfter.maxBatchChunks,
    };
    const orderProbe = {
      first: rendered.text.indexOf('PTY_BATCH_0001'),
      last: rendered.text.indexOf('PTY_BATCH_0300'),
      done: rendered.text.lastIndexOf('PTY_BATCH_DONE'),
      textLength: rendered.text.length,
      head: rendered.text.slice(0, 500),
      tail: rendered.text.slice(-500),
    };
    assert.ok(delta.pushedChunks >= 1, JSON.stringify({ statsBefore, statsAfter }));
    assert.ok(delta.emittedBatches >= 1, JSON.stringify({ statsBefore, statsAfter }));
    assert.ok(delta.emittedBatches <= delta.pushedChunks, JSON.stringify(delta));
    assert.strictEqual(delta.outputBytes, delta.inputBytes, JSON.stringify(delta));
    assert.ok(orderProbe.first >= 0 && orderProbe.first < orderProbe.last, JSON.stringify(orderProbe));
    assert.ok(orderProbe.last < orderProbe.done, JSON.stringify(orderProbe));
    assert.ok(rendered.cols > 20 && rendered.rows > 10, JSON.stringify(rendered));
    assert.ok(rendered.cache.size <= rendered.cache.max, JSON.stringify(rendered.cache));

    await client.eval(`require('electron').ipcRenderer.invoke('close-session', ${JSON.stringify(session.id)})`);
    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, delta, rendered: { cols: rendered.cols, rows: rendered.rows, cache: rendered.cache } }, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    if (hub) console.error(hub.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-terminal-batch-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
