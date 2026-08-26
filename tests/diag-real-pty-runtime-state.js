'use strict';

// Manual, credential-backed diagnostic for the real Claude/Codex TUI path.
// It launches an isolated Hub/data directory and closes only that instance.
// Usage (Codex by default): node tests/diag-real-pty-runtime-state.js
// Full provider probe: $env:HUB_DIAG_PROVIDERS='claude,codex'; node tests/diag-real-pty-runtime-state.js

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
    // xterm.input reliably types into both TUIs, but Claude 2.1.241 can leave a
    // synthetic Enter in the renderer input path unsubmitted. Send the final
    // carriage return through the same IPC used by Hub's floating composer.
    setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: id, data: '\\r' }), 700);
    return true;
  })()`);

  let running;
  try {
    running = await waitFor(`${kind} running`, () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(id)});
      if (!session || session.status !== 'running') return null;
      // This diagnostic deliberately requires the live PTY classifier, not
      // merely the provider lifecycle event, so both evidence channels are proven.
      if (session._ptyRuntimeState !== 'running') return null;
      const status = document.querySelector('.terminal-header .terminal-status');
      const sidebar = document.querySelector('.session-item[data-session-id="' + CSS.escape(String(session.id)) + '"]');
      if (status?.dataset.runtimeState !== 'running' || sidebar?.dataset.runtimeState !== 'running') return null;
      return {
        status: session.status,
        source: session._runSource || null,
        agent: session._agentWorking || null,
        ptyState: session._ptyRuntimeState || null,
        ptyReason: session._ptyRuntimeReason || null,
        cardState: status?.dataset.runtimeState || null,
        cardLabel: status?.querySelector('.terminal-status-label')?.textContent || '',
        sidebarState: sidebar?.dataset.runtimeState || null,
        sidebarSource: sidebar?.dataset.runtimeSource || null,
        runtimeSource: session.runtimeTruth?.source || null,
        corroborations: (session.runtimeTruth?.corroborations || []).map(item => item.source),
      };
    })()`), 45000);
  } catch (error) {
    const diagnostic = await client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(id)});
      return {
        session: session ? {
          status: session.status,
          source: session._runSource || null,
          ptyState: session._ptyRuntimeState || null,
          ptyReason: session._ptyRuntimeReason || null,
        } : null,
        screen: window.__hubE2E.terminalLiveScreenText(${JSON.stringify(id)}),
      };
    })()`);
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic, null, 2)}`);
  }

  const done = await waitFor(`${kind} completed`, () => client.eval(`(() => {
    const id = ${JSON.stringify(id)};
    const session = sessions.get(id);
    const screen = window.__hubE2E.terminalLiveScreenText(id);
    const marker = ${JSON.stringify(marker)};
    const markerOccurrences = screen.split(marker).length - 1;
    const responseMarkerSeen = markerOccurrences >= 2;
    const blockedOnInput = session && session._ptyRuntimeState === 'waiting';
    const cardStatus = document.querySelector('.terminal-header .terminal-status');
    const cardState = cardStatus?.dataset.runtimeState || null;
    const cardLabel = cardStatus?.querySelector('.terminal-status-label')?.textContent || '';
    const sidebar = document.querySelector('.session-item[data-session-id="' + CSS.escape(String(id)) + '"]');
    if (!session || session.status !== 'idle' || (!responseMarkerSeen && !blockedOnInput)) return null;
    if (responseMarkerSeen && (cardState !== 'completed' || cardLabel !== '已完成')) return null;
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
      cardState,
      cardLabel,
      sidebarState: sidebar?.dataset.runtimeState || null,
      sidebarSource: sidebar?.dataset.runtimeSource || null,
      runtimeSource: session.runtimeTruth?.source || null,
      corroborations: (session.runtimeTruth?.corroborations || []).map(item => item.source),
      screen,
    };
  })()`), 120000);

  assert.equal(before.status, 'idle');
  assert.equal(running.status, 'running');
  assert.equal(running.cardState, 'running');
  assert.equal(running.cardLabel, '工作中');
  assert.equal(running.sidebarState, 'running');
  if (kind === 'codex') {
    const sources = [running.runtimeSource, ...running.corroborations].filter(Boolean).join(' ');
    assert.match(sources, /task_started/);
    assert.match(sources, /pty-codex-interrupt-footer/);
  }
  assert.equal(done.status, 'idle');
  if (done.responseMarkerSeen) {
    assert.equal(done.cardState, 'completed');
    assert.equal(done.cardLabel, '已完成');
    assert.equal(done.sidebarState, 'completed');
  }
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

    const requestedProviders = new Set(
      String(process.env.HUB_DIAG_PROVIDERS || 'codex')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const results = {};
    if (requestedProviders.has('claude')) {
      results.claude = await runSession(client, {
        kind: 'claude',
        prompt: 'Run PowerShell Start-Sleep -Seconds 4, then reply with exactly CLAUDE_PTY_RUNTIME_DONE.',
        marker: 'CLAUDE_PTY_RUNTIME_DONE',
        opts: {
          model: process.env.HUB_DIAG_CLAUDE_MODEL || 'claude-opus-5',
          effort: 'low',
          mcpProfile: 'lean',
          fastMode: false,
        },
      });
    }
    if (requestedProviders.has('codex')) {
      results.codex = await runSession(client, {
        kind: 'codex',
        prompt: 'Run PowerShell Start-Sleep -Seconds 5, then reply with exactly CODEX_PTY_RUNTIME_DONE.',
        marker: 'CODEX_PTY_RUNTIME_DONE',
        opts: {
          model: process.env.HUB_DIAG_CODEX_MODEL || 'gpt-5.6-sol',
          effort: 'low',
          mcpProfile: 'lean',
          codexSpeedTier: 'inherit',
        },
      });
    }

    const entries = Object.entries(results);
    const ok = entries.length > 0 && entries.every(([, value]) => value.done.responseMarkerSeen);
    const blockedProviders = entries
      .filter(([, value]) => value.done.blockedOnInput && !value.done.responseMarkerSeen)
      .map(([provider]) => provider);
    console.log(JSON.stringify({ ok, blockedProviders, port, hubPid: hub.pid, providers: [...requestedProviders], ...results }, null, 2));
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
