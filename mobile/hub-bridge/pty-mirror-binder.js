'use strict';

const { MSG } = require('../shared/protocol');

const MAX_REPLAY_FRAMES = 800;
const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

function encodeUtf8(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function decodeUtf8B64(value) {
  if (!value) return '';
  return Buffer.from(String(value), 'base64').toString('utf8');
}

class PtyMirrorBinder {
  constructor({ sessionManager, outbound, logger = console }) {
    this.sessionManager = sessionManager;
    this.outbound = outbound;
    this.logger = logger;
    this.subscribersBySession = new Map(); // sessionId -> Set<deviceToken>
    this.sessionsByDevice = new Map();     // deviceToken -> Set<sessionId>
    this.framesBySession = new Map();      // sessionId -> [{ seq, data, bytes, ts }]
    this.seqBySession = new Map();
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    if (this.sessionManager && typeof this.sessionManager.on === 'function') {
      this.sessionManager.on('output', (ev) => this._handleOutput(ev));
    }
  }

  handleSubscribe(msg = {}) {
    const deviceToken = msg.deviceToken;
    const sessionId = msg.sessionId || msg.targetId;
    if (!deviceToken || !sessionId) {
      this._ack(deviceToken, sessionId, 'subscribe', false, 'missing_session');
      return;
    }
    const session = this.sessionManager && this.sessionManager.getSession && this.sessionManager.getSession(sessionId);
    if (!session) {
      this._ack(deviceToken, sessionId, 'subscribe', false, 'session_not_found');
      return;
    }
    if (!this.subscribersBySession.has(sessionId)) this.subscribersBySession.set(sessionId, new Set());
    if (!this.sessionsByDevice.has(deviceToken)) this.sessionsByDevice.set(deviceToken, new Set());
    this.subscribersBySession.get(sessionId).add(deviceToken);
    this.sessionsByDevice.get(deviceToken).add(sessionId);

    this._ack(deviceToken, sessionId, 'subscribe', true);
    this._sendSnapshot(deviceToken, sessionId, msg.sinceSeq || 0);
  }

  handleUnsubscribe(msg = {}) {
    this._removeSubscription(msg.deviceToken, msg.sessionId || msg.targetId);
    this._ack(msg.deviceToken, msg.sessionId || msg.targetId, 'unsubscribe', true);
  }

  unsubscribeDevice(deviceToken) {
    const sessions = this.sessionsByDevice.get(deviceToken);
    if (!sessions) return;
    for (const sessionId of sessions) this._removeSubscription(deviceToken, sessionId);
    this.sessionsByDevice.delete(deviceToken);
  }

  handleInput(msg = {}) {
    const sessionId = msg.sessionId || msg.targetId;
    if (!sessionId) {
      this._ack(msg.deviceToken, sessionId, 'input', false, 'missing_session');
      return;
    }
    const session = this.sessionManager && this.sessionManager.getSession && this.sessionManager.getSession(sessionId);
    if (!session) {
      this._ack(msg.deviceToken, sessionId, 'input', false, 'session_not_found');
      return;
    }
    let data = typeof msg.data === 'string' ? msg.data : decodeUtf8B64(msg.dataB64);
    if (data.length > 8192) data = data.slice(0, 8192);
    try {
      this.sessionManager.writeToSession(sessionId, data);
      this._ack(msg.deviceToken, sessionId, 'input', true);
    } catch (e) {
      this.logger.warn(`[pty-mirror] input failed for ${sessionId}: ${e.message}`);
      this._ack(msg.deviceToken, sessionId, 'input', false, e.message);
    }
  }

  handleResize(msg = {}) {
    const sessionId = msg.sessionId || msg.targetId;
    const cols = Math.max(20, Math.min(240, Number(msg.cols) || 80));
    const rows = Math.max(6, Math.min(80, Number(msg.rows) || 24));
    try {
      if (this.sessionManager && typeof this.sessionManager.resizeSession === 'function') {
        this.sessionManager.resizeSession(sessionId, cols, rows);
      }
      this._ack(msg.deviceToken, sessionId, 'resize', true);
    } catch (e) {
      this._ack(msg.deviceToken, sessionId, 'resize', false, e.message);
    }
  }

  _handleOutput(ev = {}) {
    const sessionId = ev.sessionId;
    if (!sessionId || typeof ev.data !== 'string') return;
    const seq = Number(ev.seq) || ((this.seqBySession.get(sessionId) || 0) + 1);
    this.seqBySession.set(sessionId, Math.max(this.seqBySession.get(sessionId) || 0, seq));
    this._rememberFrame(sessionId, seq, ev.data);

    const subs = this.subscribersBySession.get(sessionId);
    if (!subs || subs.size === 0) return;
    const msg = {
      type: MSG.PTY_DATA,
      sessionId,
      seq,
      dataB64: encodeUtf8(ev.data),
    };
    for (const deviceToken of subs) {
      this.outbound.send({ ...msg, deviceToken });
    }
  }

  _sendSnapshot(deviceToken, sessionId, sinceSeq) {
    const frames = this.framesBySession.get(sessionId) || [];
    const currentSeq = this.seqBySession.get(sessionId) || (frames.length ? frames[frames.length - 1].seq : 0);
    const replay = sinceSeq ? frames.filter(f => f.seq > sinceSeq) : [];
    if (replay.length > 0) {
      for (const f of replay) {
        this.outbound.send({
          type: MSG.PTY_DATA,
          deviceToken,
          sessionId,
          seq: f.seq,
          dataB64: encodeUtf8(f.data),
        });
      }
      return;
    }

    let data = '';
    try {
      data = this.sessionManager.getSessionBuffer(sessionId) || '';
    } catch {}
    let truncated = false;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > MAX_SNAPSHOT_BYTES) {
      const buf = Buffer.from(data, 'utf8');
      data = buf.slice(buf.length - MAX_SNAPSHOT_BYTES).toString('utf8');
      truncated = true;
    }
    this.outbound.send({
      type: MSG.PTY_SNAPSHOT,
      deviceToken,
      sessionId,
      seq: currentSeq,
      dataB64: encodeUtf8(data),
      truncated,
    });
  }

  _rememberFrame(sessionId, seq, data) {
    if (!this.framesBySession.has(sessionId)) this.framesBySession.set(sessionId, []);
    const frames = this.framesBySession.get(sessionId);
    frames.push({ seq, data, bytes: Buffer.byteLength(data, 'utf8'), ts: Date.now() });
    let total = frames.reduce((sum, f) => sum + f.bytes, 0);
    while (frames.length > MAX_REPLAY_FRAMES || total > MAX_REPLAY_BYTES) {
      const f = frames.shift();
      total -= f ? f.bytes : 0;
    }
  }

  _removeSubscription(deviceToken, sessionId) {
    if (!deviceToken || !sessionId) return;
    const subs = this.subscribersBySession.get(sessionId);
    if (subs) {
      subs.delete(deviceToken);
      if (subs.size === 0) this.subscribersBySession.delete(sessionId);
    }
    const sessions = this.sessionsByDevice.get(deviceToken);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.sessionsByDevice.delete(deviceToken);
    }
  }

  _ack(deviceToken, sessionId, action, ok, error) {
    if (!deviceToken) return;
    this.outbound.send({
      type: MSG.PTY_ACK,
      deviceToken,
      sessionId,
      action,
      ok: !!ok,
      error: error || null,
    });
  }
}

module.exports = { PtyMirrorBinder };
