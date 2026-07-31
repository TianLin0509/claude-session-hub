'use strict';

// Real isolated Hub regression for the two 2026-07-30 user reports:
//   1. a >1MB terminal survives xterm cache eviction without losing its old
//      scrollback or replaying from the middle of an ANSI sequence;
//   2. Kimi remains "running" while its main wire waits on an Agent tool call.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const RUN_ID = `${Date.now()}-${process.pid}`;
const ROOT = path.join(os.tmpdir(), `hub-pty-kimi-${RUN_ID}`);
const DATA_DIR = path.join(ROOT, 'hub-data');
const WORKSPACES = path.join(ROOT, 'workspaces');
const FAKE_BIN = path.join(ROOT, 'fake-bin');
const KIMI_HOME = path.join(ROOT, 'kimi-home');
const FIRST_CODEX_MARKER = path.join(ROOT, 'first-codex-created');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(KIMI_HOME, { recursive: true });

  fs.writeFileSync(path.join(FAKE_BIN, 'fake-codex.js'), `
const fs = require('fs');
const path = require('path');
const out = (text) => process.stdout.write(text);
let isLarge = false;
try { fs.closeSync(fs.openSync(process.env.FAKE_FIRST_CODEX_MARKER, 'wx')); isLarge = true; } catch {}
if (isLarge) {
  for (let i = 0; i < 6500; i++) {
    const marker = i === 0 ? 'FIRST-LONG-SESSION-LINE' : (i === 6499 ? 'LAST-LONG-SESSION-LINE' : 'line-' + i);
    // >1MB of raw PTY bytes while staying below 10k visual rows: repeated SGR
    // controls consume bytes but not cells, reproducing the old mid-ANSI cut.
    out('\\x1b[38;5;33m'.repeat(12) + marker + ' ' + 'x'.repeat(40) + '\\x1b[0m\\r\\n');
  }
  for (let i = 0; i < 80; i++) out('post-marker-' + i + '\\r\\n');
  out('\\x1b[2J\\x1b[HFINAL-FRAME-IS-COMPLETE\\r\\nREADY>');
} else {
  out('small session ' + path.basename(process.cwd()) + '\\r\\nREADY>');
}
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN, 'codex.cmd'),
    `@echo off\r\nnode "${path.join(FAKE_BIN, 'fake-codex.js')}" %*\r\n`, 'utf8');

  fs.writeFileSync(path.join(FAKE_BIN, 'fake-kimi.js'), `
const fs = require('fs');
const path = require('path');
const home = process.env.KIMI_CODE_HOME;
const sid = 'e2e-kimi-${RUN_ID}';
const sessionDir = path.join(home, 'sessions', 'e2e-work', sid);
const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
fs.mkdirSync(path.dirname(wire), { recursive: true });
fs.writeFileSync(wire, '', 'utf8');
const append = (record) => fs.appendFileSync(wire, JSON.stringify(record) + '\\n', 'utf8');
setTimeout(() => {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({
    sessionId: sid, sessionDir, workDir: process.cwd()
  }) + '\\n', 'utf8');
}, 400);
setTimeout(() => {
  append({ type: 'turn.prompt', input: [{ type: 'text', text: 'run background agent' }], origin: { kind: 'user' }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'agent-step', turnId: '0', step: 1 }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: {
    type: 'tool.call', stepUuid: 'agent-step', toolCallId: 'e2e-agent-job', name: 'Agent',
    args: { description: 'long coder job' }
  }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'agent-step', finishReason: 'tool_calls' }, time: Date.now() });
}, 1400);
setTimeout(() => {
  append({ type: 'context.append_loop_event', event: {
    type: 'tool.result', parentUuid: 'e2e-agent-job', toolCallId: 'e2e-agent-job', result: { output: 'done' }
  }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'final-step', turnId: '0', step: 2 }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: {
    type: 'content.part', stepUuid: 'final-step', part: { type: 'text', text: 'background complete' }
  }, time: Date.now() });
  append({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'final-step', finishReason: 'completed' }, time: Date.now() });
}, 6500);
process.stdout.write('fake kimi ready\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN, 'kimi.cmd'),
    `@echo off\r\nnode "${path.join(FAKE_BIN, 'fake-kimi.js')}" %*\r\n`, 'utf8');
}

function terminalTextExpression(sessionId) {
  return `(() => {
    const cached = terminalCache.get(${JSON.stringify(sessionId)});
    if (!cached || !cached._hydrated) return null;
    const buffer = cached.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const text = lines.join('\\n');
    return {
      text,
      bufferLength: buffer.length,
      viewportY: buffer.viewportY,
      rows: cached.terminal.rows,
      cacheSize: terminalCache.size,
    };
  })()`;
}

async function main() {
  writeFixtures();
  fs.mkdirSync(WORKSPACES, { recursive: true });
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port,
    label: 'pty-kimi-regression',
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACES,
      PATH: `${FAKE_BIN};${process.env.PATH}`,
      KIMI_CODE_HOME: KIMI_HOME,
      KIMI_CODE_BIN: path.join(FAKE_BIN, 'kimi.cmd'),
      FAKE_FIRST_CODEX_MARKER: FIRST_CODEX_MARKER,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
    },
  });

  let client = null;
  try {
    client = await waitFor('CDP page', async () => {
      try { return await connectFirstPage(hub); } catch { return null; }
    });
    await waitFor('WorkspaceController', () => client.eval(
      '!!(window.WorkspaceController && window.WorkspaceController.createScratch && window.WorkspaceController.createSession)'));
    await waitFor('hook server', () => hub.log().some((line) => line.includes('hook server listening')));

    const first = await client.eval(`(async () => {
      const workspace = await window.WorkspaceController.createScratch('s0-long');
      const session = await window.WorkspaceController.createSession('codex', { workspace });
      return { id: session.id };
    })()`);
    const before = await waitFor('large terminal output', async () => {
      const value = await client.eval(terminalTextExpression(first.id));
      return value && value.text.includes('FINAL-FRAME-IS-COMPLETE') ? value : null;
    }, 60000);
    assertContains(before.text, 'FIRST-LONG-SESSION-LINE', 'first marker before eviction');
    assertContains(before.text, 'LAST-LONG-SESSION-LINE', 'last marker before eviction');

    for (let i = 1; i <= 5; i++) {
      await client.eval(`(async () => {
        const workspace = await window.WorkspaceController.createScratch('s${i}-small');
        await window.WorkspaceController.createSession('codex', { workspace });
        return true;
      })()`);
      await _waitMs(500);
    }
    await waitFor('first terminal eviction', () => client.eval(
      `!terminalCache.has(${JSON.stringify(first.id)}) && terminalCache.size === 4`));
    await client.eval(`(() => { selectSession(${JSON.stringify(first.id)}, { forceScrollBottom: true }); return true; })()`);
    const restored = await waitFor('restored terminal snapshot', async () => {
      const value = await client.eval(terminalTextExpression(first.id));
      return value && value.text.includes('FINAL-FRAME-IS-COMPLETE') ? value : null;
    }, 60000);
    assertContains(restored.text, 'FIRST-LONG-SESSION-LINE', 'first marker after eviction');
    assertContains(restored.text, 'LAST-LONG-SESSION-LINE', 'last marker after eviction');
    assertContains(restored.text, 'FINAL-FRAME-IS-COMPLETE', 'final ANSI frame after eviction');

    const kimi = await client.eval(`(async () => {
      const workspace = await window.WorkspaceController.createScratch('kimi-agent');
      const session = await window.WorkspaceController.createSession('kimi', { workspace });
      return { id: session.id };
    })()`);
    const running = await waitFor('Kimi background running state', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(kimi.id)});
      if (!session || session.status !== 'running' || session.cardWorkingSource !== 'kimi_background_agent') return null;
      return { status: session.status, source: session.cardWorkingSource, jobs: session._kimiBackgroundJobs.size };
    })()`), 30000);
    const finished = await waitFor('Kimi background finished state', () => client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(kimi.id)});
      if (!session || session.status === 'running') return null;
      return { status: session.status, waiting: session.isWaiting, source: session.cardWorkingSource || null };
    })()`), 30000);

    console.log(JSON.stringify({
      smoke: 'hook server listening',
      terminal: {
        beforeLines: before.bufferLength,
        restoredLines: restored.bufferLength,
        cacheSize: restored.cacheSize,
        firstMarker: true,
        lastMarker: true,
        finalFrame: true,
      },
      kimi: { running, finished },
    }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

function assertContains(text, needle, label) {
  if (!String(text || '').includes(needle)) throw new Error(`missing ${label}: ${needle}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
