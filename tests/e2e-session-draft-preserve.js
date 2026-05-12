'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'hub-test-session-draft-preserve');
const CDP_PORT = 9237;

let _id = 0;

function rpc(ws, method, params = {}) {
  const id = ++_id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`timeout ${method}`));
    }, 30000);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalRpc(ws, expression) {
  const result = await rpc(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error('eval failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 1200));
  }
  return result.result.value;
}

async function waitForRendererReady(ws) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = await evalRpc(ws, `(() => ({
      readyState: document.readyState,
      hasSelectSession: typeof selectSession === 'function',
      hasSessions: typeof sessions !== 'undefined',
      hasRenderSessionList: typeof renderSessionList === 'function',
    }))()`);
    if (last.hasSelectSession && last.hasSessions && last.hasRenderSessionList) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('renderer did not expose session helpers: ' + JSON.stringify(last));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

async function attachCDP(port) {
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (!page) throw new Error('main page not found');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      await rpc(ws, 'Runtime.enable');
      await rpc(ws, 'Page.enable');
      return ws;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw new Error(`attachCDP failed: ${lastErr && lastErr.message}`);
}

function startHub() {
  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA };
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let ready = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes('hook server listening')) {
        ready = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!ready) reject(new Error(`Hub exited before ready, code=${code}`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error('Hub did not become ready within 30s'));
    }, 30000);
  });
}

(async () => {
  fs.rmSync(TEMP_DATA, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DATA, { recursive: true });

  let hub = null;
  let ws = null;
  try {
    hub = await startHub();
    ws = await attachCDP(CDP_PORT);
    await waitForRendererReady(ws);

    const result = await evalRpc(ws, `(async () => {
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      if (typeof selectSession !== 'function') return { ok: false, reason: 'selectSession missing' };
      if (typeof sessions === 'undefined' || typeof renderSessionList !== 'function') {
        return { ok: false, reason: 'renderer globals missing' };
      }

      const now = Date.now();
      sessions.set('draft-a', {
        id: 'draft-a',
        title: 'Draft A',
        kind: 'powershell',
        status: 'idle',
        lastMessageTime: now,
      });
      sessions.set('draft-b', {
        id: 'draft-b',
        title: 'Draft B',
        kind: 'powershell',
        status: 'idle',
        lastMessageTime: now + 1,
      });
      renderSessionList();

      selectSession('draft-a');
      await waitFrame();
      await waitFrame();
      let box = document.querySelector('.floating-input-box');
      if (!box) return { ok: false, reason: 'input box for draft-a missing' };
      box.textContent = 'draft text for session A';
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'A' }));

      selectSession('draft-b');
      await waitFrame();
      await waitFrame();
      box = document.querySelector('.floating-input-box');
      if (!box) return { ok: false, reason: 'input box for draft-b missing' };
      const bInitial = (box.innerText || box.textContent || '').trim();
      box.textContent = 'draft text for session B';
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'B' }));

      selectSession('draft-a');
      await waitFrame();
      await waitFrame();
      box = document.querySelector('.floating-input-box');
      const aRestored = (box && (box.innerText || box.textContent || '').trim()) || '';

      selectSession('draft-b');
      await waitFrame();
      await waitFrame();
      box = document.querySelector('.floating-input-box');
      const bRestored = (box && (box.innerText || box.textContent || '').trim()) || '';

      return { ok: true, bInitial, aRestored, bRestored };
    })()`);

    console.log('[draft-preserve]', JSON.stringify(result));
    if (!result.ok) throw new Error(result.reason || 'renderer check failed');
    if (result.bInitial !== '') throw new Error(`new session B should start empty, got ${JSON.stringify(result.bInitial)}`);
    if (result.aRestored !== 'draft text for session A') {
      throw new Error(`session A draft not restored, got ${JSON.stringify(result.aRestored)}`);
    }
      if (result.bRestored !== 'draft text for session B') {
      throw new Error(`session B draft not restored, got ${JSON.stringify(result.bRestored)}`);
    }

    const meetingResult = await evalRpc(ws, `(async () => {
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      if (!window.MeetingRoom || typeof window.MeetingRoom.openMeeting !== 'function') {
        return { ok: false, reason: 'MeetingRoom.openMeeting missing' };
      }

      const mkSession = (id, title, kind, ts) => ({
        id,
        title,
        kind,
        status: 'idle',
        lastMessageTime: ts,
      });

      const now = Date.now();
      sessions.set('rt-a', mkSession('rt-a', 'Roundtable A', 'powershell', now + 10));
      sessions.set('rt-b', mkSession('rt-b', 'Roundtable B', 'powershell', now + 11));
      sessions.set('gc-a', mkSession('gc-a', 'Group A', 'codex', now + 12));
      sessions.set('gc-b', mkSession('gc-b', 'Group B', 'codex', now + 13));

      const rtMeeting = {
        id: 'meeting-rt-draft',
        title: 'Roundtable Draft',
        mode: 'free',
        scene: 'general',
        subSessions: ['rt-a', 'rt-b'],
        participants: [0, 1],
        sendTarget: 'all',
        lastMessageTime: now + 20,
      };
      const gcMeeting = {
        id: 'meeting-gc-draft',
        title: 'Group Draft',
        mode: 'free',
        scene: 'general',
        groupChat: true,
        groupMode: 'deliberation',
        subSessions: ['gc-a', 'gc-b'],
        participants: [0, 1],
        sendTarget: 'all',
        lastMessageTime: now + 21,
      };

      meetings[rtMeeting.id] = rtMeeting;
      meetings[gcMeeting.id] = gcMeeting;
      renderSessionList();

      window.MeetingRoom.openMeeting(rtMeeting.id, rtMeeting);
      await waitFrame();
      await waitFrame();
      let box = document.getElementById('mr-input-box');
      if (!box) return { ok: false, reason: 'roundtable input missing' };
      box.textContent = 'roundtable draft text';
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'r' }));

      selectSession('rt-a');
      await waitFrame();
      await waitFrame();
      window.MeetingRoom.openMeeting(rtMeeting.id, rtMeeting);
      await waitFrame();
      await waitFrame();
      box = document.getElementById('mr-input-box');
      const roundtableRestored = (box && (box.innerText || box.textContent || '').trim()) || '';

      window.MeetingRoom.openMeeting(gcMeeting.id, gcMeeting);
      await waitFrame();
      await waitFrame();
      box = document.getElementById('mr-input-box');
      const groupInitial = (box && (box.innerText || box.textContent || '').trim()) || '';
      box.textContent = 'group chat draft text';
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'g' }));

      selectSession('gc-a');
      await waitFrame();
      await waitFrame();
      window.MeetingRoom.openMeeting(gcMeeting.id, gcMeeting);
      await waitFrame();
      await waitFrame();
      box = document.getElementById('mr-input-box');
      const groupRestored = (box && (box.innerText || box.textContent || '').trim()) || '';

      return { ok: true, roundtableRestored, groupInitial, groupRestored };
    })()`);

    console.log('[meeting-draft-preserve]', JSON.stringify(meetingResult));
    if (!meetingResult.ok) throw new Error(meetingResult.reason || 'meeting renderer check failed');
    if (meetingResult.roundtableRestored !== 'roundtable draft text') {
      throw new Error(`roundtable draft not restored, got ${JSON.stringify(meetingResult.roundtableRestored)}`);
    }
    if (meetingResult.groupInitial !== '') {
      throw new Error(`group meeting should not inherit roundtable draft, got ${JSON.stringify(meetingResult.groupInitial)}`);
    }
    if (meetingResult.groupRestored !== 'group chat draft text') {
      throw new Error(`group chat draft not restored, got ${JSON.stringify(meetingResult.groupRestored)}`);
    }
    console.log('[draft-preserve] PASS');
  } finally {
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (hub && !hub.killed) {
      try { hub.kill(); } catch {}
    }
  }
})().catch((err) => {
  console.error('[draft-preserve] FAIL:', err.message);
  process.exitCode = 1;
});
