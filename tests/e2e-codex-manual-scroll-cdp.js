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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-codex-manual-scroll-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'codex-manual-scroll');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `manual-scroll-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 60; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitForEval(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function writeFakeCodex() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const script = path.join(FAKE_BIN, 'fake-codex-resume.js');
  fs.writeFileSync(script, `'use strict';
const out = text => process.stdout.write(text);
for (let i = 0; i < 420; i += 1) {
  const marker = i === 0 ? 'RESUME-FIRST-LINE' : (i === 419 ? 'RESUME-LAST-LINE' : 'resume-history-' + i);
  out(marker + ' ' + 'resumed scrollback '.repeat(8) + '\\r\\n');
}
let pulse = 0;
setInterval(() => out('RESUME-LIVE-PULSE-' + (++pulse) + '\\r\\n'), 70);
process.stdin.resume();
`, 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
}

async function main() {
  writeFakeCodex();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(Number(process.env.HUB_CODEX_SCROLL_E2E_PORT || 19680));
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port };

  try {
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'codex-manual-scroll',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_NO_EFFORT_MAX: '1',
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await waitForEval(client, 'window.__hubE2E && document.getElementById("terminal-panel")', 'Hub E2E API');

    result.scroll = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const xterm = require('@xterm/xterm');
      const { ipcRenderer } = require('electron');
      window.__manualScrollTerms = [];
      const originalOpen = xterm.Terminal.prototype.open;
      xterm.Terminal.prototype.open = function patchedOpen(parent) {
        window.__manualScrollTerms.push(this);
        return originalOpen.call(this, parent);
      };

      const sid = 'e2e-codex-manual-scroll';
      window.__hubE2E.addFakeSession({
        id: sid,
        kind: 'codex',
        title: 'Codex manual scroll regression',
        status: 'running',
        cwd: ${JSON.stringify(TEMP_ROOT)},
      });
      await window.__hubE2E.selectSession(sid, { forceScrollBottom: true });
      await wait(600);

      const term = window.__manualScrollTerms.at(-1);
      if (!term || !term.element) throw new Error('xterm not mounted');
      const vp = term.element.querySelector('.xterm-viewport');
      if (!vp) throw new Error('xterm viewport missing');

      const history = Array.from({ length: 420 }, (_, i) =>
        'history line ' + String(i + 1).padStart(4, '0') + ' ' + 'scrollback '.repeat(10)
      ).join('\\r\\n') + '\\r\\n';
      ipcRenderer.emit('terminal-data', {}, { sessionId: sid, data: history, seq: 1 });
      for (let attempt = 0; attempt < 60 && (vp.scrollHeight - vp.clientHeight) <= 1000; attempt += 1) {
        await wait(100);
      }
      term.scrollToBottom();
      await wait(80);

      const before = {
        bufferLength: term.buffer.active.length,
        baseY: term.buffer.active.baseY,
        viewportY: term.buffer.active.viewportY,
        scrollTop: vp.scrollTop,
        maxTop: Math.max(0, vp.scrollHeight - vp.clientHeight),
      };

      // Reproduce the field race: a real pointer drag starts immediately after
      // an automatic bottom pin, while the 120 ms programmatic-scroll guard is
      // still active. The drag's scroll event must win over that guard.
      vp.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, buttons: 1 }));
      ipcRenderer.emit('terminal-data', {}, { sessionId: sid, data: 'stream pulse before drag\\r\\n', seq: 2 });
      const targetTop = Math.max(0, before.maxTop - Math.max(600, vp.clientHeight * 2));
      vp.scrollTop = targetTop;
      vp.dispatchEvent(new Event('scroll', { bubbles: false }));
      ipcRenderer.emit('terminal-data', {}, { sessionId: sid, data: 'stream pulse after drag\\r\\n', seq: 3 });
      await wait(240);

      const after = {
        viewportY: term.buffer.active.viewportY,
        baseY: term.buffer.active.baseY,
        scrollTop: vp.scrollTop,
        maxTop: Math.max(0, vp.scrollHeight - vp.clientHeight),
      };
      after.bottomGap = Math.max(0, after.maxTop - after.scrollTop);
      after.logicalGap = Math.max(0, after.baseY - after.viewportY);
      return { before, targetTop, after };
    })()`);

    // Exercise the real dormant -> resume-session IPC -> SessionManager PTY
    // path as well. This is the user's field path, not merely a fresh xterm.
    result.resume = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const sid = 'e2e-codex-dormant-resume';
      window.__hubE2E.addFakeSession({
        id: sid,
        kind: 'codex',
        title: 'Codex dormant resume scroll regression',
        status: 'dormant',
        cwd: ${JSON.stringify(TEMP_ROOT)},
        createdAt: Date.now() - 60000,
        lastMessageTime: Date.now() - 30000,
      });
      await window.__hubE2E.selectSession(sid, { forceScrollBottom: true });

      const deadline = Date.now() + 20000;
      let cached = null;
      let text = '';
      while (Date.now() < deadline) {
        cached = terminalCache.get(sid);
        if (cached && cached._hydrated && cached.terminal && cached.terminal.buffer) {
          const buffer = cached.terminal.buffer.active;
          const lines = [];
          for (let i = 0; i < buffer.length; i += 1) {
            const line = buffer.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          text = lines.join('\\n');
          if (text.includes('RESUME-FIRST-LINE') && text.includes('RESUME-LAST-LINE')) break;
        }
        await wait(100);
      }
      if (!cached || !text.includes('RESUME-LAST-LINE')) throw new Error('resumed PTY history not rendered');

      const term = cached.terminal;
      const vp = term.element && term.element.querySelector('.xterm-viewport');
      if (!vp) throw new Error('resumed xterm viewport missing');
      for (let attempt = 0; attempt < 60 && (vp.scrollHeight - vp.clientHeight) <= 1000; attempt += 1) {
        await wait(100);
      }
      term.scrollToBottom();
      await wait(100);
      const before = {
        hasFirst: text.includes('RESUME-FIRST-LINE'),
        hasLast: text.includes('RESUME-LAST-LINE'),
        bufferLength: term.buffer.active.length,
        baseY: term.buffer.active.baseY,
        viewportY: term.buffer.active.viewportY,
        maxTop: Math.max(0, vp.scrollHeight - vp.clientHeight),
      };

      vp.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, buttons: 1 }));
      const targetTop = Math.max(0, before.maxTop - Math.max(700, vp.clientHeight * 2));
      vp.scrollTop = targetTop;
      vp.dispatchEvent(new Event('scroll', { bubbles: false }));
      // The fake resumed CLI keeps emitting every 70 ms. Remaining detached
      // across this delay proves live PTY output cannot override the drag.
      await wait(520);

      const after = {
        viewportY: term.buffer.active.viewportY,
        baseY: term.buffer.active.baseY,
        scrollTop: vp.scrollTop,
        maxTop: Math.max(0, vp.scrollHeight - vp.clientHeight),
      };
      after.bottomGap = Math.max(0, after.maxTop - after.scrollTop);
      after.logicalGap = Math.max(0, after.baseY - after.viewportY);
      return { before, targetTop, after, status: sessions.get(sid)?.status || null };
    })()`);

    const shot = await client.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshot = SCREENSHOT_PATH;
    result.isolatedDataDir = DATA_DIR;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');

    assert.ok(result.scroll.before.bufferLength > 400, JSON.stringify(result.scroll));
    assert.ok(result.scroll.before.maxTop > 1000, JSON.stringify(result.scroll));
    assert.ok(result.scroll.after.bottomGap > 300, JSON.stringify(result.scroll));
    assert.ok(result.scroll.after.logicalGap > 10, JSON.stringify(result.scroll));
    assert.equal(result.resume.before.hasFirst, true, JSON.stringify(result.resume));
    assert.equal(result.resume.before.hasLast, true, JSON.stringify(result.resume));
    assert.ok(result.resume.before.bufferLength > 400, JSON.stringify(result.resume));
    assert.ok(result.resume.after.bottomGap > 300, JSON.stringify(result.resume));
    assert.ok(result.resume.after.logicalGap > 10, JSON.stringify(result.resume));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
