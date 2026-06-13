'use strict';

// Hub 端 outbound WSS client。
// 连 VPS gateway 的 /agent endpoint，bearer 子协议鉴权。
// 重连指数退避；心跳 30s；状态变化通过 EventEmitter 上报。
//
// 设计要点：
// - 出 NAT，所以是 Hub 主动连 VPS（不是 VPS 连 Hub），绕开家里没公网 IP
// - 单连接（一个家庭 Hub 对应一个 VPS agent slot）
// - 断线后 1s/2s/4s/8s/16s/30s 退避重连，永不放弃

const os = require('os');
const tls = require('tls');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { MSG } = require('../shared/protocol');

// Hub 启动时即固定（同一进程内不变）
const HUB_ID = `${os.hostname()}-pid${process.pid}-${Date.now()}`;
const HUB_STARTED_AT = Date.now();

// 15s（原 30s）：网关 30s isAlive 窗口内保证至少 1 条消息，消除相位竞争被误踢
const HEARTBEAT_MS = 15 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;

class OutboundClient extends EventEmitter {
  // directIp：可选。设置后 TCP 直连该 IP（绕过域名 DNS → Cloudflare 边缘），
  // TLS SNI / Host / 证书校验仍按 url 里的域名走，安全性不降级。
  // 背景：国内直连 CF 边缘的长连接会被间歇性重置（2026-06-11 A/B 实测：
  // CF 路 45s 即 1006，直连 VPS 路零断连），生产 Hub 因此每 10~30s 断连一次。
  constructor({ url, bearerToken, logger = console, vapidPublicKey = null, directIp = null }) {
    super();
    this.url = url;
    this.directIp = directIp;
    this.bearerToken = bearerToken;
    this.logger = logger;
    this.ws = null;
    this.state = 'disconnected';
    this.reconnectAttempts = 0;
    this.hbTimer = null;
    this.reconnectTimer = null;
    this._closedByUser = false;
    // T11：Hub 自报 VAPID 公钥，gateway 透传到 PWA hub-list
    // PWA 拿到后才能 reg.pushManager.subscribe({ applicationServerKey })
    this.vapidPublicKey = vapidPublicKey;
  }

  // 上层 lazy init 完成后注入（vapid 可能比 outbound 晚 ready）
  setVapidPublicKey(key) {
    this.vapidPublicKey = key;
  }

  connect() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this._closedByUser = false;
    this._setState('connecting');
    try {
      let target = this.url;
      const opts = {
        // 30s 握手超时，防 VPS 不可达时挂死
        handshakeTimeout: 30000,
      };
      if (this.directIp) {
        const u = new URL(this.url);
        const host = u.hostname;
        u.hostname = this.directIp;
        target = u.toString();
        opts.servername = host;
        opts.headers = { Host: u.port ? `${host}:${u.port}` : host };
        opts.checkServerIdentity = (_h, cert) => tls.checkServerIdentity(host, cert);
      }
      this.ws = new WebSocket(target, [`bearer.${this.bearerToken}`], opts);
    } catch (e) {
      this.logger.warn(`[mobile-bridge] connect error: ${e.message}`);
      this._setState('disconnected');
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
    this.ws.on('error', (err) => this.logger.warn(`[mobile-bridge] ws error: ${err.message}`));
  }

  disconnect() {
    this._closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.ws) try { this.ws.close(1000, 'shutdown'); } catch {}
    this._setState('disconnected');
  }

  send(obj) {
    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== 1) {
      // Hub 端消息不入队（不像 PWA 那样关心离线缓存）——
      // 离线期间 Claude 仍在 spawn，turn-complete 事件会触发再发；
      // 重连后 PWA 用 sinceSeq 拉增量补齐。
      return false;
    }
    try {
      const payload = obj && typeof obj === 'object' && !obj.hubId ? { ...obj, hubId: HUB_ID } : obj;
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      this.logger.warn(`[mobile-bridge] send failed: ${e.message}`);
      return false;
    }
  }

  _onOpen() {
    this.reconnectAttempts = 0;
    this._setState('connected');
    this.logger.log(`[mobile-bridge] connected to ${this.url} (hubId=${HUB_ID})`);
    // Hub 自报家门：含 hubId + pid + hostname + version + startedAt
    // VPS gateway 用这些信息维护 multi-hub list 给 PWA 选
    this.send({
      type: MSG.HELLO,
      hubId: HUB_ID,
      pid: process.pid,
      hostname: os.hostname(),
      version: '0.2.0',
      startedAt: HUB_STARTED_AT,
      friendlyName: `Hub PID ${process.pid}`,
      // T11 Web Push：VAPID 公钥跟 hello 一起上送，gateway 缓存进 hub-list 给 PWA 用
      // 没 vapid 时（极旧 hub 或初始化失败）字段为 null，PWA 检测到就不开 push
      vapidPublicKey: this.vapidPublicKey || null,
    });
    // 心跳
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      this.send({ type: MSG.PONG, ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.type) return;
    // 转发给上层
    this.emit('message', msg);
  }

  _onClose(code, reason) {
    this.logger.log(`[mobile-bridge] disconnected: code=${code} reason=${reason}`);
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    this._setState('disconnected');
    if (this._closedByUser) return;
    if (code === 4003) {
      // 鉴权失败，停止重连（避免无限循环把 VPS 打挂）
      this.logger.error('[mobile-bridge] auth failed (4003) — check HUB_BEARER_TOKEN');
      this.emit('auth-failed');
      return;
    }
    this._scheduleReconnect();
  }

  _setState(s) {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    this.emit('state', { from: prev, to: s });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.logger.log(`[mobile-bridge] reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

module.exports = { OutboundClient, HUB_ID, HUB_STARTED_AT };
