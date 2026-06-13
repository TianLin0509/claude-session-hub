'use strict';

// Hub 端入站 WSS 升级处理。
// 鉴权：客户端 Sec-WebSocket-Protocol 头携带 `bearer.<HUB_BEARER_TOKEN>`。
// 这是 ws 库 / 浏览器原生 WebSocket 都支持的 token 携带方式，
// 比 URL query 更隐蔽（不会写进 access log）。

const { MSG, ERR } = require('../../shared/protocol');
const { verifyBearer } = require('../lib/auth');

const HEARTBEAT_MS = 30 * 1000;

function handleAgentUpgrade({ ws, req, relay, bearerToken, onPairResult }) {
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  const presented = protocols.find((p) => p.startsWith('bearer.'));
  const token = presented ? presented.slice('bearer.'.length) : null;

  if (!verifyBearer(token, bearerToken)) {
    try { ws.send(JSON.stringify({ type: MSG.ERROR, code: ERR.INVALID_TOKEN })); } catch {}
    ws.close(4003, 'invalid bearer');
    return;
  }

  // 先用 ws-derived id 注册（兼容老 hub 不发 hubId 的情况），后续 HELLO 时再覆盖
  relay.setHub(ws, {});
  console.log(`[agent] hub connected from ${req.socket.remoteAddress}:${req.socket.remotePort}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MSG.PONG:
      case MSG.PING:
        return; // 心跳，silent ack
      case MSG.HELLO:
        // Hub 自报家门：含 hubId（PID）、hostname、version、startedAt 等
        // 用 HELLO 信息覆盖之前的临时 hubId（让 PWA 能识别这个 hub）
        relay.setHub(ws, {
          hubId: msg.hubId,
          pid: msg.pid,
          hostname: msg.hostname,
          version: msg.version,
          startedAt: msg.startedAt,
          friendlyName: msg.friendlyName,
        });
        console.log(`[agent] hub HELLO: hubId=${msg.hubId || '(legacy)'} pid=${msg.pid} version=${msg.version}`);
        return;
      case MSG.TURN:
      case MSG.TURN_DELTA:
      case MSG.SESSION_CREATED:
      case MSG.SESSION_DESTROYED:
      case MSG.SESSION_LIST:
      case MSG.HUB_SNAPSHOT:
      case MSG.HUB_DELTA:
      case MSG.COMMAND_ACK:
      case MSG.HUB_VIEW_FRAME:
      case MSG.HUB_VIEW_INPUT_ACK:
      case MSG.PTY_SNAPSHOT:
      case MSG.PTY_DATA:
      case MSG.PTY_ACK:
      case MSG.ARTIFACT_CONTENT:
      case MSG.ARTIFACT_ERROR:
      case MSG.ARTIFACT_LIST:
      case MSG.PUSH_SUB_ACK:
      case MSG.MEETING_CREATED:
      case MSG.MEETING_LIST:
        if (msg.deviceToken) {
          relay.forwardToPwa(msg.deviceToken, msg);
        } else {
          relay.broadcastToPwa(msg);
        }
        return;
      case MSG.PAIR_RESULT:
        onPairResult(msg);
        return;
      default:
        // 未知消息忽略，不报错（前向兼容）
        return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[agent] hub disconnected: ${code} ${reason}`);
    relay.removeHub(ws);
  });
  ws.on('error', (err) => {
    console.warn(`[agent] hub ws error: ${err && err.message}`);
    relay.removeHub(ws);
  });

  // 心跳：30s 一次。除发 PING 外，做 isAlive 检测：
  // - 任何 message（含 PONG）→ isAlive=true
  // - 心跳前若 isAlive=false → 上轮没回 → terminate（避免 hub 进程被 kill 后
  //   ws 未正常 close 导致 stale entry 永久残留在 hubAgents Map）。
  ws._isAlive = true;
  ws.on('message', () => { ws._isAlive = true; });
  ws.on('pong', () => { ws._isAlive = true; });
  const hb = setInterval(() => {
    if (ws.readyState !== 1) {
      clearInterval(hb);
      return;
    }
    if (!ws._isAlive) {
      try { ws.terminate(); } catch {}
      try { relay.removeHub(ws); } catch {}
      clearInterval(hb);
      console.log('[agent] terminated stale hub ws (no pong)');
      return;
    }
    ws._isAlive = false;
    try { ws.ping(); } catch {}
    try { ws.send(JSON.stringify({ type: MSG.PING, ts: Date.now() })); } catch {}
  }, HEARTBEAT_MS);
  ws.on('close', () => clearInterval(hb));
}

module.exports = { handleAgentUpgrade };
