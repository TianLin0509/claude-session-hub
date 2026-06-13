'use strict';

// 直接模拟 PWA → VPS gateway，验证 NEW_SESSION 端到端链路
// 跳过浏览器，专注协议层诊断
// 使用方法: node diagnose-mobile-link.js <deviceToken> [hubId]

const WebSocket = require('ws');

const GATEWAY_URL = 'wss://lthub.xyz:8443/pwa';
const deviceToken = process.argv[2];
const targetHubId = process.argv[3] || null;

if (!deviceToken) {
  console.error('Usage: node diagnose-mobile-link.js <deviceToken-prefix> [hubId]');
  process.exit(2);
}

// 接受任意 prefix；从 mobile-devices.json 找完整 token
const fs = require('fs');
const path = require('path');
let fullToken = deviceToken;
try {
  const devFile = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'mobile-devices.json');
  const data = JSON.parse(fs.readFileSync(devFile, 'utf-8'));
  const match = (data.devices || []).find(d => d.token.startsWith(deviceToken));
  if (match) {
    fullToken = match.token;
    console.log(`[match] token ${fullToken.slice(0,12)}…${fullToken.slice(-4)} (name=${match.deviceName || '-'})`);
  }
} catch (e) {
  console.warn('[warn] 无法读 mobile-devices.json，按 raw token 使用:', e.message);
}

const ws = new WebSocket(GATEWAY_URL, [`device.${fullToken}`], {
  rejectUnauthorized: false,
});

const log = (dir, type, extra) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${dir} ${type}${extra ? ' ' + JSON.stringify(extra).slice(0, 200) : ''}`);
};

ws.on('open', () => {
  console.log('[open] WSS 已连接');
  log('→', 'hello', { sinceSeq: 0 });
  ws.send(JSON.stringify({ type: 'hello', sinceSeq: 0 }));

  // 1.5s 后请求 hub list
  setTimeout(() => {
    log('→', 'list-hubs', { requestId: 'diag-1' });
    ws.send(JSON.stringify({ type: 'list-hubs', requestId: 'diag-1' }));
  }, 500);

  // 3s 后请求 list-sessions（针对 targetHubId）
  setTimeout(() => {
    log('→', 'list-sessions', { hubId: targetHubId });
    ws.send(JSON.stringify({ type: 'list-sessions', hubId: targetHubId }));
  }, 2000);

  // 4s 后发 new-session
  setTimeout(() => {
    const reqId = 'diag-new-' + Date.now();
    log('→', 'new-session', { kind: 'claude', title: 'diag-probe', hubId: targetHubId, requestId: reqId });
    ws.send(JSON.stringify({
      type: 'new-session',
      kind: 'claude',
      title: 'diag-probe',
      hubId: targetHubId,
      requestId: reqId,
    }));
  }, 3500);

  // 12s 后退出
  setTimeout(() => {
    console.log('\n[done] 12s 计时到，关闭');
    ws.close(1000, 'diag done');
    process.exit(0);
  }, 12000);
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    let extra = null;
    if (msg.type === 'hub-list') {
      extra = { hubs: (msg.hubs || []).map(h => ({ id: h.hubId.slice(0,30), pid: h.pid, ver: h.version, legacy: h.isLegacy })) };
    } else if (msg.type === 'session-list') {
      extra = { count: (msg.sessions || []).length, sessions: (msg.sessions || []).map(s => ({ id: s.id.slice(0,12), kind: s.kind, title: s.title })) };
    } else if (msg.type === 'session-created') {
      extra = msg.session || msg;
    } else if (msg.type === 'error') {
      extra = { code: msg.code, error: msg.error };
    } else if (msg.type === 'conn-state') {
      extra = { state: msg.state };
    }
    log('←', msg.type, extra);
  } catch (e) {
    console.log('[recv-raw]', raw.toString().slice(0, 200));
  }
});

ws.on('close', (code, reason) => {
  console.log(`[close] code=${code} reason=${reason && reason.toString()}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[err]', err.message);
  process.exit(1);
});

setTimeout(() => {
  if (ws.readyState !== 1) {
    console.error('[timeout] 5s 内未连上');
    process.exit(3);
  }
}, 5000);
