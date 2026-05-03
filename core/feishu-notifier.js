'use strict';

const fs = require('fs');

function truncatePreview(text, max = 200) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function formatTimestamp(t) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function buildNotifyCard(payload) {
  const isWaiting = !!payload.isWaiting;
  const statusLine = isWaiting ? '⏸ 等你回复' : '✅ 一轮完成';
  const bodyText = isWaiting
    ? truncatePreview(payload.waitingText || payload.preview || '')
    : truncatePreview(payload.preview || '');
  const time = formatTimestamp(payload.timestamp || Date.now());
  const title = payload.title || '';
  const md = [
    `**Hub 提醒 · ${title}**`,
    '',
    `**状态：${statusLine}**`,
    '',
    bodyText || '（无内容）',
    '',
    `— Hub @ ${time}`,
  ].join('\n');

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: isWaiting ? 'orange' : 'wathet',
      title: { tag: 'plain_text', content: `Hub 提醒 · ${title}` },
    },
    body: {
      elements: [
        { tag: 'markdown', content: md },
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
    if (this.chatId === '') {
      this._writeDryRun(payload, t);
      this._lastSentAt.set(payload.sessionId, t);
      return { sent: true, reason: 'dryrun' };
    }
    return this._send(payload, t);
  }

  _writeDryRun(payload, t) {
    if (!this.dryRunLogPath) return;
    const card = buildNotifyCard(payload);
    const line = JSON.stringify({ t, payload, card }) + '\n';
    try {
      fs.appendFileSync(this.dryRunLogPath, line, 'utf8');
    } catch (err) {
      this._lastError = { time: t, message: 'dryrun log failed: ' + err.message };
    }
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
