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

async function availablePort(start) {
  for (let port = start; port < start + 50; port += 1) if (await canListen(port)) return port;
  throw new Error('no free CDP port');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-long-transcript-e2e-'));
  const transcriptPath = path.join(root, 'synthetic-claude-transcript.jsonl');
  const fd = fs.openSync(transcriptPath, 'w');
  try {
    const answerPadding = 'x'.repeat(112 * 1024);
    for (let index = 0; index < 380; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 7, 20, 10, 0, index % 60)).toISOString();
      fs.writeSync(fd, `${JSON.stringify({
        type: 'user', uuid: `synthetic-user-${index}`, timestamp,
        message: { content: `Synthetic stress question ${index}` },
      })}\n`);
      fs.writeSync(fd, `${JSON.stringify({
        type: 'assistant', uuid: `synthetic-assistant-${index}`, timestamp,
        message: { model: 'claude-sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: `Synthetic answer ${index} ${answerPadding}` }] },
      })}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(fs.statSync(transcriptPath).size > 40 * 1024 * 1024, 'synthetic stress transcript must remain over 40MB');
  const port = await availablePort(19531);
  let hub;
  let client;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(root, 'data'),
      port,
      label: 'long-transcript-e2e',
      windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await _waitMs(500);
    const escaped = JSON.stringify(transcriptPath);
    const result = await client.eval(`(async () => {
      const ipc = require('electron').ipcRenderer;
      const path = ${escaped};
      let parseDone = false;
      const startedAt = performance.now();
      const parsePromise = ipc.invoke('parse-session-transcript', {
        kind: 'claude', transcriptPath: path, opts: { limit: 50, fromTail: true }
      }).then(value => { parseDone = true; return value; });
      const pingLatencies = [];
      while (!parseDone && performance.now() - startedAt < 3000) {
        const pingStartedAt = performance.now();
        await ipc.invoke('is-window-focused');
        pingLatencies.push(performance.now() - pingStartedAt);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const parsed = await parsePromise;
      const cacheStartedAt = performance.now();
      const cached = await ipc.invoke('parse-session-transcript', {
        kind: 'claude', transcriptPath: path, opts: { limit: 50, fromTail: true }
      });
      return {
        elapsedMs: performance.now() - startedAt,
        turns: parsed.turns.length,
        parseMs: parsed.parseMs,
        cacheHit: parsed.parseCacheHit,
        cacheElapsedMs: performance.now() - cacheStartedAt,
        secondCacheHit: cached.parseCacheHit,
        pingCount: pingLatencies.length,
        maxPingMs: Math.max(0, ...pingLatencies),
      };
    })()`);
    assert.ok(result.turns >= 30, JSON.stringify(result));
    assert.ok(result.pingCount >= 3, JSON.stringify(result));
    assert.ok(result.maxPingMs < 100, `main IPC stalled for ${result.maxPingMs}ms`);
    assert.equal(result.secondCacheHit, true, JSON.stringify(result));
    assert.ok(result.cacheElapsedMs < 100, JSON.stringify(result));
    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, result }, null, 2));
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
