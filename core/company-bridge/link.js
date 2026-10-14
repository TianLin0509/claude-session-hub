'use strict';
// 任务通道的一端（家里或公司）：配对状态、加密收发、发件箱重试、在线状态。
//
// 配对（2026-10-15，经独立审查后改为密钥协商）：
//   1. 家里生成初始密钥写进配对码（配对码会经过收件箱网页，可能被人看到）；
//   2. 公司粘贴后生成一对 X25519 临时密钥，把公钥用初始密钥加密发给家里（hello）；
//   3. 家里也生成一对，算出正式密钥，把自己的公钥回给公司（welcome），同时切到正式通道；
//   4. 公司收到 welcome 算出同一把正式密钥。之后两端只用正式密钥。
// 看到配对码的人只能解出两把公钥，算不出正式密钥；配对码 24 小时内没用掉就作废。
// 每次配对有一个代次编号（gen），问题和回执都记着自己属于哪一代：解除配对后旧任务不会发给新对端。
const { randomUUID } = require('node:crypto');
const bridgeCrypto = require('./crypto');
const { BridgeClient } = require('./client');

const OTHER = { home: 'company', company: 'home' };
const OUTBOX_LIMIT = 1000;
const PAIRING_TTL_MS = 24 * 3600000;
const KEEP_TYPES = new Set(['ask', 'followup', 'reply', 'hello', 'welcome']);

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
  activeSecret() { const c = this.config(); return c.state === 'paired' ? c.secret : ['pending', 'waiting-welcome'].includes(c.state) ? c.initialSecret : null; }
  paired() { return this.config().state === 'paired'; }
  gen() { return this.config().gen || null; }
  pairingExpired() { const c = this.config(); return ['pending', 'waiting-welcome'].includes(c.state) && this.now() - (c.createdAt || 0) > PAIRING_TTL_MS; }

  // ---- 家里：生成配对码 ----
  createPairing(baseUrl) {
    const initialSecret = bridgeCrypto.newSecret();
    const url = bridgeCrypto.checkBaseUrl(baseUrl);
    this.saveConfig({ state: 'pending', baseUrl: url, initialSecret, cursor: 0, createdAt: this.now() });
    this.store.set('outbox', []);
    return bridgeCrypto.makePairingCode(url, initialSecret);
  }
  // 家里收到 hello：算正式密钥，welcome 入发件箱和切换配置放在同一个事务里（中途崩溃不会两头不一致）。
  completeAsHome(message) {
    const c = this.config();
    if (c.state !== 'pending') return false;
    const pair = bridgeCrypto.newKeyPair();
    const secret = bridgeCrypto.agree(pair.privateKey, message.pub, c.initialSecret);
    const gen = randomUUID();
    const welcome = this.prepare('welcome', { pub: pair.publicKey, gen }, c.initialSecret);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.set('outbox', [...(this.store.get('outbox') || []), welcome]);
      this.saveConfig({ state: 'paired', baseUrl: c.baseUrl, secret, gen, cursor: 0, epoch: null, pairedAt: this.now(), peerInfo: message.info || null });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return true;
  }
  // ---- 公司：粘贴配对码 ----
  async acceptPairing(code, info = {}) {
    const { baseUrl, secret: initialSecret } = bridgeCrypto.parsePairingCode(code);
    const pair = bridgeCrypto.newKeyPair();
    this.saveConfig({ state: 'waiting-welcome', baseUrl, initialSecret, privateKey: pair.privateKey, cursor: 0, createdAt: this.now() });
    this.store.set('outbox', []);
    await this.send('hello', { pub: pair.publicKey, info }, { secret: initialSecret });
    return this.config();
  }
  completeAsCompany(message) {
    const c = this.config();
    if (c.state !== 'waiting-welcome') return false;
    const secret = bridgeCrypto.agree(c.privateKey, message.pub, c.initialSecret);
    this.saveConfig({ state: 'paired', baseUrl: c.baseUrl, secret, gen: String(message.gen || randomUUID()), cursor: 0, epoch: null, pairedAt: this.now() });
    return true;
  }
  unpair() { this.saveConfig({ state: 'none' }); this.store.set('outbox', []); this.saveStatus({ lastError: null, gate: null, peerSeen: null }); }

  // 封好一条消息（加密 + 消息编号），不发送。
  prepare(type, payload = {}, secret = this.activeSecret()) {
    if (!secret) throw new Error('还没有配对');
    const link = bridgeCrypto.derive(secret);
    const mid = randomUUID();
    const message = { v: 1, mid, type, ts: this.now(), from: this.side, ...payload };
    return { channel: link.channel, to: this.other, mid, blob: bridgeCrypto.seal(link, this.other, message), type, at: this.now() };
  }
  // 发给对端：先放进发件箱再发，失败下一轮原样重发，服务端按编号去重。
  // 发件箱满了先丢进度通知；问题、回执、握手一条不丢，满了就拒绝新消息并报错。
  async send(type, payload = {}, { secret } = {}) {
    const item = this.prepare(type, payload, secret || this.activeSecret());
    let outbox = [...(this.store.get('outbox') || []), item];
    while (outbox.length > OUTBOX_LIMIT) {
      const drop = outbox.findIndex(x => !KEEP_TYPES.has(x.type));
      if (drop < 0) throw new Error('发件箱已满（' + OUTBOX_LIMIT + ' 条没发出去）：先检查网络或放行');
      outbox.splice(drop, 1);
    }
    this.store.set('outbox', outbox);
    await this.flush().catch(() => {});
    return item.mid;
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
        // 服务端通道被清理后重建：序号从头开始，本地游标作废（消息按编号去重，重读无害）。
        const known = this.config().epoch;
        if (page.epoch && known && page.epoch !== known && cursor > 0) { cursor = 0; this.saveConfig({ ...this.config(), cursor: 0, epoch: page.epoch }); more = true; continue; }
        if (page.epoch && !known) this.saveConfig({ ...this.config(), epoch: page.epoch });
        for (const row of page.messages || []) {
          let message = null;
          try { message = bridgeCrypto.open(link, this.side, row.blob); }
          catch { this.saveStatus({ rejected: (this.status().rejected || 0) + 1 }); }
          if (message) { await handle(message, { seq: row.seq, createdAt: row.created_at }); received += 1; }
          cursor = row.seq;
          // 换钥后 handle 已改写配置：游标归新通道，旧通道剩下的消息不再读。
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

module.exports = { BridgeLink, OTHER, PAIRING_TTL_MS };
