'use strict';

// PIN 配对 + 已配对设备列表管理。
//
// 流程：
//   1. 用户在桌面 Hub 点"添加设备" → 调 generatePin() → 显示 6 位 PIN 5 分钟
//   2. 手机 PWA 输入 PIN → POST /api/pair → VPS 转给 Hub 的 PAIR_REQUEST
//   3. Hub 端 verifyPin(pin) → 颁发 deviceToken → 写 mobile-devices.json
//   4. PWA 拿到 deviceToken → 重新连 WSS（device.<token>）
//
// 设备列表持久化到 ${HUB_DATA_DIR}/mobile-devices.json，与 Hub 主 state.json 分离。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PIN_TTL_MS = 5 * 60 * 1000;

class PairManager {
  constructor({ dataDir, logger = console, fixedPin = null }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.devicesPath = path.join(dataDir, 'mobile-devices.json');
    this.fixedPin = fixedPin && /^\d{6}$/.test(fixedPin) ? fixedPin : null;
    this.currentPin = null;
    this.currentPinExpires = 0;
    this._devices = null; // lazy
    this._devicesMtimeMs = 0;
    if (this.fixedPin) {
      this.logger.log(`[mobile-bridge] FIXED PIN mode enabled (PIN never expires, never rotates)`);
    }
  }

  // 生成 6 位 PIN：
  //   - 固定模式 (fixedPin)：返回环境固定值，永不过期（用户便利优先）
  //   - 临时模式：crypto random + 5min TTL + 一次性消费（默认安全模式）
  generatePin() {
    if (this.fixedPin) {
      this.currentPin = this.fixedPin;
      this.currentPinExpires = Number.MAX_SAFE_INTEGER;
      return { pin: this.fixedPin, expiresAt: this.currentPinExpires };
    }
    const buf = crypto.randomBytes(4);
    const n = buf.readUInt32BE(0) % 1000000;
    const pin = String(n).padStart(6, '0');
    this.currentPin = pin;
    this.currentPinExpires = Date.now() + PIN_TTL_MS;
    this.logger.log(`[mobile-bridge] new PIN generated, expires in ${PIN_TTL_MS / 1000}s`);
    return { pin, expiresAt: this.currentPinExpires };
  }

  currentPinInfo() {
    if (this.fixedPin) return { pin: this.fixedPin, expiresAt: Number.MAX_SAFE_INTEGER };
    if (!this.currentPin || Date.now() > this.currentPinExpires) return null;
    return { pin: this.currentPin, expiresAt: this.currentPinExpires };
  }

  // 返回 { ok, deviceToken?, error? }
  verifyPin(pin, deviceName) {
    // 固定模式：PIN 不消费，可重复使用（用户多设备配对方便）
    // rate limit 仍由 VPS 端守住（IP 维度 3 次失败 5 分钟冷却）
    if (this.fixedPin) {
      if (pin !== this.fixedPin) return { ok: false, error: 'invalid_pin' };
      const deviceToken = this._mintToken();
      this._appendDevice({
        token: deviceToken,
        name: String(deviceName || 'unknown').slice(0, 32),
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return { ok: true, deviceToken };
    }
    // 临时模式：一次性消费
    if (!this.currentPin) return { ok: false, error: 'pin_expired' };
    if (Date.now() > this.currentPinExpires) {
      this.currentPin = null;
      return { ok: false, error: 'pin_expired' };
    }
    if (pin !== this.currentPin) return { ok: false, error: 'invalid_pin' };
    this.currentPin = null;
    this.currentPinExpires = 0;
    const deviceToken = this._mintToken();
    this._appendDevice({
      token: deviceToken,
      name: String(deviceName || 'unknown').slice(0, 32),
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return { ok: true, deviceToken };
  }

  // device_token = 128-bit (32 hex chars) random
  _mintToken() {
    return crypto.randomBytes(16).toString('hex');
  }

  _loadDevices() {
    let mtimeMs = 0;
    try {
      if (fs.existsSync(this.devicesPath)) {
        try { mtimeMs = fs.statSync(this.devicesPath).mtimeMs || 0; } catch {}
        if (this._devices && mtimeMs && mtimeMs === this._devicesMtimeMs) return this._devices;
        const raw = fs.readFileSync(this.devicesPath, 'utf8');
        const parsed = JSON.parse(raw);
        this._devices = Array.isArray(parsed.devices) ? parsed.devices : [];
        this._devicesMtimeMs = mtimeMs;
      } else {
        if (this._devices && this._devicesMtimeMs === 0) return this._devices;
        this._devices = [];
        this._devicesMtimeMs = 0;
      }
    } catch (e) {
      this.logger.warn(`[mobile-bridge] failed to load mobile-devices.json: ${e.message}`);
      this._devices = [];
      this._devicesMtimeMs = 0;
    }
    return this._devices;
  }

  _saveDevices() {
    try {
      const tmp = this.devicesPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ devices: this._devices }, null, 2), 'utf8');
      fs.renameSync(tmp, this.devicesPath);
      try { this._devicesMtimeMs = fs.statSync(this.devicesPath).mtimeMs || Date.now(); } catch {}
    } catch (e) {
      this.logger.warn(`[mobile-bridge] failed to save mobile-devices.json: ${e.message}`);
    }
  }

  _appendDevice(d) {
    this._loadDevices();
    this._devices.push(d);
    this._saveDevices();
  }

  listDevices() {
    return this._loadDevices().slice();
  }

  isValidToken(token) {
    if (!token) return false;
    return this._loadDevices().some((d) => d.token === token);
  }

  revokeDevice(token) {
    this._loadDevices();
    const before = this._devices.length;
    this._devices = this._devices.filter((d) => d.token !== token);
    if (this._devices.length !== before) {
      this._saveDevices();
      return true;
    }
    return false;
  }

  touchDevice(token) {
    this._loadDevices();
    const d = this._devices.find((x) => x.token === token);
    if (d) {
      d.lastSeenAt = Date.now();
      this._saveDevices();
    }
  }

  // T11 Web Push：保存设备的 push subscription（endpoint + p256dh + auth）
  // PWA 端 reg.pushManager.subscribe() 拿到后通过 REGISTER_PUSH_SUB 上报
  // 同一 device 重复 subscribe（PWA 重启 / token rotate）→ 覆盖旧 sub
  setPushSub(token, sub, ua) {
    this._loadDevices();
    const d = this._devices.find((x) => x.token === token);
    if (!d) return false;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      // 空 sub == unsubscribe
      d.pushSub = null;
      d.pushSubUpdatedAt = Date.now();
      this._saveDevices();
      return true;
    }
    d.pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    };
    d.pushSubUpdatedAt = Date.now();
    if (ua) d.pushSubUa = String(ua).slice(0, 200);
    this._saveDevices();
    return true;
  }

  // 查 device 的 pushSub（session-binder 发通知时用）
  getPushSub(token) {
    this._loadDevices();
    const d = this._devices.find((x) => x.token === token);
    return (d && d.pushSub) || null;
  }
}

module.exports = { PairManager };
