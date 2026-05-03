'use strict';

function buildNotifyCard(payload) {
  // 占位实现，Task 6 会扩展
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown', content: `Hub 提醒 · ${payload.title || ''}` },
      ],
    },
  };
}

class FeishuNotifier {
  constructor({ client, chatId, dedupeWindowMs = 60_000, dryRunLogPath = null, logger = console, now = () => Date.now() } = {}) {
    if (!client) throw new Error('FeishuNotifier: client is required');
    if (chatId === undefined || chatId === null) throw new Error('FeishuNotifier: chatId is required');
    this.client = client;
    this.chatId = chatId;
    this.dedupeWindowMs = dedupeWindowMs;
    this.dryRunLogPath = dryRunLogPath;
    this.logger = logger;
    this.now = now;
    this._lastSentAt = new Map();
    this._lastError = null;
  }

  get lastError() { return this._lastError; }

  async notify(payload) {
    if (!payload || !payload.sessionId) {
      return { sent: false, reason: 'invalid' };
    }
    const t = this.now();
    if (!payload.newlyWaiting) {
      const last = this._lastSentAt.get(payload.sessionId) || 0;
      if (t - last < this.dedupeWindowMs) {
        return { sent: false, reason: 'deduped' };
      }
    }
    return this._send(payload, t);
  }

  async _send(payload, t) {
    const card = buildNotifyCard(payload);
    try {
      await this.client.sendCard({ chatId: this.chatId, card });
      this._lastSentAt.set(payload.sessionId, t);
      return { sent: true, reason: 'sent' };
    } catch (err) {
      this._lastError = { time: t, message: err.message };
      this.logger.warn && this.logger.warn('[feishu-notify] send failed:', err.message);
      return { sent: false, reason: 'error' };
    }
  }
}

module.exports = { FeishuNotifier, buildNotifyCard };
