'use strict';

// E2E: isolated Electron Hub + CDP verifies committee modal preset and
// real create-meeting IPC scene persistence. It does not spawn model CLIs.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = Number(process.env.COMMITTEE_E2E_CDP_PORT || 9247);
const ARTIFACT_DIR = 'C:\\Users\\lintian\\hub-committee-artifacts';
const DATA_DIR = path.join(os.tmpdir(), `hub-committee-e2e-${Date.now()}`);

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('http timeout'));
    });
  });
}

async function waitForCdp() {
  const deadline = Date.now() + 45000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`));
      const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`CDP target not ready on ${CDP_PORT}: ${lastErr && lastErr.message}`);
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => {
      ws.removeListener('error', reject);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (!msg.id || !pending.has(msg.id)) return;
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensure(fs.existsSync(ELECTRON_EXE), `electron.exe not found: ${ELECTRON_EXE}`);

  const logPath = path.join(ARTIFACT_DIR, 'committee-e2e.log');
  const shotPath = path.join(ARTIFACT_DIR, 'committee-e2e-modal.png');
  const summaryPath = path.join(ARTIFACT_DIR, 'committee-e2e-summary.json');
  fs.writeFileSync(logPath, `start ${new Date().toISOString()}\n`, 'utf8');

  const child = spawn(ELECTRON_EXE, [ROOT, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_HUB_DATA_DIR: DATA_DIR,
      CLAUDE_HUB_MOBILE_ENABLED: '',
      CLAUDE_HUB_MOBILE_ISOLATED_OPTIN: '',
    },
  });
  child.stdout.on('data', d => fs.appendFileSync(logPath, d));
  child.stderr.on('data', d => fs.appendFileSync(logPath, d));

  let cdp = null;
  try {
    const page = await waitForCdp();
    cdp = await cdpClient(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.evaluate', {
      expression: 'new Promise(r => window.requestAnimationFrame(() => r(document.readyState)))',
      awaitPromise: true,
      returnByValue: true,
    });
    await cdp.send('Runtime.evaluate', {
      expression: `
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const tick = () => {
            if (typeof window.openMeetingCreateModal === 'function') return resolve(true);
            if (Date.now() > deadline) return reject(new Error('openMeetingCreateModal missing'));
            setTimeout(tick, 100);
          };
          tick();
        })
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const modalResult = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          if (typeof window.openMeetingCreateModal !== 'function') {
            return { ok: false, reason: 'openMeetingCreateModal missing' };
          }
          window.openMeetingCreateModal('group');
          const radio = document.querySelector('input[name="mcm-scene"][value="committee"]');
          if (!radio) return { ok: false, reason: 'committee radio missing' };
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          const slots = Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot')).map(el => ({
            kind: el.querySelector('.mcm-ai-select') && el.querySelector('.mcm-ai-select').value,
            model: el.querySelector('.mcm-model-select') && el.querySelector('.mcm-model-select').value,
          }));
          return {
            ok: true,
            title: document.title,
            hint: document.querySelector('#mcm-scene-hint') && document.querySelector('#mcm-scene-hint').textContent,
            slotCount: slots.length,
            slots,
            visible: getComputedStyle(document.querySelector('#meeting-create-modal')).display,
          };
        })()
      `,
      returnByValue: true,
    });
    const modal = modalResult.result.value;
    ensure(modal.ok, modal.reason || 'modal probe failed');
    ensure(modal.visible === 'flex', 'committee modal not visible');
    ensure(modal.slotCount === 5, `committee preset slotCount expected 5, got ${modal.slotCount}`);
    ensure(modal.hint && modal.hint.includes('Claude Opus 4.8'), 'committee hint must mention news Claude Opus 4.8');
    ensure(modal.hint && modal.hint.includes('Codex GPT-5.5'), 'committee hint must mention tech Codex GPT-5.5');
    const kinds = modal.slots.map(s => s.kind).join(',');
    ensure(kinds === 'deepseek,claude,codex,codex,claude', `unexpected committee kinds: ${kinds}`);
    ensure(modal.slots[1].model === 'claude-opus-4-8[1m]', `unexpected news model: ${modal.slots[1].model}`);
    ensure(modal.slots[2].model === 'gpt-5.5', `unexpected tech model: ${modal.slots[2].model}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

    const ipcResult = await cdp.send('Runtime.evaluate', {
      expression: `
        (async () => {
          const { ipcRenderer } = require('electron');
          const meeting = await ipcRenderer.invoke('create-meeting', {
            mode: 'committee',
            scene: 'committee',
            title: 'E2E 投委会 空壳验证',
            slots: [],
            groupChat: true,
            groupMode: 'deliberation',
            groupRecentRawN: 5,
            participants: [],
          });
          return {
            id: meeting && meeting.id,
            title: meeting && meeting.title,
            scene: meeting && meeting.scene,
            groupChat: meeting && meeting.groupChat,
            slotSpecs: meeting && meeting.slotSpecs,
            subCount: meeting && meeting.subSessions && meeting.subSessions.length,
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    const ipc = ipcResult.result.value;
    ensure(ipc && ipc.id, 'create-meeting returned no id');
    ensure(ipc.scene === 'committee', `created meeting scene expected committee, got ${ipc.scene}`);
    ensure(ipc.groupChat === true, 'created meeting must be groupChat');
    ensure(ipc.subCount === 0, `empty-shell E2E should not spawn sub sessions, got ${ipc.subCount}`);

    const summary = {
      ok: true,
      dataDir: DATA_DIR,
      cdpPort: CDP_PORT,
      modal,
      ipc,
      screenshot: shotPath,
      log: logPath,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (cdp) cdp.close();
    killTree(child.pid);
    await sleep(1500);
  }
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
