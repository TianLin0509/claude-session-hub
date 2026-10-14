'use strict';
// 任务通道的一端（家里或公司）：配对状态、加密收发、发件箱重试、在线状态。
//
// 配对（2026-10-15）：家里生成初始密钥写进配对码；公司粘贴配对码后立刻自己再生成一把新密钥，
// 用初始密钥加密发给家里（hello），之后两端只用新密钥。配对码经过收件箱网页中转、可能被看到，
// 换钥后它就作废了。家里只认第一个 hello，公司收到家里的 welcome 才算接通。
const { randomUUID } = require('node:crypto');
const bridgeCrypto = require('./crypto');
const { BridgeClient } = require('./client');

const OTHER = { home: 'company', company: 'home' };
const OUTBOX_LIMIT = 200;

class BridgeLink {
  constructor({ side, store, fetchImpl, now }) {
    if (!OTHER[side]) throw new Error('side 只能是 home 或 company');
    this.side = side; this.other = OTHER[side]; this.store = store; this.fetchImpl = fetchImpl;
    this.now = now || (() => Date.now());
  }
  config() { return this.store.get('link') || { state: 'none' }; }
  saveConfig(next) { this.store.set('link', next); return next; }
  status() { return this.store.get('linkStatus') || {}; }
  saveStatus(patch) { const next = { ...this.status(), ...patch }; this.store.set('linkStatus', next); return next; }
  client(baseUrl = this.config().baseUrl) { return new BridgeClient({ baseUrl, fetchImpl: this.fetchImpl }); }
  activeSecret() { const c = this.config(); return c.state === 'pending' ? c.pendingSecret : c.secret; }
  paired() { return ['paired', 'waiting-welcome'].includes(this.config().state); }

  // ---- 家里：生成配对码 ----
  createPairing(baseUrl) {
    const secret = bridgeCrypto.newSecret();
    const url = bridgeCrypto.checkBaseUrl(baseUrl);
    this.saveConfig({ state: 'pending', baseUrl: url, pendingSecret: secret, secret: null, cursor: 0, createdAt: this.now() });
    this.store.set('outbox', []);
    return bridgeCrypto.makePairingCode(url, secret);
  }
  // ---- 公司：粘贴配对码 ----
  async acceptPairing(code, info = {}) {
    const { baseUrl, secret: initial } = bridgeCrypto.parsePairingCode(code);
    const secret = bridgeCrypto.newSecret();
    this.saveConfig({ state: 'waiting-welcome', baseUrl, secret, cursor: 0, createdAt: this.now() });
    this.store.set('outbox', []);
    await this.send('hello', { secret, info }, { secret: initial });
    return this.config();
  }
  unpair() { this.saveConfig({ state: 'none' }); this.store.set('outbox', []); this.saveStatus({ lastError: null, gate: null, peerSeen: null }); }

  // 发给对端：先封好（加密 + 消息编号）放进发件箱再发，失败下一轮原样重发，服务端按编号去重。
  async send(type, payload = {}, { secret } = {}) {
    const key = secret || this.activeSecret();
    if (!key) throw new Error('还没有配对');
    const link = bridgeCrypto.derive(key);
    const mid = randomUUID();
    const message = { v: 1, mid, type, ts: this.now(), from: this.side, ...payload };
    const item = { channel: link.channel, to: this.other, mid, blob: bridgeCrypto.seal(link, this.other, message), type, at: this.now() };
    const outbox = [...(this.store.get('outbox') || []), item].slice(-OUTBOX_LIMIT);
    this.store.set('outbox', outbox);
    await this.flush().catch(() => {});
    return mid;
  }
  pendingOutbox() { return (this.store.get('outbox') || []).length; }
  async flush() {
    const outbox = this.store.get('outbox') || [];
    if (!outbox.length) return 0;
    const client = this.client();
    let sent = 0;
    try {
      for (const item of outbox) {
        await client.post(item.channel, item.to, item.mid, item.blob);
        sent += 1;
        this.store.set('outbox', (this.store.get('outbox') || []).filter(x => x.mid !== item.mid));
      }
      this.ok();
    } catch (error) { this.fail(error); throw error; }
    return sent;
  }

  // 拉取发给本端的新消息，逐条解密交给 handle；handle 抛错就停在这条，下轮重试。
  async pull(handle) {
    const config = this.config();
    const secret = this.activeSecret();
    if (!secret) return { received: 0 };
    await this.flush().catch(() => {});
    const link = bridgeCrypto.derive(secret);
    const client = this.client(config.baseUrl);
    let received = 0, more = true, cursor = config.cursor || 0;
    try {
      while (more) {
        const page = await client.fetchMessages(link.channel, this.side, cursor, this.side);
        this.saveStatus({ peerSeen: page.seen && page.seen[this.other] || null, serverTime: page.server_time || null });
        for (const row of page.messages || []) {
          let message = null;
          try { message = bridgeCrypto.open(link, this.side, row.blob); }
          catch { this.saveStatus({ rejected: (this.status().rejected || 0) + 1 }); }
          if (message) { await handle(message, { seq: row.seq, createdAt: row.created_at }); received += 1; }
          cursor = row.seq;
          // 换钥（家里收到 hello）后 handle 已改写配置，游标归新通道所有，旧通道剩下的消息不再读。
          const latest = this.config();
          if (latest.state !== config.state || this.activeSecret() !== secret) return { received, switched: true };
          this.saveConfig({ ...latest, cursor });
        }
        more = !!page.more;
      }
      this.ok();
    } catch (error) { this.fail(error); throw error; }
    return { received };
  }

  ok() { this.saveStatus({ lastOkAt: this.now(), lastError: null, gate: null }); }
  fail(error) {
    const at = this.now();
    const lastError = { code: error && error.code || 'error', message: String(error && error.message || error).slice(0, 300), at };
    this.saveStatus({ lastError, gate: lastError.code === 'gate' ? { since: this.status().gate?.since || at, url: error.gateUrl || this.client().gatePage() } : null });
  }
}

module.exports = { BridgeLink, OTHER };
