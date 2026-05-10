'use strict';

function resolveDomain(Lark, domain) {
  if (!domain || domain === 'feishu') return Lark.Domain.Feishu;
  if (domain === 'lark') return Lark.Domain.Lark;
  return String(domain).replace(/\/+$/, '');
}

function extractTextContent(message) {
  if (!message) return '';
  if (message.message_type && message.message_type !== 'text') return '';
  const raw = message.content;
  if (!raw) return '';
  if (typeof raw !== 'string') return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.text === 'string') return parsed.text;
    if (Array.isArray(parsed.text)) {
      return parsed.text.map(part => part && part.text || '').join('');
    }
  } catch {
    return raw;
  }
  return '';
}

function normalizeMessageEvent(data) {
  const message = data && data.message || {};
  const sender = data && data.sender || {};
  return {
    chatId: message.chat_id || null,
    threadId: message.root_id || message.parent_id || message.thread_id || message.message_id || null,
    messageId: message.message_id || null,
    senderId: sender.sender_id && (sender.sender_id.open_id || sender.sender_id.user_id || sender.sender_id.union_id) || null,
    senderType: sender.sender_type || null,
    text: extractTextContent(message),
    raw: data,
  };
}

function shouldIgnoreEvent(evt, { botOpenId = null } = {}) {
  if (!evt) return true;
  if (!evt.text || !evt.text.trim()) return true;
  if (evt.senderType === 'app') return true;
  if (botOpenId && evt.senderId === botOpenId) return true;
  return false;
}

class FeishuWsReceiver {
  constructor({
    appId,
    appSecret,
    domain = 'feishu',
    gateway,
    logger = console,
    lark = null,
    botOpenId = null,
  }) {
    if (!appId) throw new Error('Feishu appId is required');
    if (!appSecret) throw new Error('Feishu appSecret is required');
    if (!gateway) throw new Error('gateway is required');
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.gateway = gateway;
    this.logger = logger || console;
    this.Lark = lark || require('@larksuiteoapi/node-sdk');
    this.botOpenId = botOpenId;
    this.wsClient = null;
    this.eventDispatcher = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    const Lark = this.Lark;
    this.eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const evt = normalizeMessageEvent(data);
        if (shouldIgnoreEvent(evt, { botOpenId: this.botOpenId })) return;
        try {
          await this.gateway.handleIncoming(evt);
        } catch (err) {
          if (this.logger && typeof this.logger.warn === 'function') {
            this.logger.warn('[feishu-ws] failed to handle message:', err.message || String(err));
          }
        }
      },
    });
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: resolveDomain(Lark, this.domain),
      loggerLevel: Lark.LoggerLevel ? Lark.LoggerLevel.info : undefined,
      onReady: () => {
        if (this.logger && typeof this.logger.log === 'function') {
          this.logger.log('[feishu-ws] connected');
        }
      },
      onError: (err) => {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('[feishu-ws] error:', err && (err.message || String(err)));
        }
      },
    });
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.started = true;
  }
}

module.exports = {
  FeishuWsReceiver,
  normalizeMessageEvent,
  extractTextContent,
  shouldIgnoreEvent,
  resolveDomain,
};
