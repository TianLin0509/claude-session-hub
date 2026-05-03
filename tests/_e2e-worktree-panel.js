// E2E for Worktree Panel.
// Runs in isolated Hub instance (CLAUDE_HUB_DATA_DIR + --remote-debugging-port=9224).
// Scope: panel UI + IPC roundtrip only.
// (Real DeepSeek session creation flow deliberately punted to v2 per spec §10.)

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const WebSocket = require('ws');
const http = require('http');

const HUB_DIR = process.env.HUB_DIR || path.resolve(__dirname, '..');
const PORT = 9224;
const DATA_DIR = path.join(os.tmpdir(), `hub-wt-e2e-${Date.now()}`);

async function getPageWs() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const pages = JSON.parse(data);
          const hub = pages.find((p) => p.title && (p.title.includes('Hub') || p.title.includes('圆桌') || p.title.includes('Roundtable')));
          if (!hub) {
            reject(new Error('Hub page not found. Pages: ' + pages.map((p) => p.title).join(' | ')));
          } else {
            resolve(hub.webSocketDebuggerUrl);
          }
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

let ws;
let msgId = 0;
function evaluate(expr) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (_) { return; }
      if (m.id === id) {
        ws.off('message', handler);
        if (m.result && m.result.exceptionDetails) {
          reject(new Error(JSON.stringify(m.result.exceptionDetails)));
        } else {
          resolve(m.result && m.result.result && m.result.result.value);
        }
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
}

let hubProc;
async function startHub() {
  process.env.CLAUDE_HUB_DATA_DIR = DATA_DIR;
  const electronPath = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  hubProc = cp.spawn(
    electronPath,
    [HUB_DIR, `--remote-debugging-port=${PORT}`],
    { env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  hubProc.stdout.on('data', (b) => { /* swallow but available for debug */ });
  hubProc.stderr.on('data', (b) => { /* swallow */ });

  // Wait for CDP port to come up.
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - t0 > 30000) { clearInterval(tick); reject(new Error('hub start timeout')); return; }
      const req = http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
        if (res.statusCode === 200) { clearInterval(tick); resolve(); }
        res.resume();
      });
      req.on('error', () => {});
    }, 500);
  });

  const wsUrl = await getPageWs();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  // Give renderer a beat to finish initial load.
  await new Promise((r) => setTimeout(r, 1500));
}

async function stopHub() {
  try { if (ws) ws.close(); } catch (_) {}
  try { if (hubProc) hubProc.kill('SIGKILL'); } catch (_) {}
}

async function main() {
  await startHub();

  // 1) Panel element exists in DOM.
  const exists = await evaluate(`!!document.getElementById('worktree-panel')`);
  if (!exists) throw new Error('worktree-panel not in DOM');
  console.log('  ✓ panel element exists');

  // 2) Panel hidden when no session.
  await evaluate(`window.worktreePanel && window.worktreePanel.onSessionChange(null)`);
  const visible0 = await evaluate(`document.getElementById('worktree-panel').style.display`);
  if (visible0 !== 'none') throw new Error('expected hidden when no session, got: ' + JSON.stringify(visible0));
  console.log('  ✓ panel hidden when no session');

  // 3) IPC roundtrip works (probe with non-existent session — should still return ok=true with empty data).
  const probeOk = await evaluate(
    `(async () => {
      try {
        const r = await require('electron').ipcRenderer.invoke('worktree:probe', { activeSessionId: 'no-such', force: true });
        return r && r.ok === true;
      } catch (e) {
        return 'err:' + e.message;
      }
    })()`
  );
  if (probeOk !== true) throw new Error('worktree:probe failed: ' + probeOk);
  console.log('  ✓ worktree:probe IPC roundtrip');

  console.log('\nE2E ✓ all passed');
  await stopHub();
}

main().catch(async (e) => {
  console.error('E2E ✗', e);
  await stopHub();
  process.exit(1);
});
