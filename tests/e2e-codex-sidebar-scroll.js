'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = parseInt(process.env.CDP_PORT || '9308', 10);
const DATA_DIR = process.env.HUB_DATA || path.join(os.tmpdir(), 'hub-e2e-codex-sidebar-scroll');
const SCREENSHOT_DIR = path.join(HUB_DIR, 'tests', 'screenshots', 'codex-sidebar-scroll');

let msgId = 0;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function rpc(ws, method, params = {}, timeout = 15000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`${method} timeout`));
    }, timeout);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression, timeout = 15000) {
  const r = await rpc(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeout);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
}

async function screenshot(ws, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fp = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 10000);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log(`  screenshot: ${fp}`);
  return fp;
}

async function attach(port) {
  for (let i = 0; i < 45; i++) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    const page = Array.isArray(list) && list.find(x => x.type === 'page' && !String(x.url).startsWith('devtools://'));
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      await rpc(ws, 'Page.enable');
      await rpc(ws, 'Runtime.enable');
      return ws;
    }
    await sleep(1000);
  }
  throw new Error('CDP attach timeout');
}

function startHub() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', c => logs.push(c.toString()));
  proc.stderr.on('data', c => logs.push(c.toString()));
  return { proc, logs };
}

function assertOk(cond, message, detail) {
  if (!cond) {
    const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
    throw new Error(message + suffix);
  }
  console.log('  OK ' + message);
}

(async () => {
  console.log(`[setup] isolated data dir: ${DATA_DIR}`);
  console.log(`[setup] CDP port: ${CDP_PORT}`);
  const { proc, logs } = startHub();
  console.log(`[setup] spawned isolated Hub PID=${proc.pid}`);
  let ws;
  const shots = [];
  try {
    ws = await attach(CDP_PORT);
    await sleep(1500);

    const raw = await evalJs(ws, `(async () => {
      if (typeof applyViewMode === 'function') applyViewMode('pty');
      const sid = 'e2e-codex-sidebar-scroll';
      const now = Date.now();
      sessions.set(sid, {
        id: sid,
        kind: 'codex',
        title: 'Codex Scroll E2E',
        status: 'idle',
        createdAt: now,
        lastMessageTime: now,
        lastOutputPreview: 'scroll test',
        cwd: 'C:/tmp/codex-scroll-e2e',
      });
      renderSessionList();
      selectSession(sid);
      await new Promise(r => setTimeout(r, 500));
      const cached = terminalCache.get(sid);
      if (!cached || !cached.terminal) return JSON.stringify({ error: 'terminal missing' });
      const lines = Array.from({ length: 260 }, (_, i) => 'codex sidebar scroll line ' + String(i + 1).padStart(3, '0')).join('\\r\\n') + '\\r\\n';
      await new Promise(resolve => cached.terminal.write(lines, resolve));
      await new Promise(r => setTimeout(r, 200));
      const vp = cached.container.querySelector('.xterm-viewport');
      if (!vp) return JSON.stringify({ error: 'viewport missing' });
      try { cached.terminal.scrollToTop(); } catch {}
      vp.scrollTop = 0;
      const before = {
        top: vp.scrollTop,
        height: vp.scrollHeight,
        client: vp.clientHeight,
        max: Math.max(0, vp.scrollHeight - vp.clientHeight),
      };
      const item = Array.from(document.querySelectorAll('.session-item'))
        .find(el => el.textContent.includes('Codex Scroll E2E'));
      if (!item) return JSON.stringify({ error: 'sidebar item missing', before });
      item.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(r => setTimeout(r, 250));
      const after = {
        top: vp.scrollTop,
        height: vp.scrollHeight,
        client: vp.clientHeight,
        max: Math.max(0, vp.scrollHeight - vp.clientHeight),
      };
      return JSON.stringify({ before, after, activeSessionId, currentView });
    })()`, 30000);
    const result = JSON.parse(raw);
    assertOk(!result.error, 'test Codex session mounted in isolated renderer', result);
    assertOk(result.before.max > 0 && result.before.top <= 2, 'test starts away from bottom', result);
    assertOk(result.after.max > 0 && result.after.top >= result.after.max - 8,
      'clicking the active Codex sidebar item scrolls PTY to bottom', result);
    shots.push(await screenshot(ws, 'codex-sidebar-bottom'));
    console.log(JSON.stringify({ ok: true, dataDir: DATA_DIR, screenshots: shots }, null, 2));
  } catch (err) {
    console.error('[hub logs tail]\\n' + logs.join('').slice(-4000));
    if (ws) {
      try { shots.push(await screenshot(ws, 'error')); } catch {}
    }
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (ws) try { ws.close(); } catch {}
    if (proc && !proc.killed) proc.kill();
  }
})();
