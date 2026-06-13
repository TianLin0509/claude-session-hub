'use strict';

// POST /api/pair
// PWA 提交 { pin, deviceName } → VPS 转 Hub 校验 → Hub 回 pair-result（通过 WSS）
// → VPS 用 requestId 关联，HTTP 响应 deviceToken 给 PWA。
//
// 流程：
//   1. PWA → POST /api/pair { pin, deviceName }
//   2. VPS rate limit + 格式检查
//   3. VPS 生成 requestId，存 pendingPairs，转发给 Hub
//   4. Hub 校验 PIN，回 pair-result { requestId, ok, deviceToken? }
//   5. agent route 收到 pair-result，调 onPairResult → 拿 pendingPairs 对应 res 写 HTTP 响应
//   6. 超时 10s 自动失败

const crypto = require('crypto');
const { MSG, ERR } = require('../../shared/protocol');

const PAIR_TIMEOUT_MS = 10 * 1000;
const MAX_BODY_BYTES = 4 * 1024;

function handlePair({ relay, rateLimiter, pendingPairs }) {
  return (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const ip = req.socket.remoteAddress;
    if (rateLimiter.isLocked(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: ERR.PIN_LOCKED }));
      return;
    }

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      if (body.length + chunk.length > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: ERR.BAD_PAYLOAD }));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = null; }
      const pin = parsed && parsed.pin;
      const deviceName = parsed && parsed.deviceName;
      const hubId = parsed && parsed.hubId ? String(parsed.hubId).slice(0, 160) : '';
      if (!/^\d{6}$/.test(pin || '')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: ERR.BAD_PAYLOAD }));
        return;
      }
      if (!relay.isHubOnline()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: ERR.AGENT_OFFLINE }));
        return;
      }
      if (hubId && !relay.getHubWs(hubId)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: ERR.AGENT_OFFLINE, hubId }));
        return;
      }

      const requestId = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        const p = pendingPairs.get(requestId);
        if (p) {
          pendingPairs.delete(requestId);
          rateLimiter.recordFail(p.ip); // 超时也算失败，防呆住
          if (!p.res.writableEnded) {
            p.res.writeHead(504, { 'Content-Type': 'application/json' });
            p.res.end(JSON.stringify({ error: ERR.HUB_TIMEOUT }));
          }
        }
      }, PAIR_TIMEOUT_MS);

      pendingPairs.set(requestId, { res, ip, timer, hubId });

      try {
        const sent = relay.sendToHub(hubId, {
          type: MSG.PAIR_REQUEST,
          requestId,
          pin,
          deviceName: String(deviceName || 'unknown').slice(0, 32),
          ip,
        });
        if (!sent) throw new Error('target hub offline');
      } catch (e) {
        clearTimeout(timer);
        pendingPairs.delete(requestId);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: ERR.AGENT_OFFLINE, hubId: hubId || undefined }));
      }
    });
  };
}

// Hub WSS 上收到 pair-result 后调用，把结果回写给等待的 HTTP res
function onPairResultFactory({ rateLimiter, pendingPairs, deviceTokenCache }) {
  return (msg) => {
    const { requestId, ok, deviceToken, error } = msg || {};
    const pending = pendingPairs.get(requestId);
    if (!pending) return; // 已超时或不存在
    clearTimeout(pending.timer);
    pendingPairs.delete(requestId);

    if (!ok) {
      rateLimiter.recordFail(pending.ip);
      if (!pending.res.writableEnded) {
        pending.res.writeHead(403, { 'Content-Type': 'application/json' });
        pending.res.end(JSON.stringify({ error: error || ERR.INVALID_PIN }));
      }
      return;
    }
    rateLimiter.reset(pending.ip);
    if (deviceToken) deviceTokenCache.remember(deviceToken);
    if (!pending.res.writableEnded) {
      pending.res.writeHead(200, { 'Content-Type': 'application/json' });
      pending.res.end(JSON.stringify({ deviceToken, hubId: pending.hubId || null }));
    }
  };
}

module.exports = { handlePair, onPairResultFactory };
