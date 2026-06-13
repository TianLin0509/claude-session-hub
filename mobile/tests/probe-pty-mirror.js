'use strict';

// Protocol-level PTY mirror probe:
// 1. CDP -> renderer IPC creates a real desktop PowerShell session.
// 2. Public PWA WebSocket subscribes to that session's PTY stream.
// 3. Sends raw PTY input and waits for the marker in pty-data or session buffer.
//
// Usage:
//   node mobile/tests/probe-pty-mirror.js <cdpPort> <tokenPrefix> <hubId> [title]

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { connectCDP } = require('../../tests/helpers/cdp-client');

const [cdpPortArg, tokenPrefix, hubId, titleArg] = process.argv.slice(2);
const cdpPort = Number(cdpPortArg || 0);
if (!cdpPort || !tokenPrefix || !hubId) {
  console.error('Usage: node mobile/tests/probe-pty-mirror.js <cdpPort> <tokenPrefix> <hubId> [title]');
  process.exit(2);
}

function readDeviceToken(prefix) {
  const devFile = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'mobile-devices.json');
  const data = JSON.parse(fs.readFileSync(devFile, 'utf8'));
  const match = (data.devices || []).find(d => d.token && d.token.startsWith(prefix));
  if (!match) throw new Error(`device token prefix not found: ${prefix}`);
  return match.token;
}

function getTargets(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function main() {
  const token = readDeviceToken(tokenPrefix);
  const targets = await getTargets(cdpPort);
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || targets.find(t => t.webSocketDebuggerUrl);
  if (!page) throw new Error(`no CDP page target on ${cdpPort}`);

  const cdp = await connectCDP(page.webSocketDebuggerUrl);
  const marker = `PWA_PTY_E2E_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const title = titleArg || `PWA PTY Mirror Probe ${marker.slice(-6)}`;
  const session = await cdp.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    const s = await ipcRenderer.invoke('create-session', { kind: 'powershell', opts: { title: ${JSON.stringify(title)} } });
    return { id: s && s.id, title: s && s.title, kind: s && s.kind };
  })()`);
  if (!session || !session.id) throw new Error(`create-session returned ${JSON.stringify(session)}`);

  const seen = [];
  let ackOk = false;
  let inputAckOk = false;
  let snapshotSeen = false;
  let markerSeenInPty = false;
  let inputSentAt = 0;
  let connOk = false;

  const ws = new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${token}`], { rejectUnauthorized: false });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'pty-ack' && msg.sessionId === session.id) {
      ackOk = ackOk || !!msg.ok;
      if (msg.action === 'input') inputAckOk = inputAckOk || !!msg.ok;
      seen.push({ type: msg.type, action: msg.action, ok: msg.ok });
    } else if (msg.type === 'pty-snapshot' && msg.sessionId === session.id) {
      snapshotSeen = true;
      const text = Buffer.from(String(msg.dataB64 || ''), 'base64').toString('utf8');
      if (text.includes(marker)) markerSeenInPty = true;
      seen.push({ type: msg.type, seq: msg.seq, len: text.length, truncated: !!msg.truncated });
    } else if (msg.type === 'pty-data' && msg.sessionId === session.id) {
      const text = Buffer.from(String(msg.dataB64 || ''), 'base64').toString('utf8');
      if (text.includes(marker)) markerSeenInPty = true;
      seen.push({ type: msg.type, seq: msg.seq, text: text.slice(-160) });
    } else if (['conn-state', 'hub-list', 'session-list', 'error'].includes(msg.type)) {
      if (msg.type === 'conn-state' && msg.state === 'ok') connOk = true;
      seen.push({ type: msg.type, state: msg.state, code: msg.code, error: msg.error });
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pwa websocket open timeout')), 10000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });

  for (let i = 0; i < 20 && !connOk; i++) await wait(100);

  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  await wait(1000);
  ws.send(JSON.stringify({ type: 'pty-subscribe', hubId, sessionId: session.id, sinceSeq: 0 }));
  await wait(3500);
  try {
    const warm = await cdp.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const b = await ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(session.id)});
      return typeof b === 'string' ? b.slice(-500) : '';
    })()`);
    seen.push({ type: 'warm-buffer', text: warm.slice(-160) });
  } catch {}
  ws.send(JSON.stringify({
    type: 'pty-input',
    hubId,
    sessionId: session.id,
    dataB64: b64(`Write-Output "${marker}"\r`),
  }));
  inputSentAt = Date.now();

  const deadline = Date.now() + 15000;
  let buffer = null;
  let lastWrite = null;
  while (Date.now() < deadline) {
    await wait(500);
    buffer = await cdp.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const b = await ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(session.id)});
      return typeof b === 'string' ? b.slice(-2000) : '';
    })()`);
    lastWrite = await cdp.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('debug:get-last-session-write');
    })()`);
    const bufferHasMarker = !!buffer && buffer.includes(marker);
    const waitedAfterMarker = bufferHasMarker && Date.now() - inputSentAt > 2500;
    if (markerSeenInPty || (inputAckOk && waitedAfterMarker)) break;
  }

  try { ws.close(1000, 'done'); } catch {}
  await cdp.close();

  const ok = !!ackOk && !!inputAckOk && !!snapshotSeen && !!lastWrite && lastWrite.sessionId === session.id && String(lastWrite.data || '').includes(marker) && !!buffer && buffer.includes(marker);
  const result = {
    ok,
    hubId,
    session,
    marker,
    ackOk,
    inputAckOk,
    snapshotSeen,
    markerSeenInPty,
    bufferHasMarker: !!buffer && buffer.includes(marker),
    lastWrite,
    seen: seen.slice(-20),
    bufferTail: buffer ? buffer.slice(-500) : null,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
