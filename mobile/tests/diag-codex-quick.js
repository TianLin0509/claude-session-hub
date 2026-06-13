'use strict';
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const HUB_ID = 'DESKTOP-1CH0TRP-pid71724-1780838465571';
const tok = 'a503870e5583';
const f = path.join(process.env.USERPROFILE, '.claude-session-hub', 'mobile-devices.json');
const fullTok = JSON.parse(fs.readFileSync(f, 'utf8')).devices.find(d => d.token.startsWith(tok)).token;
const ws = new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${fullTok}`], { rejectUnauthorized: false });
let sid = null;
let sentAt = 0;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  setTimeout(() => {
    console.log('[step] 新建 codex session');
    ws.send(JSON.stringify({ type: 'new-session', kind: 'codex', title: 'codex-quick', hubId: HUB_ID, requestId: 'r1' }));
  }, 1000);
});
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'session-created' && !sid) {
    sid = m.session.id;
    console.log(`[got] sid=${sid.slice(0,12)}`);
    setTimeout(() => {
      console.log('[step] 发 input "1+1=?"');
      sentAt = Date.now();
      ws.send(JSON.stringify({ type: 'input', sessionId: sid, content: '1+1=?', clientId: 'c1', hubId: HUB_ID }));
    }, 30000); // 等 30s 给 codex 启动
  } else if (m.type === 'turn') {
    const elapsed = ((Date.now() - sentAt) / 1000).toFixed(1);
    console.log(`[TURN ✓] ${elapsed}s preview=${(m.content || '').slice(0, 100)}`);
    ws.close(); process.exit(0);
  } else if (m.type === 'error') {
    console.log('[err]', JSON.stringify(m));
  }
});
ws.on('error', e => console.error('[ws-err]', e.message));
setTimeout(() => { console.log('[TIMEOUT 90s]'); process.exit(1); }, 90000);
