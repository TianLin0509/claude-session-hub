'use strict';
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const HUB_ID = 'DESKTOP-1CH0TRP-pid56240-1780839967514';
const tok = 'a503870e5583';
const f = path.join(process.env.USERPROFILE, '.claude-session-hub', 'mobile-devices.json');
const fullTok = JSON.parse(fs.readFileSync(f, 'utf8')).devices.find(d => d.token.startsWith(tok)).token;
const ws = new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${fullTok}`], { rejectUnauthorized: false });
const PROMPTS = ['你好', '今天是几号', '1+1=?'];
let sid = null, idx = -1, sentAt = 0, results = [];
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  setTimeout(() => {
    console.log('[step] new codex session');
    ws.send(JSON.stringify({ type: 'new-session', kind: 'codex', title: 'lat-test', hubId: HUB_ID, requestId: 'r1' }));
  }, 1000);
});
function sendNext() {
  idx++;
  if (idx >= PROMPTS.length) {
    console.log('\n=== Latency Summary ===');
    results.forEach((ms, i) => console.log(`  prompt #${i+1} "${PROMPTS[i]}": ${(ms/1000).toFixed(2)}s`));
    ws.close(); process.exit(0);
  }
  sentAt = Date.now();
  console.log(`[step] send #${idx+1}: "${PROMPTS[idx]}"`);
  ws.send(JSON.stringify({ type: 'input', sessionId: sid, content: PROMPTS[idx], clientId: 'c'+idx, hubId: HUB_ID }));
}
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'session-created' && !sid) {
    sid = m.session.id;
    console.log(`[got] sid=${sid.slice(0,12)}, wait 30s for codex CLI startup`);
    setTimeout(sendNext, 30000);
  } else if (m.type === 'turn') {
    const ms = Date.now() - sentAt;
    results.push(ms);
    console.log(`  [← turn] ${(ms/1000).toFixed(2)}s preview="${(m.content||'').slice(0,60)}"`);
    setTimeout(sendNext, 2000);
  } else if (m.type === 'error') {
    console.log('[err]', JSON.stringify(m));
  }
});
ws.on('error', e => console.error('[ws-err]', e.message));
setTimeout(() => { console.log('[TIMEOUT 300s]'); process.exit(1); }, 300000);
