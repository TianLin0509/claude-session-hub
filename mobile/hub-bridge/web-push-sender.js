'use strict';

// Web Push 发送器（VAPID + aes128gcm 内容加密 + Push Service POST）
// 零外部依赖：纯 Node crypto + https。
//
// 标准：
//   - RFC 8030 Web Push Protocol
//   - RFC 8291 Message Encryption (aes128gcm)
//   - RFC 8292 VAPID (JWT ES256)
//
// 设计：
//   - VAPID keypair 第一次启动自动生成，存 ${dataDir}/mobile-vapid.json
//   - sendNotification(subscription, payload) 返回 Promise<{ok, status, error?}>
//   - 不重试（失败上层决定），不持久化 retry queue（push service 自己有 TTL）
//
// 不实现：
//   - aesgcm 老编码（仅 aes128gcm，Chrome 60+/Firefox 55+/Safari 16.4+ 都支持）
//   - VAPID body audience auto-detection（用 endpoint origin 即可）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============ VAPID 密钥管理 ============

function loadOrCreateVapidKeys(dataDir, logger = console) {
  const p = path.join(dataDir, 'mobile-vapid.json');
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && raw.publicKey && raw.privateKey) {
        return raw;
      }
    }
  } catch (e) {
    logger.warn(`[web-push] failed to load mobile-vapid.json: ${e.message}`);
  }
  // 生成 P-256 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // 导出 raw uncompressed 公钥（65 bytes: 0x04 + X + Y）
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' });
  // SPKI 末尾 65 字节就是 uncompressed point
  const pubUncompressed = pubRaw.slice(pubRaw.length - 65);
  // 私钥 raw 32 bytes
  const privPkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  // PKCS#8 中 EC private key 在 OCTET STRING 内部；用 jwk 提取更稳
  const privJwk = privateKey.export({ format: 'jwk' });
  const privRaw = Buffer.from(privJwk.d, 'base64url');

  const keys = {
    publicKey: pubUncompressed.toString('base64url'),
    privateKey: privRaw.toString('base64url'),
    createdAt: Date.now(),
  };
  try {
    fs.writeFileSync(p, JSON.stringify(keys, null, 2), 'utf8');
    try { fs.chmodSync(p, 0o600); } catch {}
    logger.log(`[web-push] VAPID keypair generated → ${p}`);
  } catch (e) {
    logger.warn(`[web-push] failed to persist VAPID keys: ${e.message}`);
  }
  return keys;
}

// ============ VAPID JWT (ES256) ============

function signVapidJwt({ audience, subject, privateKeyB64u, ttlSec = 12 * 3600 }) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + ttlSec,
    sub: subject || 'mailto:hub@localhost',
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const privRaw = Buffer.from(privateKeyB64u, 'base64url');
  // 还原 P-256 私钥：用 SEC1 DER（ECPrivateKey）格式直接 createPrivateKey
  // 比 jwk 方案稳（jwk 要算 x/y，依赖额外 ecdh.computeSecret 反算）
  const keyObj = crypto.createPrivateKey({
    key: derEncodeEcPrivateKey(privRaw),
    format: 'der', type: 'sec1',
  });
  const derSig = crypto.sign('sha256', Buffer.from(signingInput), keyObj);
  const rawSig = derToRaw(derSig, 32);
  return `${signingInput}.${rawSig.toString('base64url')}`;
}

// SEC1 EC private key DER: 包一层 OCTET STRING (rfc 5915)
function derEncodeEcPrivateKey(privRaw32) {
  // SEC1 ECPrivateKey ::= SEQUENCE {
  //   version INTEGER (1),
  //   privateKey OCTET STRING,
  //   [0] parameters ECParameters (P-256 OID 1.2.840.10045.3.1.7),
  // }
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const privOctet = Buffer.concat([Buffer.from([0x04, 0x20]), privRaw32]);
  // P-256 named curve OID
  const oid = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const params = Buffer.concat([Buffer.from([0xa0, oid.length]), oid]);
  const body = Buffer.concat([version, privOctet, params]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

// DER ECDSA sig → raw (r || s) fixed-len
function derToRaw(der, n) {
  // DER: 30 LL 02 rLen r... 02 sLen s...
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  if (der[i] !== 0x02) throw new Error('bad DER');
  const rLen = der[i + 1]; i += 2;
  let r = der.slice(i, i + rLen); i += rLen;
  if (der[i] !== 0x02) throw new Error('bad DER');
  const sLen = der[i + 1]; i += 2;
  let s = der.slice(i, i + sLen);
  // strip leading 0x00
  while (r.length > n && r[0] === 0x00) r = r.slice(1);
  while (s.length > n && s[0] === 0x00) s = s.slice(1);
  // left-pad
  if (r.length < n) r = Buffer.concat([Buffer.alloc(n - r.length), r]);
  if (s.length < n) s = Buffer.concat([Buffer.alloc(n - s.length), s]);
  return Buffer.concat([r, s]);
}

// ============ aes128gcm 内容加密 (RFC 8291) ============

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  let counter = 1;
  while (out.length < length) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([counter])])).digest();
    out = Buffer.concat([out, t]);
    counter++;
  }
  return out.slice(0, length);
}

// 把 base64url 公钥（65B uncompressed）转 KeyObject
function publicKeyFromUncompressed(raw65) {
  // SPKI prefix for uncompressed EC P-256 public key:
  // 30 59 30 13 06 07 2a8648ce3d0201 06 08 2a8648ce3d030107 03 42 00 <65 bytes>
  const spkiPrefix = Buffer.from([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]);
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, raw65]),
    format: 'der', type: 'spki',
  });
}

function encryptPayload(payload, clientPubB64u, clientAuthB64u) {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const clientPub = Buffer.from(clientPubB64u, 'base64url');
  const clientAuth = Buffer.from(clientAuthB64u, 'base64url');

  // 1) 生成 ephemeral ECDH P-256
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const localPubUncompressed = ecdh.getPublicKey(); // 65 bytes
  // 2) ECDH 共享密钥
  const sharedSecret = ecdh.computeSecret(clientPub);

  // 3) salt 16 bytes random
  const salt = crypto.randomBytes(16);

  // 4) RFC 8291: PRK_key = HKDF(auth, shared, "WebPush: info\0" || client_pub || as_pub, 32)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    clientPub,
    localPubUncompressed,
  ]);
  const prkKey = hkdf(clientAuth, sharedSecret, keyInfo, 32);

  // 5) IKM = PRK_key（用作 HKDF ikm for content key + nonce）
  // CEK = HKDF(salt, prkKey, "Content-Encoding: aes128gcm\0", 16)
  // NONCE = HKDF(salt, prkKey, "Content-Encoding: nonce\0", 12)
  const cek = hkdf(salt, prkKey, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, prkKey, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // 6) padding：plaintext + 0x02 + 0x00...（aes128gcm 末尾 delimiter = 2）
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  // 7) AES-128-GCM encrypt
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 8) aes128gcm header: salt (16) || rs (4 BE = 4096) || idlen (1) || keyid (uncompressed as_pub 65)
  const header = Buffer.concat([
    salt,
    Buffer.from([0x00, 0x00, 0x10, 0x00]), // rs = 4096
    Buffer.from([65]),                       // keyid len
    localPubUncompressed,                    // keyid = ephemeral pub
  ]);

  return Buffer.concat([header, ciphertext, tag]);
}

// ============ 发送 ============

class WebPushSender {
  constructor({ dataDir, subject, logger = console, agent = null }) {
    this.dataDir = dataDir;
    this.subject = subject || 'mailto:hub@localhost';
    this.logger = logger;
    this.agent = agent;
    this.keys = loadOrCreateVapidKeys(dataDir, logger);
  }

  getPublicKey() {
    return this.keys.publicKey;
  }

  // subscription: { endpoint, keys: { p256dh, auth } }
  // payload: string (JSON 化的通知数据)
  // 返回 Promise<{ok, status, body?, error?}>
  send(subscription, payload, { ttl = 60, urgency = 'high' } = {}) {
    return new Promise((resolve) => {
      try {
        const { endpoint } = subscription;
        const p256dh = subscription.keys && subscription.keys.p256dh;
        const auth = subscription.keys && subscription.keys.auth;
        if (!endpoint || !p256dh || !auth) {
          return resolve({ ok: false, status: 0, error: 'bad subscription' });
        }
        const url = new URL(endpoint);
        const audience = `${url.protocol}//${url.host}`;
        const jwt = signVapidJwt({
          audience, subject: this.subject, privateKeyB64u: this.keys.privateKey,
        });
        const body = encryptPayload(payload, p256dh, auth);
        const headers = {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'TTL': String(ttl),
          'Urgency': urgency,
          'Authorization': `vapid t=${jwt}, k=${this.keys.publicKey}`,
        };
        const lib = url.protocol === 'https:' ? https : http;
        const opts = {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + (url.search || ''),
          headers,
          agent: this.agent,
          timeout: 15000,
        };
        const req = lib.request(opts, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c.toString(); });
          res.on('end', () => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            resolve({ ok, status: res.statusCode, body: buf.slice(0, 200) });
          });
        });
        req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
        req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, status: 0, error: 'timeout' }); });
        req.write(body);
        req.end();
      } catch (e) {
        resolve({ ok: false, status: 0, error: e.message });
      }
    });
  }
}

module.exports = { WebPushSender, loadOrCreateVapidKeys };
