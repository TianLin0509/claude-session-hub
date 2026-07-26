'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SAFE_ID = /^[A-Za-z0-9._-]{8,160}$/;
const LEASE_TTL_MS = 2 * 60 * 1000;

function defaultRoot(env = process.env) {
  return env.CHUXIN_GLOBAL_SESSION_DIR
    || path.join(os.homedir(), '.claude-session-hub', 'chuxin-research-sessions');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(temp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code)) break;
      const until = Date.now() + (20 * (attempt + 1));
      while (Date.now() < until) { /* bounded Windows rename backoff */ }
    }
  }
  try { fs.unlinkSync(temp); } catch {}
  throw lastError || new Error('atomic write failed');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

class ChuxinSessionRegistry {
  constructor(options = {}) {
    this.root = path.resolve(options.root || defaultRoot(options.env || process.env));
    this.sessionsDir = path.join(this.root, 'sessions');
    this.leasesDir = path.join(this.root, 'leases');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.leasesDir, { recursive: true });
  }

  createId() {
    return `research-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  }

  _assertId(id) {
    const value = String(id || '');
    if (!SAFE_ID.test(value)) throw new Error('invalid research session id');
    return value;
  }

  _sessionPath(id) {
    return path.join(this.sessionsDir, `${this._assertId(id)}.json`);
  }

  _leasePath(id) {
    return path.join(this.leasesDir, `${this._assertId(id)}.lock`);
  }

  get(id) {
    return readJson(this._sessionPath(id));
  }

  list() {
    const rows = [];
    for (const entry of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const row = readJson(path.join(this.sessionsDir, entry.name));
      if (row && SAFE_ID.test(String(row.researchSessionId || ''))) rows.push(row);
    }
    return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  upsert(id, patch = {}) {
    const researchSessionId = this._assertId(id);
    const previous = this.get(researchSessionId) || {};
    const now = Date.now();
    const next = {
      schemaVersion: 1,
      createdAt: previous.createdAt || now,
      ...previous,
      ...patch,
      researchSessionId,
      updatedAt: now,
    };
    atomicWriteJson(this._sessionPath(researchSessionId), next);
    return next;
  }

  claim(id, owner = {}) {
    const researchSessionId = this._assertId(id);
    const leasePath = this._leasePath(researchSessionId);
    const token = crypto.randomBytes(12).toString('hex');
    const payload = {
      researchSessionId,
      token,
      ownerPid: process.pid,
      ownerHub: String(owner.ownerHub || ''),
      acquiredAt: Date.now(),
    };
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const fd = fs.openSync(leasePath, 'wx');
        fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
        fs.closeSync(fd);
        return { ok: true, token, lease: payload };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        const existing = readJson(leasePath) || {};
        let age = Date.now() - Number(existing.renewedAt || existing.acquiredAt || 0);
        try { age = Math.min(age, Date.now() - fs.statSync(leasePath).mtimeMs); } catch {}
        if (pass === 0 && age > LEASE_TTL_MS) {
          try { fs.unlinkSync(leasePath); } catch {}
          continue;
        }
        return { ok: false, reason: 'busy', lease: existing };
      }
    }
    return { ok: false, reason: 'busy' };
  }

  lease(id) {
    const leasePath = this._leasePath(id);
    const existing = readJson(leasePath);
    if (!existing) return null;
    let age = Date.now() - Number(existing.renewedAt || existing.acquiredAt || 0);
    try { age = Math.min(age, Date.now() - fs.statSync(leasePath).mtimeMs); } catch {}
    if (age <= LEASE_TTL_MS) return { ...existing, ageMs: Math.max(0, age) };
    try { fs.unlinkSync(leasePath); } catch {}
    return null;
  }

  release(id, token) {
    const leasePath = this._leasePath(id);
    const existing = readJson(leasePath);
    if (!existing || existing.token !== token) return false;
    try {
      fs.unlinkSync(leasePath);
      return true;
    } catch {
      return false;
    }
  }

  renew(id, token) {
    const leasePath = this._leasePath(id);
    const existing = readJson(leasePath);
    if (!existing || existing.token !== token) return false;
    try {
      fs.writeFileSync(leasePath, JSON.stringify({ ...existing, renewedAt: Date.now() }), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  ChuxinSessionRegistry,
  atomicWriteJson,
  defaultRoot,
};
