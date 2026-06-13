'use strict';

// VPS Mobile Gateway 主入口
// 监听 HTTPS 443（或 HTTP via GATEWAY_INSECURE=true 仅用于本地 dev）
// - /agent  : Hub 端 outbound WSS（bearer 鉴权）
// - /pwa    : PWA WSS（device token 鉴权）
// - /api/pair : POST，PWA 提交 PIN 配对
// - /healthz : GET，状态查询

const https = require('https');
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const { Relay } = require('./lib/relay');
const { PinRateLimiter, DeviceTokenCache } = require('./lib/auth');
const { handleAgentUpgrade } = require('./routes/agent');
const { handlePwaUpgrade } = require('./routes/pwa');
const { handlePair, onPairResultFactory } = require('./routes/pair');

const CONFIG = {
  port: parseInt(process.env.GATEWAY_PORT || '443', 10),
  tlsCert: process.env.TLS_CERT_PATH || null,
  tlsKey: process.env.TLS_KEY_PATH || null,
  hubBearer: process.env.HUB_BEARER_TOKEN || null,
  insecure: process.env.GATEWAY_INSECURE === 'true',
};

if (!CONFIG.hubBearer) {
  console.error('FATAL: HUB_BEARER_TOKEN env required');
  process.exit(1);
}
if (!CONFIG.insecure && (!CONFIG.tlsCert || !CONFIG.tlsKey)) {
  console.error('FATAL: TLS_CERT_PATH and TLS_KEY_PATH required (or set GATEWAY_INSECURE=true for dev)');
  process.exit(1);
}

const relay = new Relay();
const rateLimiter = new PinRateLimiter();
const deviceTokenCache = new DeviceTokenCache();
const pendingPairs = new Map(); // requestId -> { res, ip, timer }

// MVP 简化：device_token 信任 Hub 颁发时的有效性。撤销路径靠：
//   1. Hub 端从 mobile-devices.json 删除 token
//   2. VPS 端缓存 1h 后过期，重连时 cache miss
//   3. cache miss 时此函数返回 true（信任 token 仍有效），下次 turn 失败再清理
// V1+ 可加：发 'device-verify' 给 Hub，Hub 查 mobile-devices.json 同步回复
const validateDeviceTokenAsync = (_token) => Promise.resolve(true);

const onPairResult = onPairResultFactory({ rateLimiter, pendingPairs, deviceTokenCache });

function handleHttp(req, res) {
  // CORS（开发期方便，生产可以严格限定 origin 到 PWA 域名）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/pair') {
    return handlePair({ relay, rateLimiter, pendingPairs })(req, res);
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ...relay.stats(),
      pendingPairs: pendingPairs.size,
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
}

let server;
if (CONFIG.insecure) {
  console.warn('[gateway] INSECURE mode — listening on ws:// (dev only)');
  server = http.createServer(handleHttp);
} else {
  server = https.createServer(
    { cert: fs.readFileSync(CONFIG.tlsCert), key: fs.readFileSync(CONFIG.tlsKey) },
    handleHttp,
  );
}

const wssAgent = new WebSocketServer({ noServer: true });
const wssPwa = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
  if (req.url === '/agent') {
    wssAgent.handleUpgrade(req, sock, head, (ws) => {
      handleAgentUpgrade({
        ws,
        req,
        relay,
        bearerToken: CONFIG.hubBearer,
        onPairResult,
      });
    });
  } else if (req.url === '/pwa') {
    wssPwa.handleUpgrade(req, sock, head, (ws) => {
      handlePwaUpgrade({
        ws,
        req,
        relay,
        deviceTokenCache,
        validateDeviceTokenAsync,
      });
    });
  } else {
    sock.destroy();
  }
});

server.listen(CONFIG.port, () => {
  console.log(`[gateway] listening on ${CONFIG.port} ${CONFIG.insecure ? '(ws)' : '(wss)'}`);
  console.log('[gateway] endpoints: /agent (hub), /pwa (clients), /api/pair (POST), /healthz');
});

function closeWebSocketServer(wss) {
  for (const ws of wss.clients) {
    try { ws.close(1001, 'gateway restarting'); } catch {}
    setTimeout(() => {
      try {
        if (ws.readyState !== 3) ws.terminate();
      } catch {}
    }, 1000).unref();
  }
}

function shutdown(signal) {
  console.log(`[gateway] ${signal} received, closing`);
  closeWebSocketServer(wssAgent);
  closeWebSocketServer(wssPwa);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
