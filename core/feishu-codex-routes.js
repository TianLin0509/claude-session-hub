'use strict';

const express = require('express');

function createFeishuCodexRouter({ gateway, token }) {
  if (!gateway) throw new Error('gateway is required');
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.post('/events', async (req, res) => {
    if (token) {
      const got = req.headers['x-hub-feishu-token'] || req.query.token;
      if (got !== token) return res.status(401).json({ ok: false, error: 'bad-token' });
    }
    const evt = normalizeEvent(req.body || {});
    const result = await gateway.handleIncoming(evt);
    res.json(result);
  });

  return r;
}

function normalizeEvent(body) {
  const event = body.event || body;
  const message = event.message || body.message || {};
  const sender = event.sender || body.sender || {};
  const text = pickText(message, event, body);
  return {
    chatId: message.chat_id || event.chat_id || body.chatId || body.chat_id,
    threadId: message.thread_id || event.thread_id || body.threadId || body.thread_id,
    messageId: message.message_id || event.message_id || body.messageId || body.message_id,
    senderId: sender.sender_id?.open_id || sender.open_id || event.senderId || body.senderId,
    text,
    cwd: body.cwd || event.cwd,
    raw: body,
  };
}

function pickText(message, event, body) {
  if (typeof body.text === 'string') return body.text;
  if (typeof event.text === 'string') return event.text;
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content);
      if (typeof parsed.text === 'string') return parsed.text;
      if (Array.isArray(parsed.text)) return parsed.text.map(part => part.text || '').join('');
    } catch {
      return message.content;
    }
  }
  return '';
}

module.exports = {
  createFeishuCodexRouter,
  normalizeEvent,
};
