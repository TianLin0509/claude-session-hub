'use strict';

// 远程模式核心客户端（公司电脑侧，跑在 Hub main process）。
// 角色等价于一个"原生 PWA"：经 VPS 网关 /pwa 端点连回家里 Hub，
// 用 device token 认证（PIN 配对获得），全程显式 hubId 定向路由。
//
// 设计：
// - 配置持久化 ${dataDir}/remote-hub.json（gatewayUrl/directIp/deviceToken/targetHubId/lastSeq）
// - directIp：TCP 直连 VPS IP 绕过 Cloudflare 边缘（国内直连 CF 长连接被间歇重置，
//   2026-06-11 A/B 实测 CF 路 45s 即 1006；SNI/Host/证书校验仍按域名走，安全不降级）
// - 重连指数退避 + hello{sinceSeq} 增量回灌（复用 PWA 协议语义）
// - 本模块不碰本地 sessionManager —— 它只是远端会话的镜像通道

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { MSG } = require('../shared/protocol');

const HEARTBEAT_MS = 15 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

class RemoteHubClient extends EventEmitter {
  constructor({ dataDir, logger = console }) {
    super();
    this.dataDir = dataDir;
    this.logger = logger;
    this.configPath = path.join(dataDir, 'remote-hub.json');
    this.config = this._loadConfig();
    this.ws = null;
    this.state = 'disconnected'; // disconnected | connecting | connected
    this.connState = null;       // 网关上报的家里 Hub 状态: ok | weak | hub-off | vps-off
    this.hubs = [];              // 最近一次 hub-list
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.hbTimer = null;
    this._closedByUser = false;
    this._pending = new Map();   // requestId -> { resolve, reject, timer }
    this._saveSeqTimer = null;
  }

  // ---------- 配置 ----------

  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    } catch {
      return { gatewayUrl: '', directIp: '', deviceToken: '', targetHubId: '', deviceName: '', lastSeq: 0 };
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) {
      this.logger.warn(`[remote-hub] save config failed: ${e.message}`);
    }
  }

  isConfigured() {
    return Boolean(this.config.gatewayUrl && this.config.deviceToken);
  }

  setTargetHub(hubId) {
    this.config.targetHubId = hubId || '';
    this._saveConfig();
    this.emit('status', this.status());
  }

  status() {
    return {
      configured: this.isConfigured(),
      state: this.state,
      connState: this.connState,
      gatewayUrl: this.config.gatewayUrl || '',
      directIp: this.config.directIp || '',
      targetHubId: this.config.targetHubId || '',
      deviceName: this.config.deviceName || '',
      hubs: this.hubs,
    };
  }

  // ---------- PIN 配对 ----------

  // gatewayUrl 形如 https://lthub.xyz:8443（http(s) 形式；ws 地址由此推导）
  async pair({ gatewayUrl, pin, deviceName, directIp }) {
    const base = String(gatewayUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new Error('网关地址必须以 http(s):// 开头');
    if (!/^\d{6}$/.test(String(pin || ''))) throw new Error('PIN 必须是 6 位数字');
    const body = JSON.stringify({ pin: String(pin), deviceName: String(deviceName || 'company-hub').slice(0, 32) });
    const result = await this._httpPost(`${base}/api/pair`, body, directIp);
    if (!result.deviceToken) {
      throw new Error(result.error || 'pair failed');
    }
    this.config.gatewayUrl = base;
    this.config.deviceToken = result.deviceToken;
    this.config.deviceName = deviceName || 'company-hub';
    if (directIp !== undefined) this.config.directIp = directIp || '';
    this.config.lastSeq = 0;
    this._saveConfig();
    this.logger.log(`[remote-hub] paired, token=${result.deviceToken.slice(0, 8)}…`);
    return { ok: true };
  }

  _httpPost(url, body, directIp) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const opts = {
        method: 'POST',
        hostname: directIp || u.hostname,
        port: u.port || 443,
        path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: u.host },
        timeout: 15000,
      };
      if (directIp) {
        opts.servername = u.hostname;
        opts.checkServerIdentity = (_h, cert) => tls.checkServerIdentity(u.hostname, cert);
      }
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); } catch { resolve({ error: `bad response (${res.statusCode})` }); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('pair request timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---------- 连接 ----------

  connect() {
    if (!this.isConfigured()) return false;
    if (this.state === 'connecting' || this.state === 'connected') return true;
    this._closedByUser = false;
    this._setState('connecting');
    try {
      const wsUrl = this.config.gatewayUrl.replace(/^http/, 'ws') + '/pwa';
      let target = wsUrl;
      const opts = { handshakeTimeout: 30000 };
      if (this.config.directIp) {
        const u = new URL(wsUrl);
        const host = u.hostname;
        u.hostname = this.config.directIp;
        target = u.toString();
        opts.servername = host;
        opts.headers = { Host: u.port ? `${host}:${u.port}` : host };
        opts.checkServerIdentity = (_h, cert) => tls.checkServerIdentity(host, cert);
      }
      this.ws = new WebSocket(target, [`device.${this.config.deviceToken}`], opts);
    } catch (e) {
      this.logger.warn(`[remote-hub] connect error: ${e.message}`);
      this._setState('disconnected');
      this._scheduleReconnect();
      return false;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
    this.ws.on('error', (err) => this.logger.warn(`[remote-hub] ws error: ${err.message}`));
    return true;
  }

  disconnect() {
    this._closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.ws) try { this.ws.close(1000, 'user disconnect'); } catch {}
    this._setState('disconnected');
  }

  _onOpen() {
    this.reconnectAttempts = 0;
    this._setState('connected');
    this.logger.log(`[remote-hub] connected to ${this.config.gatewayUrl}`);
    this._send({ type: 'hello', sinceSeq: this.config.lastSeq || 0 });
    this.requestHubList();
    this.requestSessionList();
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => this._send({ type: 'pong', ts: Date.now() }), HEARTBEAT_MS);
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'ping':
        this._send({ type: 'pong', ts: Date.now() });
        return;
      case 'pong':
        return;
      case 'conn-state':
        this.connState = msg.state;
        this.emit('status', this.status());
        return;
      case 'hub-list':
        this.hubs = msg.hubs || [];
        // 目标 hub 未设或已下线 → 自动选最早启动的在线 hub（最稳定的那个）
        if (this.hubs.length && !this.hubs.some((h) => h.hubId === this.config.targetHubId)) {
          const sorted = [...this.hubs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
          this.config.targetHubId = sorted[0].hubId;
          this._saveConfig();
        }
        this.emit('hub-list', this.hubs);
        this.emit('status', this.status());
        return;
      case 'session-list':
        this.emit('session-list', msg.sessions || []);
        return;
      case 'turn':
      case 'turn-delta': {
        if (typeof msg.seq === 'number' && msg.seq > (this.config.lastSeq || 0)) {
          this.config.lastSeq = msg.seq;
          this._scheduleSaveSeq();
        }
        this.emit('turn', msg);
        return;
      }
      case 'hub-snapshot':
        // 家里 Hub 的真实桌面会话/群聊卡片（全量）
        this.emit('hub-snapshot', msg.snapshot || null);
        return;
      case 'pty-snapshot':
      case 'pty-data':
      case 'pty-ack':
        // 终端镜像流（Phase 2）：原样透传给 renderer 的 xterm
        this.emit(msg.type, msg);
        return;
      case 'hub-delta':
        // 桌面会话增量（turn 完成 / 卡片更新）
        this.emit('hub-delta', msg);
        return;
      case 'command-ack': {
        // 定向投递回执：按 clientId 匹配 pending
        if (msg.clientId && this._pending.has(msg.clientId)) {
          const p = this._pending.get(msg.clientId);
          this._pending.delete(msg.clientId);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg);
          else p.reject(new Error(msg.error || 'command rejected'));
        }
        return;
      }
      case 'session-created':
      case 'session-destroyed':
      case 'meeting-list':
      case 'artifact-list':
      case 'artifact-content':
      case 'error': {
        if (msg.requestId && this._pending.has(msg.requestId)) {
          const p = this._pending.get(msg.requestId);
          this._pending.delete(msg.requestId);
          clearTimeout(p.timer);
          if (msg.type === 'error') p.reject(new Error(msg.error || msg.code || 'remote error'));
          else p.resolve(msg);
          return;
        }
        this.emit(msg.type, msg);
        return;
      }
      default:
        this.emit('message', msg);
    }
  }

  _onClose(code, reason) {
    this.logger.log(`[remote-hub] disconnected: code=${code} reason=${reason}`);
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    this._setState('disconnected');
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
    this._pending.clear();
    if (this._closedByUser) return;
    if (code === 4003) {
      this.logger.error('[remote-hub] device token rejected — re-pair needed');
      this.emit('auth-failed');
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('status', this.status());
  }

  _scheduleSaveSeq() {
    if (this._saveSeqTimer) return;
    this._saveSeqTimer = setTimeout(() => {
      this._saveSeqTimer = null;
      this._saveConfig();
    }, 2000);
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // ---------- 远程操作（全部显式 hubId 定向） ----------

  requestHubList() {
    return this._send({ type: 'list-hubs', requestId: `hl-${Date.now()}` });
  }

  requestSessionList() {
    return this._send({ type: 'list-sessions', hubId: this.config.targetHubId || undefined });
  }

  // 请求家里 Hub 的桌面会话/群聊卡片快照（响应走 'hub-snapshot' 事件）
  requestHubSnapshot() {
    return this._send({
      type: 'hub-snapshot-req',
      requestId: `snap-${Date.now()}`,
      hubId: this.config.targetHubId || undefined,
    });
  }

  // ---- 终端镜像（Phase 2）----

  subscribePty(sessionId, sinceSeq = 0) {
    return this._send({
      type: 'pty-subscribe',
      sessionId,
      sinceSeq,
      hubId: this.config.targetHubId || undefined,
    });
  }

  unsubscribePty(sessionId) {
    return this._send({
      type: 'pty-unsubscribe',
      sessionId,
      hubId: this.config.targetHubId || undefined,
    });
  }

  sendPtyInput(sessionId, dataB64) {
    return this._send({
      type: 'pty-input',
      sessionId,
      dataB64,
      hubId: this.config.targetHubId || undefined,
    });
  }

  resizePty(sessionId, cols, rows) {
    return this._send({
      type: 'pty-resize',
      sessionId,
      cols,
      rows,
      hubId: this.config.targetHubId || undefined,
    });
  }

  // 定向投递 prompt 到家里 Hub 的真实桌面会话（targetType: 'session'|'meeting'）
  sendCommand(targetType, targetId, content) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'connected') return reject(new Error('not connected'));
      const clientId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this._pending.delete(clientId);
        reject(new Error('command ack timeout'));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(clientId, { resolve, reject, timer });
      const sent = this._send({
        type: 'hub-command',
        clientId,
        targetType,
        targetId,
        content,
        hubId: this.config.targetHubId || undefined,
      });
      if (!sent) {
        clearTimeout(timer);
        this._pending.delete(clientId);
        reject(new Error('send failed'));
      }
    });
  }

  sendInput(sessionId, content) {
    return this._send({
      type: MSG.PWA_INPUT, // 'input'
      sessionId,
      content,
      hubId: this.config.targetHubId || undefined,
    });
  }

  newSession(kind, title) {
    return this._request({
      type: MSG.NEW_SESSION,
      kind: kind || 'claude',
      title: title || '远程会话',
      hubId: this.config.targetHubId || undefined,
    });
  }

  // 家里侧 SESSION_DESTROYED 不回 requestId，fire-and-forget，
  // 结果以 session-list 事件刷新形式到达
  destroySession(sessionId) {
    return this._send({
      type: MSG.DESTROY_SESSION,
      sessionId,
      hubId: this.config.targetHubId || undefined,
    });
  }

  // 带 requestId 的请求-响应封装
  _request(msg) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'connected') return reject(new Error('not connected'));
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error('remote request timeout'));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(requestId, { resolve, reject, timer });
      if (!this._send({ ...msg, requestId })) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        reject(new Error('send failed'));
      }
    });
  }
}

module.exports = { RemoteHubClient };
