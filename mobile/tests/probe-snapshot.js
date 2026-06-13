'use strict';
// 协议级探针：device token 连 /pwa，发 hub-snapshot-req（指定 hubId），打印响应
// 用法: node probe-snapshot.js <tokenPrefix> <hubId>
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const [prefix, hubId] = process.argv.slice(2);
const devFile = path.join(process.env.USERPROFILE, '.claude-session-hub', 'mobile-devices.json');
const data = JSON.parse(fs.readFileSync(devFile, 'utf-8'));
const match = (data.devices || []).find((d) => d.token.startsWith(prefix));
if (!match) { console.error('token not found'); process.exit(2); }

const ws = new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${match.token}`], { rejectUnauthorized: false });
ws.on('open', () => {
  console.log('[open]');
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  setTimeout(() => {
    console.log('[send] hub-snapshot-req hubId=' + hubId);
    ws.send(JSON.stringify({ type: 'hub-snapshot-req', requestId: 'probe-snap-1', hubId }));
  }, 800);
  setTimeout(() => { console.log('[done]'); process.exit(0); }, 8000);
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'hub-snapshot') {
    const s = msg.snapshot || {};
    console.log(`← hub-snapshot: cards=${(s.cards || []).length} titles=${JSON.stringify((s.cards || []).map((c) => c.title).slice(0, 5))}`);
  } else if (msg.type === 'error') {
    console.log(`← error: ${JSON.stringify(msg)}`);
  } else {
    console.log(`← ${msg.type}`);
  }
});
ws.on('error', (e) => { console.error('err', e.message); process.exit(1); });
