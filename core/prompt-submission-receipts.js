'use strict';
const { createHash } = require('node:crypto');

function promptFingerprint(text) {
  return createHash('sha256').update(String(text || '').replace(/\r\n?/g, '\n').trim()).digest('hex');
}

// Delivery receipts share provider events with RuntimeTruth, but must identify
// the submitted message. Running/automatic continuation alone cannot do that.
class PromptSubmissionReceipts {
  constructor(onUpdate = () => {}) {
    this.entries = new Map();
    this.seen = new Map();
    this.unresolved = new Map();
    this.onUpdate = onUpdate;
  }

  begin(sessionId, clientSubmissionId, text, dispatchedAt = Date.now()) {
    const receipt = {
      sessionId, clientSubmissionId, dispatchedAt,
      fingerprint: promptFingerprint(text), status: 'pending', acknowledgement: null,
      get started() { return this.status === 'confirmed'; },
      dispose() {}, // owned by the IPC registration, survives sendToPty timeout
    };
    this.entries.set(sessionId, receipt);
    const pending = this.unresolved.get(sessionId) || [];
    pending.push(receipt);
    this.unresolved.set(sessionId, pending);
    return receipt;
  }

  get(sessionId) { return this.entries.get(sessionId) || null; }

  snapshot(receipt) {
    return {
      sessionId: receipt.sessionId, clientSubmissionId: receipt.clientSubmissionId,
      status: receipt.status, acknowledgementSource: receipt.acknowledgement?.source || null,
      turnId: receipt.acknowledgement?.turnId || null,
    };
  }

  finish(receipt, result) {
    if (this.get(receipt.sessionId) !== receipt || receipt.started) return;
    // A generic PTY/activity success cannot identify this particular message.
    receipt.status = result?.ok === false ? 'failed' : 'unconfirmed';
    this.onUpdate(this.snapshot(receipt));
  }

  observe(event = {}) {
    if (event.signalSource && !['user_message', 'item_completed_user_message',
      'claude-user-prompt-submit', 'prompt-submitted'].includes(event.signalSource)) return false;
    const sessionId = event.sessionId || event.hubSessionId;
    if (!this.get(sessionId) || typeof event.text !== 'string' || !event.text.trim()) return false;
    const submittedAt = Number(event.submittedAt || event.observedAt);
    if (!Number.isFinite(submittedAt)) return false;
    const fingerprint = promptFingerprint(event.text);
    // Claude hooks can be timestamped on arrival. Repeated "continue" sends
    // must consume the oldest unresolved matching attempt, never the newest.
    const pending = this.unresolved.get(sessionId) || [];
    const receipt = pending.find(item => item.fingerprint === fingerprint && submittedAt >= item.dispatchedAt);
    if (!receipt) return false;
    const key = `${event.turnId || submittedAt}:${fingerprint}`;
    const seen = this.seen.get(sessionId) || new Set();
    if (seen.has(key)) return false;
    seen.add(key);
    this.seen.set(sessionId, seen);
    if (fingerprint !== receipt.fingerprint || receipt.started) return false;
    receipt.status = 'confirmed';
    receipt.acknowledgement = {
      source: event.signalSource || 'prompt-submitted', observedAt: submittedAt,
      turnId: event.turnId || null,
    };
    this.unresolved.set(sessionId, pending.filter(item => item !== receipt));
    this.onUpdate(this.snapshot(receipt));
    return true;
  }

  prune(sessionExists) {
    for (const sid of this.entries.keys()) {
      if (sessionExists(sid)) continue;
      this.entries.delete(sid);
      this.seen.delete(sid);
      this.unresolved.delete(sid);
    }
  }
}

module.exports = { PromptSubmissionReceipts, promptFingerprint };
