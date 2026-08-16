'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-codex-scrollback-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'output', 'playwright', 'codex-scrollback-preservation');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preserved-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(label, operation, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function writeFakeCodex() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const scriptPath = path.join(FAKE_BIN, 'fake-codex-scrollback.js');
  fs.writeFileSync(scriptPath, `'use strict';
const ESC = '\\x1b';
const out = value => process.stdout.write(value);
let emitted = false;
let timer = null;

function emitCodexFrame() {
  if (emitted) return;
  emitted = true;
  const rows = Math.max(12, Number(process.stdout.rows) || 30);
  const historyBottom = rows - 2;
  let frame = ESC + '[2J' + ESC + '[H';
  for (let row = 1; row <= historyBottom; row += 1) {
    frame += ESC + '[' + row + ';1HCODEX-HISTORY-' + String(row).padStart(3, '0');
  }
  frame += ESC + '[' + (rows - 1) + ';1HINPUT-OLD';
  frame += ESC + '[' + rows + ';1HSTATUS-OLD';
  out(frame);

  setTimeout(() => {
    const repaintFrom = Math.max(1, historyBottom - 2);
    // Codex wraps history insertion in DEC 2026 synchronized output. Windows
    // ConPTY consumes the region scroll, then emits the h/l boundary followed
    // by a home-based serialized repaint; this is the production byte shape
    // the Hub mitigation must recognize.
    out(ESC + '[?2026h'
      + ESC + '[1;' + historyBottom + 'r' + ESC + '[3S' + ESC + '[r'
      + ESC + '[' + repaintFrom + ';1H' + ESC + '[J'
      + ESC + '[' + (rows - 1) + ';1HINPUT-NEW'
      + ESC + '[' + rows + ';1HSCROLLBACK-PATCH-DONE'
      + ESC + '[?2026l');
  }, 120);
}

function scheduleFrame() {
  clearTimeout(timer);
  timer = setTimeout(emitCodexFrame, 500);
}

process.stdout.on('resize', scheduleFrame);
scheduleFrame();
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  fs.writeFileSync(
    path.join(FAKE_BIN, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    'utf8',
  );
}

const READ_STATE = sessionId => `(() => {
  const cached = terminalCache.get(${JSON.stringify(sessionId)});
  if (!cached || !cached._hydrated || !cached.terminal) return null;
  const terminal = cached.terminal;
  const buffer = terminal.buffer.normal;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    lines.push(line ? line.translateToString(true) : '');
  }
  const text = lines.join('\\n');
  const markers = [...text.matchAll(/CODEX-HISTORY-(\\d{3})/g)].map(match => match[1]);
  return {
    hydrated: cached._hydrated,
    markerCount: new Set(markers).size,
    firstMarker: markers[0] || null,
    lastMarker: markers.at(-1) || null,
    hasFirst: text.includes('CODEX-HISTORY-001'),
    hasDone: text.includes('SCROLLBACK-PATCH-DONE'),
    bufferLength: buffer.length,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    rows: terminal.rows,
    cols: terminal.cols,
  };
})()`;

async function main() {
  writeFakeCodex();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const port = await reservePort();
  const result = { runId: RUN_ID, port, screenshot: SCREENSHOT_PATH };
  let hub = null;
  let client = null;

  try {
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'codex-scrollback-preservation',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_NO_EFFORT_MAX: '1',
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => (
      target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || '')
    ));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 980,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor('Hub E2E API', () => client.eval(
      'Boolean(window.__hubE2E && window.__hubE2E.addFakeSession'
        + ' && document.getElementById("terminal-panel"))',
    ));

    const sessionId = 'e2e-codex-scrollback-preservation';
    await client.eval(`(async () => {
      window.__hubE2E.addFakeSession({
        id: ${JSON.stringify(sessionId)},
        kind: 'codex',
        title: 'Codex scrollback preservation',
        status: 'dormant',
        cwd: ${JSON.stringify(WORKSPACE_ROOT)},
        createdAt: Date.now() - 60000,
        lastMessageTime: Date.now() - 30000,
      });
      await window.__hubE2E.selectSession(${JSON.stringify(sessionId)}, { forceScrollBottom: true });
      return true;
    })()`);
    result.sessionId = sessionId;

    let lastLiveState = null;
    try {
      result.before = await waitFor('lossless live Codex frame', async () => {
        const state = await client.eval(READ_STATE(sessionId));
        if (state && typeof state === 'object' && !state.type) lastLiveState = state;
        if (!state || !state.hasDone || !state.hasFirst) return null;
        return state;
      }, 30000);
    } catch (error) {
      const diagnostics = await client.eval(`(async () => {
        const ipc = require('electron').ipcRenderer;
        const session = sessions.get(${JSON.stringify(sessionId)}) || null;
        const ring = String(await ipc.invoke('debug:get-session-buffer', ${JSON.stringify(sessionId)}) || '');
        return {
          session,
          cache: window.__hubE2E.terminalCacheStats(),
          ringLength: ring.length,
          ringTail: ring.slice(-1000),
        };
      })()`).catch(() => null);
      error.message += `\nlastState=${JSON.stringify(lastLiveState)}\ndiagnostics=${JSON.stringify(diagnostics)}`;
      error.logTail = hub.log().slice(-60).join('\n');
      throw error;
    }

    result.transformedRing = await client.eval(`(async () => {
      const raw = String(await require('electron').ipcRenderer.invoke(
        'debug:get-session-buffer', ${JSON.stringify(sessionId)}
      ) || '');
      const replacement = '\\x1b[r\\x1b[999;1H\\n\\n\\n\\x1b[H';
      return {
        hasOriginalScrollUp: raw.includes('\\x1b[3S'),
        hasSafeReplacement: raw.includes(replacement),
        length: raw.length,
      };
    })()`);

    const disposed = await client.eval(`window.__hubE2E.disposeTerminal(${JSON.stringify(sessionId)})`);
    assert.equal(disposed, true, 'isolated hook must dispose the live xterm');
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sessionId)}, { forceScrollBottom: true })`);
    result.afterRehydrate = await waitFor('lossless rehydrated Codex frame', async () => {
      const state = await client.eval(READ_STATE(sessionId));
      if (!state || !state.hasDone || !state.hasFirst) return null;
      return state;
    }, 30000);

    await client.eval(`(() => {
      const cached = terminalCache.get(${JSON.stringify(sessionId)});
      if (cached && cached.terminal) cached.terminal.scrollToTop();
      return true;
    })()`);
    await _waitMs(300);
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));

    assert.equal(result.transformedRing.hasOriginalScrollUp, false, JSON.stringify(result.transformedRing));
    assert.equal(result.transformedRing.hasSafeReplacement, true, JSON.stringify(result.transformedRing));
    assert.ok(result.before.markerCount >= result.before.rows - 2, JSON.stringify(result.before));
    assert.equal(result.before.hasFirst, true, JSON.stringify(result.before));
    assert.equal(result.afterRehydrate.hasFirst, true, JSON.stringify(result.afterRehydrate));
    assert.equal(result.afterRehydrate.markerCount, result.before.markerCount, JSON.stringify(result));

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, resultPath: RESULT_PATH, ...result }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  if (error && error.logTail) console.error('--- isolated Hub log tail ---\n' + error.logTail);
  process.exitCode = 1;
});
