'use strict';

// VPS 哑转发路由表。
// 维护：
//   - hubAgent：单实例（MVP 假设一个家庭 Hub；future 可扩 multi-tenant 按 user namespace 分桶）
//   - pwaClients：deviceToken -> WebSocket 映射
// 消息流向：
//   - PWA → forwardToHub → hubAgent.send
//   - Hub → forwardToPwa → 对应 pwaClient.send
// VPS 不缓存任何消息内容，纯内存路由后立即丢弃。

const { MSG, ERR, CONN } = require('../../shared/protocol');

class Relay {
  constructor() {
    // Multi-hub 架构：维护多个 hub agent 连接，按 hubId 路由
    // hubAgents: Map<hubId, { ws, info, connectedAt }>
    this.hubAgents = new Map();
    // 向后兼容：legacy 字段 hubAgent = 第一个 / 当前默认 hub
    this.hubAgent = null;
    this.pwaClients = new Map(); // deviceToken -> { ws, lastSeq, ip, connectedAt }
  }

  _purgeClosedHubs() {
    for (const [id, entry] of this.hubAgents.entries()) {
      if (!entry.ws || entry.ws.readyState !== 1) {
        this.hubAgents.delete(id);
      }
    }
    if (this.hubAgent && this.hubAgent.readyState !== 1) {
      const first = this.hubAgents.values().next().value;
      this.hubAgent = first ? first.ws : null;
    }
  }

  // 注册 hub agent。hubInfo 来自 HELLO 消息，含可选 hubId/pid/hostname/version 等。
  // 之前 bug：每次新 hub 连上直接踢旧 hub（this.hubAgent.close(4000, ...)），
  // 导致多 hub 实例每秒互相抢占 slot。现在改：每个 hub 一个 slot，按 hubId 区分。
  setHub(ws, hubInfo = {}) {
    this._purgeClosedHubs();
    const hubId = hubInfo.hubId || this._derivedHubId(ws);
    for (const [id, entry] of this.hubAgents.entries()) {
      if (entry.ws === ws && id !== hubId) {
        this.hubAgents.delete(id);
      }
    }
    const existing = this.hubAgents.get(hubId);
    if (existing && existing.ws !== ws) {
      // 同 hubId 但不同 ws — 同 hub 重启或重连，关闭旧连接
      try { existing.ws.close(4000, 'replaced by same-hub new connection'); } catch {}
    }
    this.hubAgents.set(hubId, {
      ws,
      info: hubInfo,
      connectedAt: Date.now(),
      hubId,
    });
    // 默认 hubAgent = 第一个或最新（兼容老 PWA 不指定 hubId 的情况）
    this.hubAgent = ws;
    this._broadcastConn(CONN.OK);
    // 通知所有 PWA hub list 更新（可选优化：用专门消息 hub-list-changed）
  }

  removeHub(ws) {
    let removedId = null;
    for (const [id, entry] of this.hubAgents.entries()) {
      if (entry.ws === ws) {
        this.hubAgents.delete(id);
        removedId = id;
      }
    }
    // 如果当前 default hubAgent 是被移除的，换一个
    if (this.hubAgent === ws) {
      const first = this.hubAgents.values().next().value;
      this.hubAgent = first ? first.ws : null;
    }
    if (this.hubAgents.size === 0) {
      this._broadcastConn(CONN.HUB_OFF);
    }
    return removedId;
  }

  isHubOnline() {
    this._purgeClosedHubs();
    return this.hubAgents.size > 0;
  }

  // 给后端 socket 推导稳定 id（同一 hub 同次连接保持不变）
  _derivedHubId(ws) {
    try {
      const sock = ws._socket;
      return `legacy-${sock.remoteAddress}-${sock.remotePort}`;
    } catch {
      return `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  // 返回所有当前在线 hub 的公开元数据（PWA 通过 HUB_LIST_REQUEST 拿）
  listHubs() {
    this._purgeClosedHubs();
    const out = [];
    for (const { hubId, info, connectedAt } of this.hubAgents.values()) {
      out.push({
        hubId,
        pid: info.pid || null,
        hostname: info.hostname || null,
        version: info.version || null,
        startedAt: info.startedAt || null,
        connectedAt,
        isLegacy: hubId.startsWith('legacy-'),
        // T11 Web Push：透传 hub 上报的 VAPID 公钥；PWA 用它 subscribe pushManager
        vapidPublicKey: info.vapidPublicKey || null,
        friendlyName: info.friendlyName || null,
      });
    }
    return out;
  }

  // 按 hubId 取 hub agent ws
  getHubWs(hubId) {
    this._purgeClosedHubs();
    const e = this.hubAgents.get(hubId);
    return e && e.ws.readyState === 1 ? e.ws : null;
  }

  sendToHub(hubId, msg) {
    this._purgeClosedHubs();
    const targetWs = hubId ? this.getHubWs(hubId) : this.hubAgent;
    return this._send(targetWs, msg);
  }

  addPwa(deviceToken, ws, ip) {
    const prev = this.pwaClients.get(deviceToken);
    if (prev && prev.ws !== ws) {
      // 同一设备多次连入（比如 PWA 切前台触发重连，旧连接尚未关闭）→ 替换。
      try { prev.ws.close(4001, 'replaced by new pwa session'); } catch {}
    }
    this.pwaClients.set(deviceToken, {
      ws,
      lastSeq: 0,
      ip,
      connectedAt: Date.now(),
    });
    // 上线后立即告知 PWA 当前 Hub 连接状态，省得 PWA 默认显示 'connecting...' 然后才更新。
    const state = this.isHubOnline() ? CONN.OK : CONN.HUB_OFF;
    this._send(ws, { type: MSG.CONN_STATE, state });
  }

  removePwa(deviceToken, ws) {
    const entry = this.pwaClients.get(deviceToken);
    if (entry && entry.ws === ws) {
      this.pwaClients.delete(deviceToken);
    }
  }

  // PWA → Hub
  // 路由优先级：
  //   1. msg.hubId 指定 → 路由到该 hub
  //   2. 否则 → 默认（this.hubAgent，老 PWA 兼容）
  forwardToHub(deviceToken, msg) {
    if (!this.isHubOnline()) {
      const pwa = this.pwaClients.get(deviceToken);
      if (pwa) this._send(pwa.ws, { type: MSG.ERROR, code: ERR.AGENT_OFFLINE });
      return false;
    }
    let targetWs = null;
    if (msg.hubId) {
      targetWs = this.getHubWs(msg.hubId);
      if (!targetWs) {
        // 指定的 hub 不在线，发错误给 PWA
        const pwa = this.pwaClients.get(deviceToken);
        if (pwa) this._send(pwa.ws, { type: MSG.ERROR, code: ERR.AGENT_OFFLINE, hubId: msg.hubId });
        return false;
      }
    } else {
      targetWs = this.hubAgent;
    }
    this._send(targetWs, { ...msg, deviceToken });
    return true;
  }

  // Hub → 指定 PWA
  forwardToPwa(deviceToken, msg) {
    const pwa = this.pwaClients.get(deviceToken);
    if (!pwa) {
      // 设备离线：Hub 端继续写 transcript，下次 PWA 重连用 hello.sinceSeq 拉增量。
      return false;
    }
    if ((msg.type === MSG.TURN || msg.type === MSG.TURN_DELTA) && typeof msg.seq === 'number') {
      pwa.lastSeq = Math.max(pwa.lastSeq, msg.seq);
    }
    return this._send(pwa.ws, msg);
  }

  broadcastToPwa(msg) {
    for (const entry of this.pwaClients.values()) {
      this._send(entry.ws, msg);
    }
  }

  _broadcastConn(state) {
    this.broadcastToPwa({ type: MSG.CONN_STATE, state });
  }

  _send(ws, obj) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  stats() {
    return {
      hubOnline: this.isHubOnline(),
      hubCount: this.hubAgents.size,
      hubs: this.listHubs(),
      pwaCount: this.pwaClients.size,
      devices: Array.from(this.pwaClients.entries()).map(([token, e]) => ({
        token: token.slice(0, 6) + '…',
        lastSeq: e.lastSeq,
        ip: e.ip,
        uptimeMs: Date.now() - e.connectedAt,
      })),
    };
  }
}

module.exports = { Relay };
