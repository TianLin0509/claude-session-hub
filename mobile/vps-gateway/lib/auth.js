'use strict';

// 鉴权相关：
// - Hub 端：固定 BEARER_TOKEN（环境变量配置，timingSafeEqual 比较）
// - PWA 端：device_token（128-bit random），缓存命中走快路径，未命中走 Hub 反向校验
// - PIN：6 位数字 + 3 次失败 5 分钟冷却（按 IP 维度，防爆破）

const crypto = require('crypto');

const PIN_FAIL_THRESHOLD = 3;
const PIN_LOCK_MS = 5 * 60 * 1000;
const DEVICE_CACHE_TTL_MS = 60 * 60 * 1000;

class PinRateLimiter {
  constructor() {
    this._fails = new Map(); // ip -> { count, lockUntil }
  }
  isLocked(ip) {
    const r = this._fails.get(ip);
    if (!r) return false;
    if (r.lockUntil && Date.now() < r.lockUntil) return true;
    if (r.lockUntil && Date.now() >= r.lockUntil) {
      this._fails.delete(ip);
      return false;
    }
    return false;
  }
  recordFail(ip) {
    const r = this._fails.get(ip) || { count: 0, lockUntil: 0 };
    r.count += 1;
    if (r.count >= PIN_FAIL_THRESHOLD) {
      r.lockUntil = Date.now() + PIN_LOCK_MS;
    }
    this._fails.set(ip, r);
  }
  reset(ip) {
    this._fails.delete(ip);
  }
}

// timingSafeEqual 要求等长 buffer，否则抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH。
// 不等长时不能 early return（会泄漏长度），用等长 dummy buffer 比较后返回 false。
function constantTimeEq(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, Buffer.alloc(ba.length, 0));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function verifyBearer(token, expected) {
  if (!token || !expected) return false;
  return constantTimeEq(token, expected);
}

// VPS 端不存全量 device_token 列表（持久化在 Hub 端 mobile-devices.json），
// 缓存最近 1h 验证过的 token 加速重连。撤销路径：Hub 端删 token 后，
// 1h 内 PWA 重连仍可能命中缓存（设计权衡）；安全敏感场景可缩短 TTL。
class DeviceTokenCache {
  constructor() {
    this._ok = new Map(); // token -> expiresAt
  }
  isVerified(token) {
    const exp = this._ok.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
      this._ok.delete(token);
      return false;
    }
    return true;
  }
  remember(token) {
    if (!token) return;
    this._ok.set(token, Date.now() + DEVICE_CACHE_TTL_MS);
  }
  forget(token) {
    this._ok.delete(token);
  }
}

module.exports = {
  PinRateLimiter,
  DeviceTokenCache,
  verifyBearer,
  constantTimeEq,
  PIN_FAIL_THRESHOLD,
  PIN_LOCK_MS,
  DEVICE_CACHE_TTL_MS,
};
