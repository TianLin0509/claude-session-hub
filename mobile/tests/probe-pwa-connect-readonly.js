'use strict';

// 只读探针：模拟 PWA 客户端连 VPS 网关，验证 配对token认证 + hub路由 + 会话列表 全链路
// 不创建/不写入任何会话。用法: node probe-pwa-connect-readonly.js <deviceToken-prefix>

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const GATEWAY_URL = 'wss://lthub.xyz:8443/pwa';
const prefix = process.argv[2];
if (!prefix) { console.error('Usage: node probe-pwa-connect-readonly.js <token-prefix>'); process.exit(2); }

let fullToken = prefix;
const devFile = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'mobile-devices.json');
const data = JSON.parse(fs.readFileSync(devFile, 'utf-8'));
const match = (data.devices || []).find(d => d.token.startsWith(prefix));
if (match) { fullToken = match.token; console.log(`[match] token ${fullToken.slice(0,8)}...`); }

const ws = new WebSocket(GATEWAY_URL, [`device.${fullToken}`], { rejectUnauthorized: false });
const log = (dir, type, extra) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${dir} ${type}${extra ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`);
};

ws.on('open', () => {
  console.log('[open] WSS 已连接 (TLS + 设备token子协议握手通过)');
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));
  setTimeout(() => ws.send(JSON.stringify({ type: 'list-hubs', requestId: 'probe-1' })), 800);
  setTimeout(() => ws.send(JSON.stringify({ type: 'list-sessions' })), 2500);
  setTimeout(() => { console.log('\n[done] 探针结束'); ws.close(1000, 'probe done'); process.exit(0); }, 8000);
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    let extra = null;
    if (msg.type === 'hub-list') extra = { hubs: (msg.hubs || []).map(h => ({ pid: h.pid, ver: h.version })) };
    else if (msg.type === 'session-list') extra = { count: (msg.sessions || []).length, titles: (msg.sessions || []).map(s => s.title).slice(0, 8) };
    else if (msg.type === 'error') extra = { code: msg.code, error: msg.error };
    else if (msg.type === 'conn-state') extra = { state: msg.state };
    log('←', msg.type, extra);
  } catch { console.log('[recv-raw]', raw.toString().slice(0, 200)); }
});

ws.on('close', (code, reason) => { console.log(`[close] code=${code} reason=${reason}`); process.exit(0); });
ws.on('error', (err) => { console.error('[err]', err.message); process.exit(1); });
setTimeout(() => { if (ws.readyState !== 1) { console.error('[timeout] 8s 内未连上'); process.exit(3); } }, 8000);
