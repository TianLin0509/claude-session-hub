'use strict';

// Hub 自更新（源码热更新通道）。
// 原理：Hub 是源码直跑（无编译产物），更新 = 从 VPS 拉一个几 MB 的源码 zip
// 覆盖到应用目录（node_modules / electron 不动），然后 app.relaunch()。
// node_modules 变更（package.json deps 变化）属于罕见事件，由 manifest 的
// minFullVersion 标记 → 提示用户重新下载完整便携包。
//
// 更新源：https://lthub.xyz:8443/hub-update/manifest.json（家里跑 tools/publish-hub-update.ps1 发布）
// manifest: { version, zip, sha256, minFullVersion, notes, ts }
//
// 安全：HTTPS（Let's Encrypt 证书校验）+ sha256 完整性校验；支持 directIp
// 直连绕 Cloudflare（SNI/证书仍按域名走，公司网络/国内更稳）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_BASE = 'https://lthub.xyz:8443';
const DEFAULT_DIRECT_IP = '138.128.192.245';

function _httpGet(url, { directIp = null, asBuffer = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method: 'GET',
      hostname: directIp || u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { Host: u.host },
      timeout: timeoutMs,
    };
    if (directIp) {
      opts.servername = u.hostname;
      opts.checkServerIdentity = (_h, cert) => tls.checkServerIdentity(u.hostname, cert);
    }
    const req = https.request(opts, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${u.pathname}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
    req.end();
  });
}

// 简单语义化版本比较：a > b 返回 1，相等 0，小于 -1
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

class SelfUpdater {
  // appRoot: Hub 源码根目录；getRemoteConfig: 可选，返回 remote-hub.json 内容
  //（复用其 gatewayUrl/directIp 作为更新源，没配则用默认 lthub.xyz）
  constructor({ appRoot, getRemoteConfig = null, logger = console }) {
    this.appRoot = appRoot;
    this.getRemoteConfig = getRemoteConfig;
    this.logger = logger;
    this.lastCheck = null; // { current, latest, updateAvailable, needsFullPackage, notes }
  }

  _source() {
    let base = DEFAULT_BASE;
    let directIp = DEFAULT_DIRECT_IP;
    try {
      const cfg = this.getRemoteConfig ? this.getRemoteConfig() : null;
      if (cfg && cfg.gatewayUrl) base = cfg.gatewayUrl.replace(/\/+$/, '');
      if (cfg && cfg.directIp !== undefined && cfg.directIp !== '') directIp = cfg.directIp || null;
    } catch {}
    return { base, directIp };
  }

  currentVersion() {
    // 不走 require 缓存：更新覆盖后要能读到新值；strip BOM（PS5.1 写过的文件可能带）
    const raw = fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw).version;
  }

  async check() {
    const { base, directIp } = this._source();
    const raw = await _httpGet(`${base}/hub-update/manifest.json`, { directIp, timeoutMs: 15000 });
    const manifest = JSON.parse(raw);
    const current = this.currentVersion();
    const updateAvailable = cmpVersion(manifest.version, current) > 0;
    // 安装版本低于 minFullVersion → 依赖有变化，源码热更不够，需要完整包
    const needsFullPackage = manifest.minFullVersion
      ? cmpVersion(manifest.minFullVersion, current) > 0
      : false;
    this.lastCheck = {
      current,
      latest: manifest.version,
      updateAvailable,
      needsFullPackage,
      notes: manifest.notes || '',
      zip: manifest.zip,
      sha256: manifest.sha256,
    };
    this.logger.log(`[self-update] current=${current} latest=${manifest.version} update=${updateAvailable} full=${needsFullPackage}`);
    return this.lastCheck;
  }

  async apply() {
    if (!this.lastCheck) await this.check();
    const info = this.lastCheck;
    if (!info.updateAvailable) return { ok: false, error: '已是最新版本' };
    if (info.needsFullPackage) return { ok: false, error: '此次更新含依赖变更，需重新下载完整便携包' };

    const { base, directIp } = this._source();
    this.logger.log(`[self-update] downloading ${info.zip}…`);
    const buf = await _httpGet(`${base}/hub-update/${info.zip}`, { directIp, asBuffer: true, timeoutMs: 120000 });

    const gotSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (info.sha256 && gotSha.toLowerCase() !== String(info.sha256).toLowerCase()) {
      return { ok: false, error: `sha256 校验失败（got ${gotSha.slice(0, 12)}…）` };
    }

    const tmpZip = path.join(os.tmpdir(), `hub-update-${info.latest}-${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, buf);

    // Windows 10+ 自带 bsdtar；源码文件无强制锁，运行中覆盖安全
    //（electron.exe / *.node 在 node_modules，更新包不含 node_modules）
    const r = spawnSync('tar', ['-xf', tmpZip, '-C', this.appRoot], { encoding: 'utf8', timeout: 120000 });
    try { fs.unlinkSync(tmpZip); } catch {}
    if (r.status !== 0) {
      return { ok: false, error: `解压失败: ${(r.stderr || r.error && r.error.message || '').slice(0, 200)}` };
    }

    const newVersion = this.currentVersion();
    this.logger.log(`[self-update] applied ${info.latest}, on-disk version now ${newVersion}, relaunching…`);
    return { ok: true, version: newVersion };
  }

  relaunch() {
    try {
      const { app } = require('electron');
      app.relaunch();
      app.exit(0);
    } catch (e) {
      this.logger.error(`[self-update] relaunch failed: ${e.message}`);
    }
  }
}

module.exports = { SelfUpdater, cmpVersion };
