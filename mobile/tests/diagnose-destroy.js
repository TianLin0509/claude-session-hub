'use strict';
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const tokenPrefix = process.argv[2];
const sessionId = process.argv[3];
const hubId = process.argv[4];
if (!tokenPrefix || !sessionId) { console.error('Usage: <token> <sessionId> [hubId]'); process.exit(2); }

let fullToken = tokenPrefix;
try {
  const devFile = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'mobile-devices.json');
  const data = JSON.parse(fs.readFileSync(devFile, 'utf-8'));
  const match = (data.devices || []).find(d => d.token.startsWith(tokenPrefix));
  if (match) fullToken = match.token;
} catch {}

const ws = new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${fullToken}`], { rejectUnauthorized: false });
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  setTimeout(() => {
    const m = { type: 'destroy-session', sessionId };
    if (hubId) m.hubId = hubId;
    ws.send(JSON.stringify(m));
    console.log('sent destroy', sessionId);
  }, 800);
  setTimeout(() => { ws.close(); process.exit(0); }, 4000);
});
ws.on('message', (raw) => console.log('<-', raw.toString().slice(0, 200)));
ws.on('error', (e) => console.error('err', e.message));
