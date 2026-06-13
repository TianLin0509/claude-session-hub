'use strict';

// 模拟 PWA 真实发输入消息，验证端到端回复
// 用法: node diagnose-send-input.js <tokenPrefix> <sessionId> <text>

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const tokenPrefix = process.argv[2];
const sessionId = process.argv[3];
const text = process.argv[4] || '你好，请简短回复一句话';
const hubId = process.argv[5] || null;

if (!tokenPrefix || !sessionId) {
  console.error('Usage: node diagnose-send-input.js <tokenPrefix> <sessionId> [text] [hubId]');
  process.exit(2);
}

let fullToken = tokenPrefix;
try {
  const devFile = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'mobile-devices.json');
  const data = JSON.parse(fs.readFileSync(devFile, 'utf-8'));
  const match = (data.devices || []).find(d => d.token.startsWith(tokenPrefix));
  if (match) fullToken = match.token;
} catch {}

console.log(`[start] token=${fullToken.slice(0,12)}… session=${sessionId.slice(0,12)}… text="${text}"`);

const ws = new WebSocket('wss://lthub.xyz:8443/pwa', [`device.${fullToken}`], { rejectUnauthorized: false });
const log = (dir, type, extra) => {
  const ts = new Date().toISOString().slice(11, 23);
  let body = '';
  if (extra) {
    try { body = ' ' + JSON.stringify(extra).slice(0, 300); } catch { body = ' [unserializable]'; }
  }
  console.log(`${ts} ${dir} ${type}${body}`);
};

let turnReceived = false;
let sentInputAt = 0;

ws.on('open', () => {
  console.log('[open] connected');
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  log('→', 'hello');

  setTimeout(() => {
    const msg = { type: 'input', sessionId, content: text, clientId: 'diag-' + Date.now() };
    if (hubId) msg.hubId = hubId;
    ws.send(JSON.stringify(msg));
    sentInputAt = Date.now();
    log('→', 'input', { sessionId: sessionId.slice(0,12), content: text, hubId });
  }, 1000);

  // 60 秒等回复
  setTimeout(() => {
    if (!turnReceived) {
      console.log(`\n[FAIL] 60 秒内未收到 turn 回复（输入发送后 ${Math.round((Date.now() - sentInputAt)/1000)}s）`);
    }
    ws.close(1000, 'done');
    process.exit(turnReceived ? 0 : 3);
  }, 60000);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  let extra = null;
  if (msg.type === 'turn') {
    turnReceived = true;
    const elapsed = sentInputAt ? Math.round((Date.now() - sentInputAt)/1000) : 0;
    extra = { sessionId: msg.sessionId && msg.sessionId.slice(0,12), seq: msg.seq, contentPreview: (msg.content || '').slice(0, 120), elapsedSec: elapsed };
    log('←', 'turn ✓', extra);
    setTimeout(() => { ws.close(1000, 'done'); process.exit(0); }, 500);
    return;
  } else if (msg.type === 'turn-delta') {
    extra = { delta: (msg.delta || '').slice(0, 60) };
  } else if (msg.type === 'session-list') {
    const s = (msg.sessions || []).find(x => x.id === sessionId);
    extra = { ourSession: s ? { id: s.id.slice(0,12), kind: s.kind, status: s.status, lastMessageTime: s.lastMessageTime } : 'NOT-FOUND', total: (msg.sessions||[]).length };
  } else if (msg.type === 'conn-state') {
    extra = { state: msg.state };
  } else if (msg.type === 'error') {
    extra = { code: msg.code, error: msg.error };
  }
  log('←', msg.type, extra);
});

ws.on('error', (e) => console.error('[ws-err]', e.message));
ws.on('close', (c, r) => console.log(`[close] code=${c} reason=${r}`));
