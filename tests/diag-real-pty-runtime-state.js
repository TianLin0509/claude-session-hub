'use strict';

// Manual, credential-backed diagnostic for the real Claude/Codex TUI path.
// It launches an isolated Hub/data directory and closes only that instance.
// Usage: node tests/diag-real-pty-runtime-state.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-real-runtime-${process.pid}-${Date.now()}`);

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
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(150);
  }
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function runSession(client, { kind, prompt, marker, opts }) {
  const created = await client.eval(`window.WorkspaceController.createSession(${JSON.stringify(kind)}, {
    cwd: ${JSON.stringify(path.resolve(__dirname, '..'))},
    opts: ${JSON.stringify(opts)},
  }).then(session => ({ id: session.id, kind: session.kind }))`);
  const id = created.id;
  await waitFor(`${kind} renderer session`, () => client.eval(`sessions.has(${JSON.stringify(id)})`), 20000);
  await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(id)}, { forceScrollBottom: true })`);
  const readyPattern = kind === 'codex' ? 'Context ' : 'shift+tab';
  await waitFor(`${kind} ready`, () => client.eval(
    `window.__hubE2E.terminalLiveScreenText(${JSON.stringify(id)}).includes(${JSON.stringify(readyPattern)})`,
  ), 40000);

  const before = await client.eval(`(() => {
    const session = sessions.get(${JSON.stringify(id)});
    return { status: session.status, source: session._runSource || null };
  })()`);
  await client.eval(`(() => {
    const id = ${JSON.stringify(id)};
    const cached = terminalCache.get(id);
    if (!cached) throw new Error('terminal missing');
    cached.terminal.input(${JSON.stringify(prompt)}, true);
    setTimeout(() => cached.terminal.input('\\r', true), 450);
    return true;
  })()`);

  const running = await waitFor(`${kind} running`, () => client.eval(`(() => {
    const session = sessions.get(${JSON.stringify(id)});
    if (!session || session.status !== 'running') return null;
    if (session._ptyRuntimeState !== 'running' && session._runSource !== 'semantic') return null;
    return {
      status: session.status,
      source: session._runSource || null,
      agent: session._agentWorking || null,
      ptyState: session._ptyRuntimeState || null,
      ptyReason: session._ptyRuntimeReason || null,
    };
  })()`), 45000);

  const done = await waitFor(`${kind} completed`, () => client.eval(`(() => {
    const id = ${JSON.stringify(id)};
    const session = sessions.get(id);
    const screen = window.__hubE2E.terminalLiveScreenText(id);
    const marker = ${JSON.stringify(marker)};
    const markerOccurrences = screen.split(marker).length - 1;
    const responseMarkerSeen = markerOccurrences >= 2;
    const blockedOnInput = session && session._ptyRuntimeState === 'waiting';
    if (!session || session.status !== 'idle' || (!responseMarkerSeen && !blockedOnInput)) return null;
    return {
      status: session.status,
      source: session._runSource || null,
      agent: session._agentWorking || null,
      ptyState: session._ptyRuntimeState || null,
      ptyReason: session._ptyRuntimeReason || null,
      ptyEvidence: session._ptyRuntimeEvidence || null,
      attentionState: session.attentionState || null,
      needsUserInput: session.needsUserInput === true,
      isWaiting: session.isWaiting === true,
      markerOccurrences,
      responseMarkerSeen,
      blockedOnInput,
      screen,
    };
  })()`), 120000);

  assert.equal(before.status, 'idle');
  assert.equal(running.status, 'running');
  assert.equal(done.status, 'idle');
  return { id, before, running, done };
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(ROOT, 'data'),
      port,
      label: 'real-pty-runtime',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'fake-home'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''),
    );
    await waitFor('workspace controller', () => client.eval('!!(window.WorkspaceController && window.__hubE2E)'));

    const claude = await runSession(client, {
      kind: 'claude',
      prompt: 'Run PowerShell Start-Sleep -Seconds 4, then reply with exactly CLAUDE_PTY_RUNTIME_DONE.',
      marker: 'CLAUDE_PTY_RUNTIME_DONE',
      opts: {
        model: process.env.HUB_DIAG_CLAUDE_MODEL || 'claude-fable-5',
        effort: 'low',
        mcpProfile: 'lean',
        fastMode: false,
      },
    });
    const codex = await runSession(client, {
      kind: 'codex',
      prompt: 'Run PowerShell Start-Sleep -Seconds 3, then reply with exactly CODEX_PTY_RUNTIME_DONE.',
      marker: 'CODEX_PTY_RUNTIME_DONE',
      opts: {
        model: process.env.HUB_DIAG_CODEX_MODEL || 'gpt-5.6-sol',
        effort: 'low',
        mcpProfile: 'lean',
        codexSpeedTier: 'inherit',
      },
    });

    const ok = claude.done.responseMarkerSeen && codex.done.responseMarkerSeen;
    const blockedProviders = [
      claude.done.blockedOnInput && !claude.done.responseMarkerSeen ? 'claude' : null,
      codex.done.blockedOnInput && !codex.done.responseMarkerSeen ? 'codex' : null,
    ].filter(Boolean);
    console.log(JSON.stringify({ ok, blockedProviders, port, hubPid: hub.pid, claude, codex }, null, 2));
  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-real-runtime-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
