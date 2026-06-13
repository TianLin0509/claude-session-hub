'use strict';

// PWA 入站 WSS 升级处理。
// 鉴权：Sec-WebSocket-Protocol 头携带 `device.<deviceToken>`。
// deviceToken 是配对成功后由 Hub 颁发的 128-bit random，持久有效。

const { MSG, ERR } = require('../../shared/protocol');

const HEARTBEAT_MS = 30 * 1000;

function handlePwaUpgrade({ ws, req, relay, deviceTokenCache, validateDeviceTokenAsync }) {
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  const presented = protocols.find((p) => p.startsWith('device.'));
  const deviceToken = presented ? presented.slice('device.'.length) : null;

  if (!deviceToken) {
    try { ws.send(JSON.stringify({ type: MSG.ERROR, code: ERR.INVALID_TOKEN })); } catch {}
    ws.close(4003, 'no device token');
    return;
  }

  const ip = req.socket.remoteAddress;
  const verifyPromise = deviceTokenCache.isVerified(deviceToken)
    ? Promise.resolve(true)
    : Promise.resolve(validateDeviceTokenAsync(deviceToken));

  verifyPromise
    .then((ok) => {
      if (!ok) {
        try { ws.send(JSON.stringify({ type: MSG.ERROR, code: ERR.INVALID_TOKEN })); } catch {}
        ws.close(4003, 'invalid device token');
        return;
      }
      deviceTokenCache.remember(deviceToken);
      relay.addPwa(deviceToken, ws, ip);
      console.log(`[pwa] device ${deviceToken.slice(0, 6)}… connected from ${ip}`);

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || !msg.type) return;

        switch (msg.type) {
          case MSG.PONG:
          case MSG.PING:
            return;
          case MSG.LIST_HUBS: {
            // 直接由 gateway 回答，不转发到 hub
            try {
              ws.send(JSON.stringify({
                type: MSG.HUB_LIST,
                requestId: msg.requestId,
                hubs: relay.listHubs(),
              }));
            } catch {}
            return;
          }
          case MSG.HELLO:
          case MSG.PWA_INPUT:
          case MSG.NEW_SESSION:
          case MSG.DESTROY_SESSION:
          case MSG.LIST_SESSIONS:
          case MSG.RENAME_SESSION:
          case MSG.PIN_SESSION:
          case MSG.HUB_SNAPSHOT_REQUEST:
          case MSG.HUB_COMMAND:
          case MSG.HUB_VIEW_REQUEST:
          case MSG.HUB_VIEW_SUBSCRIBE:
          case MSG.HUB_VIEW_UNSUBSCRIBE:
          case MSG.HUB_VIEW_INPUT:
          case MSG.PTY_SUBSCRIBE:
          case MSG.PTY_UNSUBSCRIBE:
          case MSG.PTY_INPUT:
          case MSG.PTY_RESIZE:
          case MSG.ARTIFACT_FETCH:
          case MSG.ARTIFACT_LIST_REQUEST:
          case MSG.NEW_MEETING:
          case MSG.LIST_MEETINGS:
          case MSG.REGISTER_PUSH_SUB:
            relay.forwardToHub(deviceToken, msg);
            return;
          default:
            return;
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[pwa] device ${deviceToken.slice(0, 6)}… disconnected: ${code} ${reason}`);
        relay.removePwa(deviceToken, ws);
      });
      ws.on('error', (err) => {
        console.warn(`[pwa] device ${deviceToken.slice(0, 6)}… ws error: ${err && err.message}`);
        relay.removePwa(deviceToken, ws);
      });

      const hb = setInterval(() => {
        if (ws.readyState !== 1) {
          clearInterval(hb);
          return;
        }
        try { ws.send(JSON.stringify({ type: MSG.PING, ts: Date.now() })); } catch {}
      }, HEARTBEAT_MS);
      ws.on('close', () => clearInterval(hb));
    })
    .catch((err) => {
      console.warn(`[pwa] verify error: ${err && err.message}`);
      try { ws.send(JSON.stringify({ type: MSG.ERROR, code: ERR.INVALID_TOKEN })); } catch {}
      ws.close(4003, 'verify error');
    });
}

module.exports = { handlePwaUpgrade };
